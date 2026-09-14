// Envelope encryption for connector credentials.
//
// Connector tokens are the one secret the SDK stores itself (see the header of
// `../storage/schema-connectors`), so they are encrypted at rest with a key the
// host injects and the database never sees. AES-256-GCM via WebCrypto: available
// on workerd, in Node, and in bun, with no dependency and no Node-only API.
//
// The stored form is a single self-describing string:
//
//     wfc1.<base64url iv>.<base64url ciphertext+tag>
//
// The version prefix is what makes key rotation possible later without guessing
// at what a column contains, and it is what `isEncrypted` recognises — which in
// turn is what lets the "no plaintext token was ever persisted" test be a real
// assertion rather than a hopeful one.

const VERSION = 'wfc1'
const IV_BYTES = 12 // 96 bits — the GCM standard, and what WebCrypto expects.

/** Thrown when a connector secret can't be decrypted with the configured key. */
export class ConnectorCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectorCryptoError'
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Annotated over `ArrayBuffer` rather than the default `ArrayBufferLike`, which
// no longer satisfies WebCrypto's `BufferSource`.
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Derive the AES key from the host's secret.
 *
 * SHA-256 of the raw secret, so the host is free to supply any string — a
 * `openssl rand -base64 32`, a passphrase — without the SDK imposing a format
 * or silently truncating. It is NOT a password-stretching KDF and isn't meant to
 * be: this protects a high-entropy machine secret held in Worker secrets, not a
 * human-chosen password.
 */
async function deriveKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new ConnectorCryptoError(
      'No connector encryption key configured. Wire `resolveConnectorSecret` ' +
        '(host env `WF_CONNECTOR_KEY`) before connecting a connector.',
    )
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  )
  return await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** Encrypt a connector secret for storage. */
export async function encryptSecret(
  plaintext: string,
  secret: string,
): Promise<string> {
  const key = await deriveKey(secret)
  // Filled in place rather than assigned from the return value: the latter is
  // typed over `ArrayBufferLike`, which no longer satisfies `BufferSource`.
  const iv = new Uint8Array(IV_BYTES)
  crypto.getRandomValues(iv)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`
}

/** Decrypt a stored connector secret. Throws if the key or payload is wrong. */
export async function decryptSecret(
  stored: string,
  secret: string,
): Promise<string> {
  const parts = stored.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new ConnectorCryptoError(
      'Stored connector secret is not in the expected envelope format.',
    )
  }
  const key = await deriveKey(secret)
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(parts[1]) },
      key,
      fromBase64Url(parts[2]),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    // Deliberately opaque: GCM cannot distinguish "wrong key" from "tampered
    // payload", and guessing between them in an error message would be a lie.
    throw new ConnectorCryptoError(
      'Could not decrypt a connector secret — the encryption key has changed, ' +
        'or the stored value is corrupt. Reconnect the connector.',
    )
  }
}

/**
 * Whether a value is in the stored envelope form.
 *
 * Used by the guard test that walks every secret column and asserts nothing
 * plaintext ever landed there. Cheap enough to also use as a defensive check
 * before a write.
 */
export function isEncrypted(value: string | null | undefined): boolean {
  if (!value) return false
  const parts = value.split('.')
  return parts.length === 3 && parts[0] === VERSION && parts[1].length > 0
}
