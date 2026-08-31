import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import { allTools, selectTools } from './catalog'

// guide.md's tool table is the only place a host can see what mounting this
// actually exposes, which makes it a contract and not a convenience. Both sides
// read fine on their own when they drift — the table stays plausible while the
// catalog moves under it — so nothing but a test catches it. The count sentence
// is in here because it was already wrong once: it said "seventeen" while the
// catalog held twenty-one.

const guide = readFileSync(
  fileURLToPath(new URL('../../guide.md', import.meta.url)),
  'utf8',
)

/** The number words the count sentence uses. Extend when the catalog grows. */
const WORDS: Record<number, string> = {
  3: 'three',
  4: 'four',
  15: 'fifteen',
  16: 'sixteen',
  17: 'seventeen',
  18: 'eighteen',
  19: 'nineteen',
  20: 'twenty',
  21: 'twenty-one',
  22: 'twenty-two',
  23: 'twenty-three',
  24: 'twenty-four',
  25: 'twenty-five',
}

describe('the tool catalog ↔ guide.md', () => {
  test('every tool is named in the guide', () => {
    const missing = allTools()
      .map((t) => t.name)
      .filter((name) => !guide.includes(`\`${name}\``))
    expect(missing).toEqual([])
  })

  test('the guide names no tool that does not exist', () => {
    const real = new Set(allTools().map((t) => t.name))
    // Only the table's rows — a backticked snake_case name in a `|` line.
    const claimed = new Set<string>()
    for (const line of guide.split('\n')) {
      if (!line.startsWith('|')) continue
      for (const m of line.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
        claimed.add(m[1] ?? '')
      }
    }
    // `wf_change` and friends are table nouns, not tools; only flag names that
    // look like a tool the guide is offering and that nothing implements.
    const phantom = [...claimed].filter(
      (n) => !real.has(n) && /^(?:list|get|create|update|delete|run|draft)_/.test(n),
    )
    expect(phantom).toEqual([])
  })

  test('the counts in the guide are the real counts', () => {
    const tools = allTools()
    const reads = selectTools(tools, false).length
    const writes = tools.length - reads
    const sentence = `${WORDS[tools.length]} tools — ${WORDS[reads]} reads, and ${WORDS[writes]} writes`
    expect(guide.toLowerCase()).toContain(sentence.toLowerCase())
  })
})
