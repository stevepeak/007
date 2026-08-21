import { describe, expect, test } from 'bun:test'

import {
  assetTabId,
  classifyAssetPath,
  groupTabs,
  isAssetPath,
  tabGroup,
} from './wf-tab-routes'

// The classifier is the single source of truth for "asset tab vs. Home route".
// Its pattern order mirrors the route switch in wf-app.tsx, and overlapping
// shapes (`<id>/runs` vs `runs/<id>`, `evals/runs/<id>` vs `evals/<setId>`) are
// exactly where an ordering bug would send a location to the wrong surface.

describe('classifyAssetPath — asset routes', () => {
  test('workflow editor', () => {
    expect(classifyAssetPath('wf_1/edit')).toEqual({
      type: 'workflow',
      workflowId: 'wf_1',
    })
  })

  test('agent editor', () => {
    expect(classifyAssetPath('agents/ag_1/edit')).toEqual({
      type: 'agent',
      agentId: 'ag_1',
    })
  })

  test('single run', () => {
    expect(classifyAssetPath('runs/run_1')).toEqual({
      type: 'run',
      runId: 'run_1',
    })
  })

  test('tool detail', () => {
    expect(classifyAssetPath('tools/tavily')).toEqual({
      type: 'tool',
      toolId: 'tavily',
    })
  })

  test('eval set', () => {
    expect(classifyAssetPath('evals/set_1')).toEqual({
      type: 'evalSet',
      setId: 'set_1',
    })
  })

  test('eval sample', () => {
    expect(classifyAssetPath('evals/set_1/samples/row_1')).toEqual({
      type: 'evalSample',
      setId: 'set_1',
      sampleId: 'row_1',
    })
  })

  test('eval test', () => {
    expect(classifyAssetPath('evals/set_1/samples/row_1/checks/0')).toEqual({
      type: 'evalCheck',
      setId: 'set_1',
      sampleId: 'row_1',
      checkId: '0',
    })
  })

  test('eval run report — reserved `runs` segment wins over set id', () => {
    expect(classifyAssetPath('evals/runs/erun_1')).toEqual({
      type: 'evalRun',
      evalRunId: 'erun_1',
    })
  })

  test('ignores a trailing query string', () => {
    expect(classifyAssetPath('wf_1/edit?v=2')).toEqual({
      type: 'workflow',
      workflowId: 'wf_1',
    })
  })
})

describe('classifyAssetPath — home routes return null', () => {
  test.each([
    ['', 'hub'],
    ['workflows', 'workflows list'],
    ['agents', 'agents list'],
    ['tools', 'tools list'],
    ['runs', 'runs list'],
    ['evals', 'evals list'],
    ['wf_1/runs', 'workflow-scoped runs list'],
    ['calendar', 'coming-soon section'],
  ])('%s (%s)', (path) => {
    expect(classifyAssetPath(path)).toBeNull()
    expect(isAssetPath(path)).toBe(false)
  })
})

describe('assetTabId', () => {
  test('dedupes across query strings', () => {
    expect(assetTabId('wf_1/edit?v=2')).toBe(assetTabId('wf_1/edit'))
    expect(assetTabId('wf_1/edit')).toBe('wf_1/edit')
  })
})

describe('tabGroup', () => {
  test.each([
    ['wf_1/edit', 'workflow'],
    ['agents/ag_1/edit', 'agent'],
    ['runs/run_1', 'run'],
    ['tools/tavily', 'tool'],
    ['evals/set_1', 'evals'],
    ['evals/set_1/samples/s_1', 'evals'],
    ['evals/set_1/samples/s_1/checks/0', 'evals'],
    ['evals/runs/er_1', 'evals'],
    ['feedback/fb_1', 'feedback'],
  ])('%s → %s', (path, group) => {
    expect(tabGroup(path)).toBe(group as ReturnType<typeof tabGroup>)
  })

  test('an unclassifiable path falls back to workflows', () => {
    expect(tabGroup('calendar')).toBe('workflow')
  })
})

describe('groupTabs', () => {
  test('orders rows by kind and keeps open order within a row', () => {
    const tabs = [
      { id: 't1', path: 'tools/tavily' },
      { id: 't2', path: 'wf_2/edit' },
      { id: 't3', path: 'agents/ag_1/edit' },
      { id: 't4', path: 'wf_1/edit' },
      { id: 't5', path: 'tools/http' },
    ]
    expect(groupTabs(tabs)).toEqual([
      { group: 'workflow', tabs: [tabs[1], tabs[3]] },
      { group: 'agent', tabs: [tabs[2]] },
      { group: 'tool', tabs: [tabs[0], tabs[4]] },
    ])
  })

  test('omits empty rows', () => {
    expect(groupTabs([{ id: 't1', path: 'runs/run_1' }]).map((r) => r.group)).toEqual([
      'run',
    ])
    expect(groupTabs([])).toEqual([])
  })
})
