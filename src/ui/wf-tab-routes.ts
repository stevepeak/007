// Classifies a 007 location into "an asset that opens its own tab" vs. a "home"
// route (the hub + section browsing, which lives inside the non-closable Home
// tab). The patterns MUST mirror the route switch in `wf-app.tsx` exactly, so
// tab rendering and the URL router never disagree about what a path is.
//
// A single source of truth, imported by both the tabs provider (to decide
// open-tab vs. navigate-in-home) and the tab strip (to resolve name/icon/crumbs).

/** A parsed asset location — the leaf the tab represents. */
export type WfAsset =
  | { type: 'workflow'; workflowId: string }
  | { type: 'agent'; agentId: string }
  | { type: 'run'; runId: string }
  | { type: 'tool'; toolId: string }
  | { type: 'evalSet'; setId: string }
  | { type: 'evalSample'; setId: string; sampleId: string }
  | { type: 'evalTest'; setId: string; sampleId: string; testId: string }
  | { type: 'evalRun'; evalRunId: string }

/** Strip any query/hash and split a path into non-empty segments. */
function segments(path: string): string[] {
  return path
    .replace(/[?#].*$/, '')
    .split('/')
    .filter(Boolean)
}

/**
 * Parse an asset location, or `null` for a home/browsing route (hub, section
 * lists, `<id>/runs`, coming-soon). Order matches `wf-app.tsx`.
 */
export function classifyAssetPath(path: string): WfAsset | null {
  const parts = segments(path)

  // `runs/<runId>` — a single run (self-contained, not nested under a workflow).
  if (parts.length === 2 && parts[0] === 'runs') {
    return { type: 'run', runId: parts[1] }
  }

  // `agents/<id>/edit` — agent editor.
  if (parts.length === 3 && parts[0] === 'agents' && parts[2] === 'edit') {
    return { type: 'agent', agentId: parts[1] }
  }

  // `tools/<toolId>` — tool detail / playground.
  if (parts.length === 2 && parts[0] === 'tools') {
    return { type: 'tool', toolId: parts[1] }
  }

  // `evals/<setId>/samples/<sampleId>/tests/<testId>` — a single test.
  if (
    parts.length === 6 &&
    parts[0] === 'evals' &&
    parts[2] === 'samples' &&
    parts[4] === 'tests'
  ) {
    return {
      type: 'evalTest',
      setId: parts[1],
      sampleId: parts[3],
      testId: parts[5],
    }
  }

  // `evals/runs/<evalRunId>` — a run report. Must precede `evals/<setId>`
  // (`runs` is a reserved segment, never a set id).
  if (parts.length === 3 && parts[0] === 'evals' && parts[1] === 'runs') {
    return { type: 'evalRun', evalRunId: parts[2] }
  }

  // `evals/<setId>/samples/<sampleId>` — a single sample.
  if (parts.length === 4 && parts[0] === 'evals' && parts[2] === 'samples') {
    return { type: 'evalSample', setId: parts[1], sampleId: parts[3] }
  }

  // `evals/<setId>` — an eval set ("Goal").
  if (parts.length === 2 && parts[0] === 'evals') {
    return { type: 'evalSet', setId: parts[1] }
  }

  // `<id>/edit` — workflow editor. (Checked after the more specific len-2 routes
  // above, matching the switch order in wf-app.tsx.)
  if (parts.length === 2 && parts[1] === 'edit') {
    return { type: 'workflow', workflowId: parts[0] }
  }

  // Everything else — the hub, section lists, `<id>/runs`, coming-soon — is a
  // home route rendered inside the Home tab.
  return null
}

/** True when a path opens its own asset tab (vs. navigating within Home). */
export function isAssetPath(path: string): boolean {
  return classifyAssetPath(path) !== null
}

/**
 * The tab identity key for a path — its segments without query/hash. Two links
 * to the same asset (with or without a trailing query) map to one tab.
 */
export function assetTabId(path: string): string {
  return segments(path).join('/')
}
