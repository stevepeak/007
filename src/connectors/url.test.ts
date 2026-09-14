import { describe, expect, test } from 'bun:test'

import {
  assertConnectorUrl,
  ConnectorUrlError,
  connectorUrlProblem,
} from './url'

describe('connector URL validation', () => {
  test('accepts a public https endpoint', () => {
    expect(assertConnectorUrl('https://mcp.linear.app/mcp')).toBe(
      'https://mcp.linear.app/mcp',
    )
    expect(connectorUrlProblem('https://mcp.linear.app/mcp')).toBeNull()
  })

  // Credentials ride on every call; plaintext is not a preference.
  test('rejects plain http', () => {
    expect(() => assertConnectorUrl('http://mcp.linear.app/mcp')).toThrow(
      ConnectorUrlError,
    )
    expect(connectorUrlProblem('http://mcp.example.com')).toMatch(/https/)
  })

  // The SSRF case. `global_fetch_strictly_public` covers this in production but
  // is NOT enforced under wrangler dev, so without this check a bad URL would
  // pass every local test and fail only after deploy.
  test('rejects loopback and private ranges', () => {
    const blocked = [
      'https://localhost/mcp',
      'https://127.0.0.1/mcp',
      'https://127.1.2.3/mcp',
      'https://10.0.0.5/mcp',
      'https://192.168.1.1/mcp',
      'https://172.16.0.1/mcp',
      'https://172.31.255.255/mcp',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/mcp',
      'https://metadata.google.internal/mcp',
    ]
    for (const url of blocked) {
      expect(() => assertConnectorUrl(url)).toThrow(ConnectorUrlError)
    }
  })

  // 172.16/12 is a range, not a prefix — 172.32 is public and must pass.
  test('does not over-block the 172 range', () => {
    expect(() => assertConnectorUrl('https://172.32.0.1/mcp')).not.toThrow()
    expect(() => assertConnectorUrl('https://172.15.0.1/mcp')).not.toThrow()
  })

  test('rejects a value that is not a URL at all', () => {
    expect(() => assertConnectorUrl('not a url')).toThrow(ConnectorUrlError)
    expect(() => assertConnectorUrl('')).toThrow(ConnectorUrlError)
  })

  // An explicit per-call opt-in, never an environment sniff — nothing gets to
  // decide on its own that a deployment is "dev enough" to fetch localhost.
  test('allowInsecure opens the door only when asked', () => {
    expect(() => { return assertConnectorUrl('http://localhost:8080/mcp', { allowInsecure: true }) },
    ).not.toThrow()
    expect(() => assertConnectorUrl('http://localhost:8080/mcp')).toThrow(
      ConnectorUrlError,
    )
  })
})
