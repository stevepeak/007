/** Lowercase hex of `bytes`, two characters per byte. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Hex SHA-256 of `text`'s UTF-8 bytes. `bytes` keeps only the first that many
 * digest bytes (so twice as many hex chars); omitted, all 32.
 */
export async function sha256Hex(args: {
  text: string
  bytes?: number
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(args.text),
  )
  return bytesToHex(new Uint8Array(digest).slice(0, args.bytes))
}
