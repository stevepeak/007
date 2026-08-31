import { describe, expect, test } from 'bun:test'

import { resolveWfMcpConfig } from './config'

/**
 * `wf-mcp` is configured by an MCP client's JSON block, which can only pass an
 * env map and argv — so these two are the entire interface, and the cases that
 * matter are the ones where a host gets it slightly wrong.
 */

const ENV = { WF_BASE_URL: 'http://localhost:3000', WF_MCP_TOKEN: 'tok' }

describe('resolveWfMcpConfig', () => {
  test('appends the default route path to an origin', () => {
    expect(resolveWfMcpConfig([], ENV).apiUrl).toBe(
      'http://localhost:3000/api/wf',
    )
  })

  test('accepts a full data-API URL without doubling the path', () => {
    const config = resolveWfMcpConfig([], {
      ...ENV,
      WF_BASE_URL: 'https://app.example.com/api/wf',
    })
    expect(config.apiUrl).toBe('https://app.example.com/api/wf')
  })

  test('tolerates a trailing slash on the origin', () => {
    const config = resolveWfMcpConfig([], {
      ...ENV,
      WF_BASE_URL: 'https://app.example.com/',
    })
    expect(config.apiUrl).toBe('https://app.example.com/api/wf')
  })

  test('honours a host that mounts the handlers elsewhere', () => {
    const config = resolveWfMcpConfig([], { ...ENV, WF_API_PATH: '/wf-data' })
    expect(config.apiUrl).toBe('http://localhost:3000/wf-data')
  })

  test('flags win over env', () => {
    const config = resolveWfMcpConfig(
      ['--base-url=https://other.example.com', '--token=flagtok'],
      ENV,
    )
    expect(config.apiUrl).toBe('https://other.example.com/api/wf')
    expect(config.token).toBe('flagtok')
  })

  // The whole point of the gate: nothing turns writes on implicitly.
  test('is read-only unless --write is passed', () => {
    expect(resolveWfMcpConfig([], ENV).write).toBe(false)
    expect(resolveWfMcpConfig(['--write'], ENV).write).toBe(true)
  })

  test('defaults the per-call budget well past the UI backstop', () => {
    expect(resolveWfMcpConfig([], ENV).timeoutMs).toBe(120_000)
  })

  test.each([['0'], ['-5'], ['not-a-number']])(
    'ignores a nonsense timeout (%s)',
    (raw) => {
      expect(
        resolveWfMcpConfig([], { ...ENV, WF_MCP_TIMEOUT_MS: raw }).timeoutMs,
      ).toBe(120_000)
    },
  )

  test('reads a valid timeout override', () => {
    expect(
      resolveWfMcpConfig([], { ...ENV, WF_MCP_TIMEOUT_MS: '5000' }).timeoutMs,
    ).toBe(5000)
  })

  // Failing at startup beats failing on every tool call with a 403 whose cause
  // is nowhere near the message.
  test('refuses to start without a target', () => {
    expect(() => resolveWfMcpConfig([], { WF_MCP_TOKEN: 'tok' })).toThrow(
      /WF_BASE_URL/,
    )
  })

  test('refuses to start without a credential', () => {
    expect(() =>
      resolveWfMcpConfig([], { WF_BASE_URL: 'http://localhost:3000' }),
    ).toThrow(/WF_MCP_TOKEN/)
  })
})
