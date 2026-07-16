import type { RaceNode } from '../graph'

export type RaceNodeResult = {
  output: unknown
}

export type ExecuteRaceNodeDeps = {
  node: RaceNode
  input: unknown
}

// The Race node is a first-to-finish join. All of the "race" logic lives in the
// Scheduler: readiness flips from all-predecessors (`every`) to any-predecessor
// (`some`), and its resolved input is already the winning upstream's output (a
// single value, first-alive in declaration order). By the time execution reaches
// here the winner is decided, so the node is a pure pass-through — it forwards
// that value on unchanged, exactly like the Output bookend but non-terminal.
export function executeRaceNode(deps: ExecuteRaceNodeDeps): Promise<RaceNodeResult> {
  return Promise.resolve({ output: deps.input })
}
