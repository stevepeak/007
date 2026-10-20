import { agentModelRequirements, type AgentConfig } from './agent-config-schema'
import type { WfAgentKind } from './agent-kind'
import { unsupportedQuestionTypes, type DecisionModelOption } from './decision'
import {
  decisionAgentConfigIssues,
  type AnyAgentConfig,
  type DecisionAgentConfig,
} from './decision-agent-schema'
import { REQUIREMENT_REASON, unmetRequirements } from './model-capabilities'
import type { ModelOption } from './model-catalog'

// What an agent config needs beyond its schema to actually run — checked the
// same way wherever one is created or published (the editor's handlers and the
// MCP tools), so neither path accepts something the other refuses.
//
// Each catalog check is the same failure: an id with no foreign key. `modelId`
// is handed opaquely to the host's `getModel`/`getDecider` and `toolIds` are
// registry keys resolved at run time, so a wrong one saves, lists, and fails
// the first time the agent runs. The capability gates only fire on a model the
// catalog KNOWS lacks something — see `unmetRequirements`.
//
// NOT checked: `subAgents.targets`. Delegation names other agents by id, so it
// is a second pass by construction, and a wrong target fails on a draft.

/** Ids in an issue, capped and countable — a list to pick the right one from. */
const MAX_NAMED_IDS = 20

function nameIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_NAMED_IDS)
  const rest = ids.length - shown.length
  return rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ')
}

/** The one rendering of a decision matrix that can't run. */
export function decisionIssuesMessage(issues: readonly string[]): string {
  return `This decision agent would not run:\n${issues.map((i) => `- ${i}`).join('\n')}`
}

/**
 * Everything that stops a (schema-valid) config from running, as sentences.
 * Empty means it can run. `matrix: false` skips a decision agent's
 * completeness check — a just-created starter is deliberately incomplete — and
 * keeps only the catalog checks.
 */
export function checkAgentConfig(args: {
  kind: WfAgentKind
  config: AnyAgentConfig
  models: readonly ModelOption[]
  decisionModels: readonly DecisionModelOption[]
  toolIds: ReadonlySet<string>
  matrix: boolean
}): string[] {
  return args.kind === 'decision'
    ? checkDecision({ ...args, config: args.config as DecisionAgentConfig })
    : checkGeneration({ ...args, config: args.config as AgentConfig })
}

function checkGeneration(args: {
  config: AgentConfig
  models: readonly ModelOption[]
  toolIds: ReadonlySet<string>
}): string[] {
  const { config, models } = args
  const issues: string[] = []
  const model = models.find((m) => m.id === config.modelId)
  if (!model) {
    issues.push(
      `No enabled model has the id "${config.modelId}". Ids are composite \`provider:model\` and must be used verbatim from the model catalog — the provider-native half alone will 404. Enabled: ${nameIds(
        models.map((m) => m.id),
      )}`,
    )
  }
  const unknown = config.toolIds.filter((id) => !args.toolIds.has(id))
  if (unknown.length > 0) {
    issues.push(
      `These tool ids are not in the catalog: ${unknown.join(', ')}. An agent can only be given a registered tool.`,
    )
  }
  if (model) {
    const requirements = agentModelRequirements(config)
    const unmet = unmetRequirements(model, requirements)
    if (unmet.length > 0) {
      const capable = models
        .filter((m) => unmetRequirements(m, requirements).length === 0)
        .map((m) => m.id)
      issues.push(
        `Model "${model.id}" cannot run this agent: ${unmet
          .map((k) => REQUIREMENT_REASON[k])
          .join(', ')}. The config needs ${Object.keys(requirements)
          .filter((k) => requirements[k as keyof typeof requirements] === true)
          .join(', ')}. Models that can: ${nameIds(capable)}`,
      )
    }
  }
  return issues
}

function checkDecision(args: {
  config: DecisionAgentConfig
  decisionModels: readonly DecisionModelOption[]
  matrix: boolean
}): string[] {
  const { config, decisionModels } = args
  const issues: string[] = []
  if (args.matrix) {
    const matrix = decisionAgentConfigIssues(config)
    if (matrix.length > 0) issues.push(decisionIssuesMessage(matrix))
  }
  if (decisionModels.length === 0) {
    issues.push(
      'No decision provider is wired on this host (WfSdkConfig.listDecisionModels / getDecider), so a decision agent cannot run here.',
    )
    return issues
  }
  const model = decisionModels.find((m) => m.id === config.modelId)
  if (!model) {
    issues.push(
      `No decision model has the id "${config.modelId}". Ids are composite \`provider:model\` and come from the decision model catalog verbatim. Available: ${nameIds(
        decisionModels.map((m) => m.id),
      )}`,
    )
    return issues
  }
  // The authored questions' types, read directly: building the provider
  // questions would throw on the starter's blank prompt.
  const unsupported = unsupportedQuestionTypes(model, config.questions)
  if (unsupported.length > 0) {
    issues.push(
      `Decision model "${model.id}" cannot answer ${unsupported.join(', ')} questions. Change those questions' types, or pick a model that answers them.`,
    )
  }
  return issues
}
