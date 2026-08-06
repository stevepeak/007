import { describe, expect, test } from 'bun:test'

import { DEFAULT_WF_ENGINE, resolveGraphEngine } from './graph-engine'
import { chainGraph } from './executor-test-helpers'

// A graph whose trigger declares `engine`. Built off the shared chain graph so
// these stay honest about the real node shape.
function graphWithEngine(engine?: string) {
  const g = chainGraph()
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === 't' ? { ...n, config: { ...n.config, engine } } : n,
    ),
  }
}

describe('resolveGraphEngine', () => {
  test('reads the engine off the trigger node', () => {
    expect(resolveGraphEngine(graphWithEngine('inline'))).toBe('inline')
    expect(resolveGraphEngine(graphWithEngine('durable'))).toBe('durable')
  })

  test('a graph with no engine set runs on the default', () => {
    expect(resolveGraphEngine(chainGraph())).toBe(DEFAULT_WF_ENGINE)
    expect(DEFAULT_WF_ENGINE).toBe('durable')
  })

  // The point of the lenient probe: choosing a backend happens before any
  // backend has validated the graph, so an unrelated authoring error must not
  // make the run undispatchable — it should reach a backend that reports it.
  test('falls back to the default rather than throwing on a bad graph', () => {
    expect(resolveGraphEngine(undefined)).toBe(DEFAULT_WF_ENGINE)
    expect(resolveGraphEngine({ nodes: 'not-an-array' })).toBe(
      DEFAULT_WF_ENGINE,
    )
    expect(resolveGraphEngine({ nodes: [] })).toBe(DEFAULT_WF_ENGINE)
    // Structurally fine, but the trigger names an engine that doesn't exist.
    expect(resolveGraphEngine(graphWithEngine('quantum'))).toBe(
      DEFAULT_WF_ENGINE,
    )
  })

  test('ignores an engine set on a non-trigger node', () => {
    const g = chainGraph()
    const withEngineOnTool = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === 'boom' ? { ...n, config: { ...n.config, engine: 'inline' } } : n,
      ),
    }
    expect(resolveGraphEngine(withEngineOnTool)).toBe(DEFAULT_WF_ENGINE)
  })
})
