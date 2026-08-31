import { resolvePath } from '../engine/binding'
import type { AgentNode, ArgBinding, WorkflowGraph } from '../engine/graph'
import type { AgentNodeMeta } from '../engine/nodes/agent'
import { allNodes } from '../storage/data/authoring-graph'

import type {
  CheckTree,
  EvalSampleInput,
  EvalTools,
  SeededMessage,
} from './checks'

// Turning a real run into an eval Sample.
//
// The highest-value eval data isn't invented — it is mined from runs that
// already happened, and especially from the ones a human marked bad. Everything
// a Sample needs is in the trace: what the agent was asked, what its tools
// returned, and what it answered. This module is the pure conversion; the MCP
// tool and the run viewer's "Create sample" button are two callers of it.
//
// The conversion is deliberately NOT a write. A draft is returned, reviewed, and
// only then upserted — a bad conversion is a thing you look at, not a thing you
// find in a Goal later.
//
// ── Two layers, two different samples from the same run ─────────────────────
//
// TRAJECTORY replays the run's real tool results as `fixtures` under
// `mode: 'mocked'`. Deterministic, and the only mode where `tool_called` /
// `tool_args_match` grade anything real.
//
// SYNTHESIS folds those same tool results into a seeded ASSISTANT turn and
// freezes the tool set, so the model answers from staged context and the sample
// grades response quality alone — no retrieval nondeterminism in the way.
//
// Which one you want depends on what failed, so it is an argument rather than a
// guess. Synthesis needs somewhere to stage the context, which is a conversation
// thread; a `task` agent has none (its messages ARE its rendered user prompt),
// so that combination is refused rather than silently degraded into a plain
// input→output test.

export type RunDraftLayer = 'trajectory' | 'synthesis'

/** The slice of a recorded step this module reads (a `WfRunStepDTO` subset). */
export type RunDraftStep = {
  cursor: number
  nodeId: string
  nodeKind: string
  parentNodeId: string | null
  itemIndex: number | null
  input: unknown
  output: unknown
  meta: unknown
}

/** An agent step in a trace, as a candidate to draft from. */
export type RunAgentStep = {
  cursor: number
  nodeId: string
  /** From `meta.agentId` — the only durable link from a step to its agent. */
  agentId: string | null
  agentVersion: number | null
  model: string | null
  /** How many tool calls its loop made; 0 means nothing to mock or stage. */
  toolCallCount: number
}

/** What the target agent's own contract says a Sample for it must look like. */
export type RunDraftTarget = {
  inputKind: 'task' | 'conversation'
  inputVariables: string[]
}

/** The customer signal on the run, when it has any. */
export type RunDraftFeedback = {
  rating: string
  note: string | null
}

export type RunSampleDraft = {
  input: EvalSampleInput
  tools: EvalTools
  checks: CheckTree
  /** Everything the conversion assumed, guessed, or could not recover. */
  notes: string[]
}

/**
 * Every agent step in a trace, newest last.
 *
 * A workflow run has more than one, and they are not interchangeable — each is
 * a different agent with a different contract — so a caller that doesn't name
 * one has to be shown the choice rather than handed the first.
 */
export function agentStepsOf(steps: RunDraftStep[]): RunAgentStep[] {
  return steps
    .filter((s) => s.nodeKind === 'agent')
    .map((s) => {
      const meta = s.meta as AgentNodeMeta | undefined
      const toolCallCount = (meta?.steps ?? []).reduce(
        (n, st) => n + (st.toolCalls?.length ?? 0),
        0,
      )
      return {
        cursor: s.cursor,
        nodeId: s.nodeId,
        agentId: meta?.agentId ?? null,
        agentVersion: meta?.agentVersion ?? null,
        model: meta?.model ?? null,
        toolCallCount,
      }
    })
}

/** The agent node behind a step, including one nested in an iteration subgraph. */
export function agentNodeFor(
  graph: WorkflowGraph | null,
  nodeId: string,
): AgentNode | null {
  if (!graph) return null
  for (const node of allNodes(graph)) {
    if (node.kind === 'agent' && node.id === nodeId) return node
  }
  return null
}

// ── Input recovery ──────────────────────────────────────────────────────────

/**
 * Rebuild a `task` agent's `${vars}` from what its node actually ran with.
 *
 * A value comes from the node's own input binding resolved against the run's
 * recorded outputs (a `literal` is its own value; a `ref` reads the referenced
 * node's recorded output at the binding path), falling back to a matching field
 * on the routed input. Variables supplied by RUN-level prompt variables aren't
 * persisted per step, so they stay absent for the author to fill — see
 * `missingVariables`. A free-form agent (no declared vars) captures the routed
 * input's own fields, so the recovered input isn't simply empty.
 */
export function recoverTaskVariables(
  node: AgentNode | null,
  step: RunDraftStep,
  steps: RunDraftStep[],
  inputVariables: string[],
): Record<string, string> {
  const inputs = node?.config.inputs ?? {}
  const variables: Record<string, string> = {}

  const resolveBinding = (binding: ArgBinding): unknown => {
    if (binding.kind === 'literal') return binding.value
    const source = outputForNode(steps, step, binding.nodeId)
    return source === undefined ? undefined : resolvePath(source, binding.path)
  }

  for (const v of inputVariables) {
    const binding = inputs[v]
    let value = binding ? resolveBinding(binding) : undefined
    if (value === undefined) value = flatField(step.input, v)
    if (value !== undefined && value !== null) variables[v] = asText(value)
  }

  if (inputVariables.length === 0 && isPlainRecord(step.input)) {
    for (const [k, value] of Object.entries(step.input)) {
      if (value !== undefined && value !== null) variables[k] = asText(value)
    }
  }

  return variables
}

// The recorded output for `nodeId`, preferring a sibling within the same
// iteration item when the selected step ran inside one, else the top-level step.
function outputForNode(
  steps: RunDraftStep[],
  step: RunDraftStep,
  nodeId: string,
): unknown {
  if (step.parentNodeId != null) {
    const sibling = steps.find(
      (s) =>
        s.nodeId === nodeId &&
        s.parentNodeId === step.parentNodeId &&
        s.itemIndex === step.itemIndex,
    )
    if (sibling) return sibling.output
  }
  return steps.find((s) => s.nodeId === nodeId && s.parentNodeId == null)
    ?.output
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flatField(input: unknown, key: string): unknown {
  return isPlainRecord(input) ? input[key] : undefined
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * The thread the agent was sent, as authored turns.
 *
 * `meta.messages` is what the model ACTUALLY saw, which is why it is recorded
 * separately from the step's input. Any trailing assistant turn is dropped: a
 * Sample stages the conversation up to the point the reply is due, and the reply
 * is what the run will produce and the checks will grade.
 */
export function recoverTurns(meta: AgentNodeMeta | undefined): SeededMessage[] {
  const turns: SeededMessage[] = (meta?.messages ?? [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }))
  while (turns.at(-1)?.role === 'assistant') turns.pop()
  return turns
}

// ── The draft ───────────────────────────────────────────────────────────────

export type DraftSampleArgs = {
  step: RunDraftStep
  steps: RunDraftStep[]
  node: AgentNode | null
  target: RunDraftTarget
  layer: RunDraftLayer
  feedback?: RunDraftFeedback | null
  /** Per-fixture character budget; a tool result can be a whole document. */
  maxFixtureChars?: number
}

const DEFAULT_MAX_FIXTURE_CHARS = 20_000

export function draftSampleFromRun(
  args: DraftSampleArgs,
): RunSampleDraft | { error: string } {
  const meta = args.step.meta as AgentNodeMeta | undefined
  const notes: string[] = []
  const calls = toolCallsOf(meta)

  if (args.layer === 'synthesis' && args.target.inputKind !== 'conversation') {
    return {
      error:
        'Synthesis needs a conversation to stage the retrieved context in, and this is a `task` agent — its messages are its own rendered user prompt, so there is no turn to attach tool results to. Draft it as `trajectory` instead, which replays the same tool results as fixtures.',
    }
  }

  const input = buildInput(args, meta, calls, notes)
  const tools = buildTools(args, calls, notes)
  const checks = buildChecks(args, calls, notes)

  if (calls.length === 0) {
    notes.push(
      'The agent called no tools in this run, so there is nothing to mock or stage; the sample grades its answer alone.',
    )
  }
  notes.push(
    'The checks are a STARTING POINT, not a verdict — rewrite the judge rubric to say what a correct answer must do before saving this sample.',
  )
  return { input, tools, checks, notes }
}

type ToolCall = { toolId: string; args: unknown; output: unknown }

/**
 * The agent loop's tool calls, in order.
 *
 * Read the same way {@link grade} reads them (`meta.steps[].toolCalls[]`, keyed
 * on `toolName`), because that is the key a fixture is looked up under at run
 * time — a fixture keyed any other way is silently never used.
 */
function toolCallsOf(meta: AgentNodeMeta | undefined): ToolCall[] {
  const calls: ToolCall[] = []
  for (const st of meta?.steps ?? []) {
    for (const tc of st.toolCalls ?? []) {
      calls.push({ toolId: tc.toolName, args: tc.input, output: tc.output })
    }
  }
  return calls
}

function buildInput(
  args: DraftSampleArgs,
  meta: AgentNodeMeta | undefined,
  calls: ToolCall[],
  notes: string[],
): EvalSampleInput {
  if (args.target.inputKind === 'task') {
    const variables = recoverTaskVariables(
      args.node,
      args.step,
      args.steps,
      args.target.inputVariables,
    )
    const missing = args.target.inputVariables.filter(
      (v) => !Object.hasOwn(variables, v),
    )
    if (missing.length > 0) {
      notes.push(
        `Could not recover ${missing.join(', ')} from the trace — run-level prompt variables aren't persisted per step. Fill them in before saving.`,
      )
    }
    if (!args.node) {
      notes.push(
        "The run's graph no longer holds this node, so variables were recovered from the routed input alone.",
      )
    }
    return { kind: 'task', variables }
  }

  const turns = recoverTurns(meta)
  if (turns.length === 0) {
    notes.push(
      'The trace recorded no messages for this step (steps written before `meta.messages` existed), so the thread is empty — write the user turn by hand.',
    )
  }
  if (args.layer !== 'synthesis') {
    return { kind: 'conversation', turns, variables: {} }
  }
  // Synthesis: the retrieval already happened. Staging it as an assistant turn
  // is what `seededMessagesToUiMessages` expands into a completed tool call the
  // model can answer from.
  const staged: SeededMessage[] = [...turns]
  if (calls.length > 0) {
    staged.push({
      role: 'assistant',
      toolCalls: calls.map((c) => ({
        tool: c.toolId,
        args: c.args,
        output: c.output,
      })),
    })
  }
  return { kind: 'conversation', turns: staged, variables: {} }
}

function buildTools(
  args: DraftSampleArgs,
  calls: ToolCall[],
  notes: string[],
): EvalTools {
  if (args.layer === 'synthesis') return { mode: 'frozen' }

  const max = args.maxFixtureChars ?? DEFAULT_MAX_FIXTURE_CHARS
  const fixtures: Record<string, unknown> = {}
  const repeated = new Set<string>()
  const truncated = new Set<string>()
  for (const c of calls) {
    if (Object.hasOwn(fixtures, c.toolId)) repeated.add(c.toolId)
    const json = JSON.stringify(c.output ?? {})
    if (json.length > max) {
      truncated.add(c.toolId)
      fixtures[c.toolId] =
        `${json.slice(0, max)}… [truncated ${json.length - max} chars]`
    } else {
      fixtures[c.toolId] = c.output ?? {}
    }
  }
  if (repeated.size > 0) {
    // Fixtures are keyed by tool id alone, so a tool called twice has one canned
    // result for both calls — worth saying, because the second call's result is
    // the one that survives and it may not be the interesting one.
    notes.push(
      `${[...repeated].join(', ')} was called more than once; a fixture is one result per tool, so the LAST result is what the sample replays.`,
    )
  }
  if (truncated.size > 0) {
    notes.push(
      `The recorded result for ${[...truncated].join(', ')} was too large to inline and is truncated in the fixture — replace it with a representative result, or read the full value with get_run_step.`,
    )
  }
  return { mode: 'mocked', fixtures }
}

function buildChecks(
  args: DraftSampleArgs,
  calls: ToolCall[],
  notes: string[],
): CheckTree {
  const checks: CheckTree['checks'] = []
  // Only under mocked tools: a frozen sample's agent calls nothing, so a
  // trajectory check there grades an absence and always fails.
  if (args.layer === 'trajectory') {
    for (const toolId of new Set(calls.map((c) => c.toolId))) {
      checks.push({ type: 'tool_called', toolId, called: true })
    }
  }
  checks.push({ type: 'llm_judge', rubric: seedRubric(args, notes) })
  return { op: 'and', checks }
}

/**
 * A judge rubric seeded from the run — and never from its output.
 *
 * Asserting the run's own answer is the standard is wrong in both directions:
 * on a run a human rated BAD it would enshrine the failure as correct, and on
 * any run it makes the sample a regression test for one exact phrasing rather
 * than for the thing that mattered. So the rubric names what must be judged and
 * says, in its own text, that it is unfinished.
 */
function seedRubric(args: DraftSampleArgs, notes: string[]): string {
  const rating = args.feedback?.rating
  if (rating === 'down') {
    const note = args.feedback?.note
    notes.push(
      'This run was rated DOWN by a human. Its answer is the FAILURE this sample exists to catch — do not seed it as the expected output.',
    )
    return [
      'TODO — rewrite this rubric before saving.',
      "A human rated this run's answer bad.",
      note ? `They said: "${note}"` : 'They left no note.',
      'State what a correct answer must do instead. The answer this run produced must FAIL this rubric.',
    ].join(' ')
  }
  return [
    'TODO — rewrite this rubric before saving.',
    'State what a correct answer must contain for this input.',
    "The run's own answer is a reference, not the standard — grade the requirement, not the phrasing.",
  ].join(' ')
}
