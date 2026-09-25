import type { WfMcpToolDescription } from '../../mcp/describe'

// Which subject a tool belongs to, for the catalog's grouping.
//
// ── Why this is derived and not a hand-kept list ─────────────────────────────
//
// The catalog used to be grouped by the write gate, and the stated reason was
// that "a subject grouping would have to be hand-maintained here and would go
// stale the first time a tool is added". That objection is right about a list of
// names and wrong about a rule: matching on the tool's OWN name means a new tool
// is categorised the moment it is registered, because every tool in this surface
// is named `<verb>_<subject>` by convention.
//
// The staleness is still real, just moved: a tool whose name matches nothing
// lands in `platform`, silently. So `categories.test.ts` pins that bucket's
// exact contents — a new tool that doesn't match arrives there and fails the
// test, which turns "went stale" into "won't build".
//
// Read/write is NOT a grouping any more. It is one badge on a row, because the
// question a reader has here is "what can this thing do about workflows", not
// "which half of the catalog needs the second consent" — and the endpoint
// picker above already answers that one.

export type ToolCategory = {
  key: string
  title: string
  /** One line on what this group is for, shown under the heading. */
  blurb: string
  /**
   * The `WfHubSection` key this group corresponds to, so the catalog can borrow
   * the console's own icon for it rather than picking a second one.
   *
   * A pointer instead of a copied icon: the nav is where a reader already
   * learned what a `Bot` or a `Target` means here, and re-choosing would give
   * the same subject two visual identities. `categories.test.ts` checks every
   * one of these resolves to a real section, so a renamed nav key is a failing
   * test rather than a silently iconless heading.
   */
  navKey: string
}

/**
 * The categories, in the order the page shows them: the things an author works
 * on first, then the evidence, then the platform underneath.
 *
 * Each carries the keywords a tool name is matched against. **Order is
 * significant** — first match wins, and several names contain two of them
 * (`run_agent_preview` is an agent tool, not a run tool; `resume_eval_run` is an
 * eval tool, not a run tool). The sequence encodes those precedences, so moving
 * an entry changes where tools land.
 */
const RULES: (ToolCategory & { match: string[] })[] = [
  {
    key: 'workflows',
    title: 'Workflows',
    blurb: 'The graphs: read them, edit a draft, publish a version.',
    navKey: 'workflows',
    // `trigger` catches the event catalog, which is only ever read in order to
    // author a trigger node.
    match: ['workflow', 'trigger'],
  },
  {
    key: 'agents',
    title: 'Agents',
    blurb:
      'The reusable LLM workers a workflow node points at — config, history, and what they really cost.',
    navKey: 'agents',
    // Before `run`, so `run_agent_preview` and `list_agent_calls` stay here.
    match: ['agent'],
  },
  {
    key: 'evals',
    title: 'Evals',
    blurb:
      'Goals, Samples and sweeps — writing the tests and reading what they found.',
    navKey: 'evals',
    // Before `run`, so `run_eval` / `get_eval_run` / `resume_eval_run` stay
    // here. `sample` catches `draft_sample_from_run`, whose name would otherwise
    // read as a run tool.
    match: ['eval', 'sample'],
  },
  {
    key: 'runs',
    title: 'Runs',
    blurb: 'Execution history and traces — what happened, and re-running it.',
    navKey: 'runs',
    match: ['run'],
  },
  {
    key: 'connectors',
    title: 'Connectors',
    blurb: 'Third-party MCP servers whose tools are proxied in, and their health.',
    navKey: 'connectors',
    // Before `tools`: these are tools too, but the console gives them their own
    // section because the thing you do about them is different — you cannot fix
    // a third party's tool, you refresh it or wait for their deploy.
    match: ['connector'],
  },
  {
    key: 'tools',
    title: 'Tools',
    blurb: 'What an agent can be given, and what it was really called with.',
    navKey: 'tools',
    match: ['tool'],
  },
  {
    key: 'models',
    title: 'Models',
    blurb: 'The chat and decision catalogs, and which models are offered.',
    navKey: 'models',
    match: ['model'],
  },
  {
    key: 'feedback',
    title: 'Feedback',
    blurb: 'Customer thumbs, the run behind each one, and triaging them.',
    navKey: 'feedback',
    match: ['feedback'],
  },
  {
    key: 'platform',
    title: 'Platform',
    blurb: 'Health, the audit feed, and the prose that describes everything.',
    // The one group with no single nav twin — it holds the dashboard, the change
    // feed and the tool that edits prose on any entity. It borrows Activity's
    // icon because `list_changes` IS that page, and the other two have no card
    // of their own (the dashboard is the hub itself).
    navKey: 'activity',
    // The fallback. Its membership is pinned by a test precisely because
    // "matched nothing" and "belongs here" are otherwise indistinguishable.
    match: [],
  },
]

export const TOOL_CATEGORIES: ToolCategory[] = RULES.map(
  ({ key, title, blurb, navKey }) => ({ key, title, blurb, navKey }),
)

/** The category one tool belongs to — first matching rule, else `platform`. */
export function categoryOf(name: string): string {
  const hit = RULES.find((r) => r.match.some((m) => name.includes(m)))
  return hit?.key ?? 'platform'
}

export type CategorizedTools = {
  category: ToolCategory
  tools: WfMcpToolDescription[]
}

/** Bucket tools into the categories, dropping any group nothing landed in. */
export function groupByCategory(
  tools: WfMcpToolDescription[],
): CategorizedTools[] {
  return TOOL_CATEGORIES.map((category) => ({
    category,
    tools: tools.filter((t) => categoryOf(t.name) === category.key),
  })).filter((g) => g.tools.length > 0)
}
