import type { AgentNode } from '../../engine'
import { recoverTaskVariables } from '../../eval/from-run'
import type { EvalSampleInput, WfRunStepDTO } from '../../server/protocol'
import { firstLine, previewText } from '../text-preview'

// ── Given reconstruction ──────────────────────────────────────────────────────

// Rebuild the sample's initial condition from the node's execution. The
// recovery itself lives in `eval/from-run`, shared with the MCP server's
// `draft_sample_from_run` — two surfaces reconstructing the same thing from the
// same trace must not do it two ways.
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
  return {
    kind: 'task',
    variables: recoverTaskVariables(node, step, steps, inputVariables),
  }
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
