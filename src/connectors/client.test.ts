import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import { deriveSideEffect, normalizeToolResult, pickServerIcon } from './client'

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

// The spike that chose the MCP SDK found exactly one thing that breaks it on
// workerd: `new Client(info)` with no validator compiles tool output schemas
// with Ajv, which uses `new Function`, which workerd forbids. It throws inside
// `listTools()` — the call discovery cannot skip — and only for servers whose
// tools declare an `outputSchema`, so it passes every simple smoke test and
// breaks on the first real connector.
//
// `connectors/client.ts` is therefore the only place allowed to construct one.
// This is the thing that notices when someone adds a second.
describe('the MCP client factory is the only constructor', () => {
  test('nothing else in the SDK constructs an MCP Client', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((f) => !f.endsWith('/connectors/client.ts'))
      // This file, which necessarily contains the pattern it searches for.
      .filter((f) => !f.endsWith('/connectors/client.test.ts'))
      // The MCP *server* tests construct an in-memory client against our own
      // server; that is the outbound half and never touches a remote schema.
      .filter((f) => !f.endsWith('/mcp/server.test.ts'))
      .filter((f) => /new Client\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC_DIR.length))
    expect(offenders).toEqual([])
  })

  test('the factory injects the eval-free validator', () => {
    const src = readFileSync(`${SRC_DIR}connectors/client.ts`, 'utf8')
    expect(src).toContain('CfWorkerJsonSchemaValidator')
    // The constructor call and the validator must be in the same expression —
    // an import alone would not save us.
    expect(src).toMatch(
      /new Client\(\s*CLIENT_INFO,\s*\{\s*jsonSchemaValidator:/,
    )
  })
})

describe('side-effect classification', () => {
  test('only an explicit readOnlyHint earns read', () => {
    expect(deriveSideEffect({ readOnlyHint: true })).toBe('read')
    expect(deriveSideEffect({ readOnlyHint: false })).toBe('write')
    expect(deriveSideEffect({ destructiveHint: true })).toBe('write')
  })

  // Unclassified must be treated as dangerous: evals then simulate it instead
  // of letting a test run mutate somebody's real tracker.
  test('an unannotated tool is assumed to write', () => {
    expect(deriveSideEffect(undefined)).toBe('write')
    expect(deriveSideEffect(null)).toBe('write')
    expect(deriveSideEffect({})).toBe('write')
    expect(deriveSideEffect({ readOnlyHint: 'true' })).toBe('write')
  })
})

describe('tool result normalization', () => {
  // A declared output schema means the client already validated this value —
  // it is the machine-readable answer and outranks the prose.
  test('structured content wins', () => {
    expect(
      normalizeToolResult({
        structuredContent: { id: 'ART-1' },
        content: [{ type: 'text', text: 'ignored' }],
      }),
    ).toEqual({ id: 'ART-1' })
  })

  test('falsy structured content still wins over text', () => {
    expect(
      normalizeToolResult({
        structuredContent: null,
        content: [{ type: 'text', text: 'ignored' }],
      }),
    ).toBeNull()
  })

  // Most servers return structured data as a JSON text block today; handing a
  // downstream node a string it must parse itself would be the worse default.
  test('parses a JSON text block', () => {
    expect(
      normalizeToolResult({
        content: [{ type: 'text', text: '{"issues":[{"id":"ART-1"}]}' }],
      }),
    ).toEqual({ issues: [{ id: 'ART-1' }] })
  })

  test('leaves prose alone', () => {
    expect(
      normalizeToolResult({ content: [{ type: 'text', text: 'all done' }] }),
    ).toBe('all done')
  })

  test('joins multiple text blocks', () => {
    expect(
      normalizeToolResult({
        content: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      }),
    ).toBe('one\ntwo')
  })

  // An image/resource-only result has no text to speak of; returning the raw
  // blocks beats inventing an empty string.
  test('keeps non-text blocks rather than dropping them', () => {
    const blocks = [{ type: 'image', data: 'base64', mimeType: 'image/png' }]
    expect(normalizeToolResult({ content: blocks })).toEqual(blocks)
  })

  test('an empty result is null', () => {
    expect(normalizeToolResult({ content: [] })).toBeNull()
    expect(normalizeToolResult({})).toBeNull()
  })
})

// `serverInfo.icons` is third-party input that ends up in an `<img src>`, so the
// picker is an allow-list, not a passthrough.
describe('server icon selection', () => {
  test('no icons, no info → null', () => {
    expect(pickServerIcon(undefined)).toBeNull()
    expect(pickServerIcon({})).toBeNull()
    expect(pickServerIcon({ icons: [] })).toBeNull()
  })

  test('only https and data:image survive', () => {
    expect(
      pickServerIcon({
        icons: [
          { src: 'javascript:alert(1)' },
          { src: 'http://insecure.example/icon.png' },
          { src: 'data:text/html;base64,PHNjcmlwdD4=' },
          { src: '  ' },
        ],
      }),
    ).toBeNull()
    expect(pickServerIcon({ icons: [{ src: 'https://x.example/i.png' }] })).toBe(
      'https://x.example/i.png',
    )
    expect(
      pickServerIcon({ icons: [{ src: 'data:image/png;base64,iVBORw0KGgo=' }] }),
    ).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  test('prefers SVG, then a non-dark theme, then the first listed', () => {
    expect(
      pickServerIcon({
        icons: [
          { src: 'https://x.example/dark.png', theme: 'dark' },
          { src: 'https://x.example/light.png', theme: 'light' },
          { src: 'https://x.example/mark.svg', mimeType: 'image/svg+xml' },
        ],
      }),
    ).toBe('https://x.example/mark.svg')
    expect(
      pickServerIcon({
        icons: [
          { src: 'https://x.example/dark.png', theme: 'dark' },
          { src: 'https://x.example/light.png', theme: 'light' },
        ],
      }),
    ).toBe('https://x.example/light.png')
    expect(
      pickServerIcon({
        icons: [
          { src: 'https://x.example/first.png' },
          { src: 'https://x.example/second.png' },
        ],
      }),
    ).toBe('https://x.example/first.png')
  })

  test('drops an oversized data URI', () => {
    const huge = `data:image/png;base64,${'A'.repeat(70 * 1024)}`
    expect(pickServerIcon({ icons: [{ src: huge }] })).toBeNull()
  })
})
