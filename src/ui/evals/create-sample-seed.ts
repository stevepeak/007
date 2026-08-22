import type { AgentNode, ArgBinding } from '../../engine'
import { resolvePath } from '../../engine/binding'
import type { EvalSampleInput, WfRunStepDTO } from '../../server/protocol'
import { firstLine, previewText } from '../text-preview'

// ── Given reconstruction ──────────────────────────────────────────────────────

// Rebuild the sample's initial condition from the node's execution. The Given
// the sample editor shows is `promptVariables`; we recover a value for each of
// the agent's declared `${vars}` from the node's input bindings resolved against
// the run's recorded outputs (a `literal` is its own value; a `ref` reads the
// referenced node's recorded output at the binding path), falling back to a
// matching field on the node's routed input. Vars supplied by run-level prompt
// variables (not bound on the node) aren't persisted per-step, so they stay
// blank for the author to fill. Free-form agents (no declared vars) capture the
// routed input's own fields.
//
// Always a `task` input: this button only offers itself for an agent node, and
// the values it recovers are that agent's prompt variables. A conversation
// target's thread isn't reconstructible from one node's recorded step.
export function seedGiven(
  node: AgentNode,
  step: WfRunStepDTO,
  steps: WfRunStepDTO[],
  inputVariables: string[],
): Extract<EvalSampleInput, { kind: 'task' }> {
  const inputs = node.config.inputs ?? {}
  const promptVariables: Record<string, string> = {}

  const resolveBinding = (binding: ArgBinding): unknown => {
    if (binding.kind === 'literal') return binding.value
    const source = outputForNode(steps, step, binding.nodeId)
    return source === undefined ? undefined : resolvePath(source, binding.path)
  }

  for (const v of inputVariables) {
    const binding = inputs[v]
    let value = binding ? resolveBinding(binding) : undefined
    if (value === undefined) value = flatField(step.input, v)
    if (value !== undefined && value !== null) promptVariables[v] = asText(value)
  }

  // Free-form agent: no declared vars → surface the routed input's own fields so
  // the Given isn't empty.
  if (inputVariables.length === 0 && isPlainRecord(step.input)) {
    for (const [k, value] of Object.entries(step.input)) {
      if (value !== undefined && value !== null) promptVariables[k] = asText(value)
    }
  }

  return { kind: 'task', variables: promptVariables }
}

// The recorded output for `nodeId`, preferring a sibling within the same
// iteration item when the selected step ran inside one, else the top-level step.
function outputForNode(
  steps: WfRunStepDTO[],
  step: WfRunStepDTO,
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
  return steps.find((s) => s.nodeId === nodeId && s.parentNodeId == null)?.output
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

// A short, one-line title seeded from the run: the first captured Given value,
// else a glimpse of the routed input, else the agent's name.
export function deriveTitle(
  agentName: string,
  given: Extract<EvalSampleInput, { kind: 'task' }>,
  step: WfRunStepDTO,
): string {
  const firstGiven = Object.values(given.variables)[0]
  const raw =
    (typeof firstGiven === 'string' && firstGiven) ||
    previewText(step.input) ||
    ''
  const line = firstLine(raw, 60)
  if (!line) return `${agentName} sample`
  return line
}
