import { describe, expect, test } from 'bun:test'

import { allTools } from './catalog'
import { describeToolCatalog } from './describe'

// The point of `describeToolCatalog` is that a documentation surface cannot
// drift from the served one. These tests are that promise: the count matches,
// every arg is accounted for, and nothing renders as a blank.

describe('describeToolCatalog', () => {
  const described = describeToolCatalog()

  test('covers exactly the served catalog', () => {
    expect(described.map((t) => t.name)).toEqual(allTools().map((t) => t.name))
  })

  test('carries every argument of every tool', () => {
    for (const tool of allTools()) {
      const entry = described.find((t) => t.name === tool.name)
      expect(entry?.args.map((a) => a.name)).toEqual(
        Object.keys(tool.inputSchema),
      )
    }
  })

  test('nothing renders as a blank', () => {
    for (const tool of described) {
      expect(tool.title.length).toBeGreaterThan(0)
      expect(tool.description.length).toBeGreaterThan(0)
      for (const arg of tool.args) {
        // `unknown` is the fallback when the wrapper stack could not be peeled;
        // seeing one means a schema shape this file does not understand.
        expect(arg.type).not.toBe('unknown')
        expect(arg.description ?? '').not.toBe('')
      }
    }
  })

  test('sees through `.nullish()` to the optionality and the primitive', () => {
    // `list_runs` takes nothing but optional filters — the shape most likely to
    // be reported as a required `optional`-typed argument by a naive reader.
    const listRuns = described.find((t) => t.name === 'list_runs')
    expect(listRuns?.args.some((a) => a.required)).toBe(false)
    expect(listRuns?.args.find((a) => a.name === 'limit')?.type).toBe('number')
    expect(listRuns?.args.find((a) => a.name === 'status')?.type).toBe('string')
  })

  test('flags the write tools rather than hiding them', () => {
    const writes = described.filter((t) => !t.readOnly).map((t) => t.name)
    expect(writes).toContain('run_eval')
    expect(described.filter((t) => t.readOnly).length).toBeGreaterThan(
      writes.length,
    )
  })
})
