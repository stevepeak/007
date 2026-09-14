import { describe, expect, test } from 'bun:test'

import {
  ConnectorCryptoError,
  decryptSecret,
  encryptSecret,
  isEncrypted,
} from './crypto'

const KEY = 'test-key-do-not-use-in-prod'

describe('connector secret envelope', () => {
  test('round-trips a token', async () => {
    const token = 'lin_oauth_abc123'
    const stored = await encryptSecret(token, KEY)
    expect(await decryptSecret(stored, KEY)).toBe(token)
  })

  // The whole point of the envelope: the plaintext must not be recoverable by
  // reading the column. A substring check is cruder than it looks — it is
  // exactly what a leaked DB dump would be grepped for.
  test('the stored form contains no trace of the plaintext', async () => {
    const token = 'lin_oauth_abc123'
    const stored = await encryptSecret(token, KEY)
    expect(stored).not.toContain(token)
    expect(stored).not.toContain('lin_oauth')
    expect(isEncrypted(stored)).toBe(true)
  })

  // Same input twice must not produce the same ciphertext, or a dump leaks
  // which connectors share a token and when one stopped changing.
  test('encrypts with a fresh IV each time', async () => {
    const a = await encryptSecret('same', KEY)
    const b = await encryptSecret('same', KEY)
    expect(a).not.toBe(b)
    expect(await decryptSecret(a, KEY)).toBe(await decryptSecret(b, KEY))
  })

  test('a wrong key fails loudly rather than returning garbage', async () => {
    const stored = await encryptSecret('secret', KEY)
    await expect(decryptSecret(stored, 'a-different-key')).rejects.toThrow(
      ConnectorCryptoError,
    )
  })

  // GCM authenticates the ciphertext, so a flipped byte must be caught rather
  // than decrypted into rubbish that then gets sent to a server as a token.
  test('detects tampering', async () => {
    const stored = await encryptSecret('secret', KEY)
    const [v, iv, ct] = stored.split('.')
    const flipped = `${v}.${iv}.${ct.startsWith('A') ? 'B' : 'A'}${ct.slice(1)}`
    await expect(decryptSecret(flipped, KEY)).rejects.toThrow(
      ConnectorCryptoError,
    )
  })

  test('rejects a value that is not an envelope', async () => {
    await expect(decryptSecret('plain-token', KEY)).rejects.toThrow(
      ConnectorCryptoError,
    )
    expect(isEncrypted('plain-token')).toBe(false)
    expect(isEncrypted('')).toBe(false)
    expect(isEncrypted(null)).toBe(false)
  })

  // An unconfigured key is a setup mistake, and the message has to say what to
  // do about it — this is the first thing anyone hits wiring the feature up.
  test('names the missing host wiring when no key is configured', async () => {
    await expect(encryptSecret('x', '')).rejects.toThrow(/WF_CONNECTOR_KEY/)
  })

  test('survives unicode and long tokens', async () => {
    const token = `${'x'.repeat(4096)}·café·🔐`
    expect(await decryptSecret(await encryptSecret(token, KEY), KEY)).toBe(token)
  })
})
