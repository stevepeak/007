import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

// AGENTS.md is the first file an agent reads, and its recipes ("to add an RPC
// method, touch these seven files") are only worth following if the files it
// names exist. A rename anywhere else in the tree leaves the prose pointing at
// nothing, and nothing but a test notices — the doc is not compiled.
//
// Globs (`src/ui/**`) and placeholders (`src/engine/nodes/<kind>.ts`) describe
// a shape rather than a file and are skipped; everything else must resolve.

const root = fileURLToPath(new URL('..', import.meta.url))
const agents = readFileSync(`${root}AGENTS.md`, 'utf8')

function citedPaths(): string[] {
  const out = new Set<string>()
  for (const m of agents.matchAll(/`(src\/[^`\s]+)`/g)) {
    const p = m[1]
    if (/[*<>]/.test(p)) continue
    out.add(p)
  }
  return [...out].sort()
}

describe('AGENTS.md', () => {
  test('every `src/…` path it cites exists', () => {
    const missing = citedPaths().filter((p) => !existsSync(`${root}${p}`))
    expect(missing).toEqual([])
  })
})
