import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

// The subpath table in guide.md IS the integration contract — it's how a host
// learns which entry point to import and, more importantly, which runtime each
// one is safe in (`/cloudflare/runtime` imports `cloudflare:workers` and blows
// up in a Node route; the guide is where that warning lives).
//
// It had drifted: three real public entry points — ./analytics,
// ./cloudflare/analytics-engine and ./ui/run-progress — shipped undocumented.
// Nothing catches that class of drift except a test, because both sides are
// "correct" on their own.

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  name: string
  exports: Record<string, unknown>
}
const guide = readFileSync(`${root}guide.md`, 'utf8')

/** Every `@stevepeak/007…` entry named in the guide's subpath table. */
function documentedSubpaths(): Set<string> {
  const found = new Set<string>()
  for (const line of guide.split('\n')) {
    if (!line.startsWith('|')) continue
    const m = /^\|\s*`(@stevepeak\/007[^`]*)`/.exec(line)
    if (!m) continue
    const sub = m[1].slice(pkg.name.length)
    found.add(sub === '' ? '.' : `.${sub}`)
  }
  return found
}

describe('package exports ↔ guide.md subpath table', () => {
  test('every published subpath is documented', () => {
    const documented = documentedSubpaths()
    const undocumented = Object.keys(pkg.exports).filter(
      (k) => !documented.has(k),
    )
    expect(undocumented).toEqual([])
  })

  test('every documented subpath is actually published', () => {
    const published = new Set(Object.keys(pkg.exports))
    const phantom = [...documentedSubpaths()].filter((k) => !published.has(k))
    expect(phantom).toEqual([])
  })
})
