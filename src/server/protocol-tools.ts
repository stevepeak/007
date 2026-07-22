import type { JsonSchema } from '../engine/agent-output'

export type { JsonSchema } from '../engine/agent-output'

export type ToolOption = {
  id: string
  /** Human-readable name shown to end users (never the raw id). */
  name: string
  /** One-line description of the service/capability. */
  description: string
  /** Optional inline SVG brand/icon markup (trusted, SDK/host-defined). */
  icon?: string
  kind: 'ai-tool' | 'function'
  /**
   * JSON Schema of the tool's input arguments (converted from the tool's Zod
   * `inputSchema`). Drives the "requires" side of node data-mapping. Absent when
   * the tool didn't declare one.
   */
  inputSchema?: JsonSchema
  /**
   * JSON Schema of the tool's output — the mappable shape a downstream node can
   * read. Absent when the tool didn't declare one.
   */
  outputSchema?: JsonSchema
}

// One recorded invocation of a tool, pulled from the run steps across all runs
// (a `wf_run_step` with `nodeKind: 'tool'` whose `meta.toolId` matches).
// Surfaces on the tool detail page's "recent calls" list.
export type WfToolInvocation = {
  /** The run this call happened in — links to the run page. */
  runId: string
  /** The tool node's id within that run's graph. */
  nodeId: string
  status: string
  /** The validated arguments the tool was called with (from the step meta). */
  args: Record<string, unknown>
  /** What the tool returned (the step output). */
  output: unknown
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  /** The workflow the call happened in (for context in the list). */
  workflowId: string | null
  workflowName: string | null
}

// A host-declared **context** input for the tool playground. Tools are scoped
// by their per-run deps (built from the run context), NOT by their AI-visible
// arguments — e.g. a "client memory" tool always filters by the run's client
// org, which an agent never supplies. These fields let the playground collect
// that ambient context so a real call runs against the right scope. Each field
// is an opaque string the host maps back into the RunContext (subjectId /
// correlationId / a promptVariable) inside its `runToolPreview` handler.
export type ToolContextField = {
  /** Stable key in the context bag the playground sends back. */
  key: string
  /** Human label shown in the Context section (e.g. "Client"). */
  label: string
  /** Helper text — what it scopes, or where to find the id. */
  description?: string
  /** Placeholder/example shown in the empty input. */
  placeholder?: string
  /** Block a real run until this field has a value. */
  required?: boolean
}

// Playground: the result of running a tool for real against scratch args. This
// executes the ACTUAL tool with the host's live per-run deps — not a simulation
// — so it can hit external services, bill calls, and mutate real data.
export type WfToolPreviewResult = {
  /** The value the tool returned. */
  output: unknown
  /** The args after schema validation/defaulting — what actually ran. */
  args: Record<string, unknown>
  /** Wall-clock duration of the tool call, in milliseconds. */
  durationMs: number
}
