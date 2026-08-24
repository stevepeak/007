import type { AgentConfig } from './agent-config-schema'

// Which fields of an agent config differ between two versions of it, named the
// way a person would name them.
//
// This lives in `engine` — the bottom layer — because BOTH ends of the stack ask
// the same question and their answers have to agree. The editor asks it to tell
// you a playground result is stale ("model, system prompt"), and the change log
// asks it to record what a publish actually moved. Two tables would drift, and
// the drift would show up as an audit row that disagrees with the UI that
// produced it.
//
// A pure label table imports nothing, so it sits here without straining the rule
// that engine depends only on `ai` and `zod`.

/** The fields worth naming, in the order the editor shows them. */
export const CONFIG_FIELDS: { key: keyof AgentConfig; label: string }[] = [
  { key: 'modelId', label: 'model' },
  { key: 'prompt', label: 'system prompt' },
  { key: 'userPrompt', label: 'user message' },
  { key: 'toolIds', label: 'tools' },
  { key: 'subAgents', label: 'sub-agents' },
  { key: 'output', label: 'output' },
  { key: 'maxTurns', label: 'max turns' },
  { key: 'toolTokenBudget', label: 'token budget' },
  { key: 'answerReservePercent', label: 'answer reserve' },
  { key: 'requireToolFirstTurn', label: 'tool-first' },
  { key: 'inputKind', label: 'input kind' },
]

/** Human labels for every field that differs between two configs. */
export function changedFields(a: AgentConfig, b: AgentConfig): string[] {
  return CONFIG_FIELDS.filter(
    (f) => JSON.stringify(a[f.key]) !== JSON.stringify(b[f.key]),
  ).map((f) => f.label)
}
