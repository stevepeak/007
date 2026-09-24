import { describe, expect, test } from 'bun:test'

import { isLocalOrigin, resolveTarget } from './target'

// The page can only ever know ONE of its two targets: the deployment serving
// it. Getting that backwards is not a cosmetic bug — it presents a placeholder
// hostname as though it were real, and the reader finds out by pasting it into
// a client config and getting a connection error with nothing to attach it to.

describe('isLocalOrigin', () => {
  test.each([
    'http://localhost:3000',
    'http://localhost',
    'https://127.0.0.1:8788',
    'http://[::1]:3000',
  ])('%s is local', (origin) => {
    expect(isLocalOrigin(origin)).toBe(true)
  })

  test.each([
    'https://app.example.com',
    'https://my-app.workers.dev',
    // The giveaway is the HOST, not the substring: a deployed host that merely
    // contains the word must not be mistaken for a dev server.
    'https://localhost.example.com',
    'https://staging-localhost.fly.dev',
  ])('%s is not local', (origin) => {
    expect(isLocalOrigin(origin)).toBe(false)
  })
})

describe('resolveTarget', () => {
  test('read on a dev server: development is real, production is a placeholder', () => {
    const origin = 'http://localhost:3000'
    expect(resolveTarget('development', origin)).toEqual({
      url: origin,
      known: true,
    })
    expect(resolveTarget('production', origin).known).toBe(false)
  })

  // The reciprocal, and the case the picker was added for: someone reading the
  // console on production should be handed their real origin, not a stand-in.
  test('read on a deployment: production is real, development is a placeholder', () => {
    const origin = 'https://app.example.com'
    expect(resolveTarget('production', origin)).toEqual({
      url: origin,
      known: true,
    })
    expect(resolveTarget('development', origin).known).toBe(false)
  })

  test('a placeholder never resolves to a real host', () => {
    const dev = resolveTarget('development', 'https://app.example.com')
    const prod = resolveTarget('production', 'http://localhost:3000')
    expect(dev.url).toBe('http://localhost:3000')
    // RFC 2606 reserves example.com, so this cannot be anyone's deployment.
    expect(new URL(prod.url).hostname.endsWith('example.com')).toBe(true)
  })

  test('exactly one of the two targets is ever known', () => {
    for (const origin of ['http://localhost:3000', 'https://app.example.com']) {
      const known = (['development', 'production'] as const).filter(
        (t) => resolveTarget(t, origin).known,
      )
      expect(known).toHaveLength(1)
    }
  })
})
