import { describe, expect, test } from 'bun:test'

import { allTools } from '../../mcp/catalog'
import { DEFAULT_WF_SECTIONS } from '../wf-hub'

import { categoryOf, groupByCategory, TOOL_CATEGORIES } from './categories'

/**
 * The catalog page groups by subject, derived from each tool's name. That is
 * cheaper than a hand-kept list and it has one failure mode: a tool whose name
 * matches no rule lands in `platform` silently, and a reader would never know it
 * was misfiled rather than deliberately there.
 *
 * So `platform` is pinned by name. A new tool that matches nothing arrives there
 * and fails this test, which turns "the grouping went stale" into "the build
 * broke" — the same trade the tool descriptions make by generating their
 * enumerations from the schema.
 */

const NAMES = allTools().map((t) => t.name)

describe('tool categories', () => {
  // The whole point of deriving it: a tool cannot be absent from the page.
  test('every tool in the catalog lands in exactly one group', () => {
    const grouped = groupByCategory(
      allTools().map((t) => ({ name: t.name }) as never),
    ).flatMap((g) => g.tools.map((t) => t.name))
    expect(grouped.sort()).toEqual([...NAMES].sort())
  })

  test('the platform fallback holds only what belongs there', () => {
    const fallback = NAMES.filter((n) => categoryOf(n) === 'platform').sort()
    // Health, the audit feed, and the one tool that edits prose on anything.
    expect(fallback).toEqual([
      'get_dashboard',
      'list_changes',
      'update_description',
    ])
  })

  // The precedences the rule ORDER encodes. Each of these names contains two
  // keywords, so a reordered rule list silently refiles them.
  test('a name carrying two subjects resolves to the more specific one', () => {
    // `agent` before `run`.
    expect(categoryOf('run_agent_preview')).toBe('agents')
    expect(categoryOf('list_agent_calls')).toBe('agents')
    // `eval` before `run`.
    expect(categoryOf('run_eval')).toBe('evals')
    expect(categoryOf('get_eval_run')).toBe('evals')
    expect(categoryOf('resume_eval_run')).toBe('evals')
    expect(categoryOf('cancel_eval_run')).toBe('evals')
    // `sample` catches the one eval tool named after a run.
    expect(categoryOf('draft_sample_from_run')).toBe('evals')
    // And the genuine run tools stay put.
    expect(categoryOf('retry_run')).toBe('runs')
    expect(categoryOf('get_run_step')).toBe('runs')
    expect(categoryOf('list_runs')).toBe('runs')
    // `model` vs the tool catalog: neither name reaches the other's rule.
    expect(categoryOf('refresh_model_catalog')).toBe('models')
    expect(categoryOf('get_tool_catalog')).toBe('tools')
    // `trigger` is authored as part of a workflow, so it groups with them.
    expect(categoryOf('list_trigger_events')).toBe('workflows')
  })

  test('no category is defined that nothing can reach', () => {
    const reachable = new Set(NAMES.map(categoryOf))
    const declared = TOOL_CATEGORIES.map((c) => c.key)
    expect(declared.filter((k) => !reachable.has(k))).toEqual([])
  })

  // Each heading wears the console's own icon for that subject, looked up by
  // `navKey`. A renamed hub section would otherwise leave a heading silently
  // iconless — visible only to whoever happened to scroll past it.
  test('every category points at a real hub section', () => {
    const sections = new Set(DEFAULT_WF_SECTIONS.map((s) => s.key))
    const dangling = TOOL_CATEGORIES.filter((c) => !sections.has(c.navKey))
    expect(dangling.map((c) => `${c.key} → ${c.navKey}`)).toEqual([])
  })
})
