import { tool, type Tool } from 'ai'

import {
  agentFromManifest,
  inferPromptVariables,
  type SubAgentsConfig,
  type SubAgentTarget,
  substitutePromptVariables,
  workflowFromManifest,
} from '../graph'
import { errorMessage, type RunNodeContext } from '../run-node'
import { buildAgentToolSet } from '../tool-registry'

import { coerceToMessages, runAgentGeneration } from './agent'
import { executeSubgraph } from './iteration'
import {
  type RunSubAgent,
  SpawnManager,
  type SpawnRunResult,
} from './spawn-manager'
import {
  AWAIT_TOOL_NAME,
  awaitDescription,
  awaitInputSchema,
  CHECK_TOOL_NAME,
  checkDescription,
  checkInputSchema,
  SIGNAL_STOP_TOOL_NAME,
  signalStopDescription,
  signalStopInputSchema,
  spawnDescription,
  spawnInputSchema,
  synthesizeTargets,
} from './sub-agent-tools'

// The engine side of sub-agent delegation. Given the primary agent node's run
// context, this builds the live `spawn_*` / `await_subagents` / `check_subagents`
// tool set backed by a {@link SpawnManager}, and runs each spawned sub-agent /
// sub-workflow INLINE (inside the primary agent's durable step) via the same
// `executeSubgraph` machinery iteration and the workflow node use. Each sub-run
// is recorded as a child run-step under the primary node so the run viewer can
// drill into it (the iteration per-item precedent).

/** What the agent node hands here: its full run context + its own node id. */
export type SubAgentCtx<TDeps> = {
  ctx: RunNodeContext<TDeps>
  primaryNodeId: string
}

// The `spawn_*` input for an agent target is `{ message, ...promptVars }`; for a
// workflow target it is `{ input }`. Normalize both into what the runner needs.
function agentSpawnInput(input: unknown): {
  message: string
  vars: Record<string, string>
} {
  const obj = (input ?? {}) as Record<string, unknown>
  const message =
    typeof obj.message === 'string'
      ? obj.message
      : JSON.stringify(obj.message ?? obj ?? '')
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'message' && v != null) {
      vars[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
  }
  return { message, vars }
}

async function runAgentTarget<TDeps>(
  target: SubAgentTarget,
  input: unknown,
  ordinal: number,
  sub: SubAgentCtx<TDeps>,
  allowStopSignal: boolean,
): Promise<SpawnRunResult> {
  const { ctx, primaryNodeId } = sub
  const entry = agentFromManifest(ctx.manifest ?? [], target.id, target.version ?? null)
  if (!entry) {
    const at = target.version ? `v${target.version}` : 'latest'
    throw new Error(
      `Sub-agent target ${target.id} (${at}) is not in the run manifest.`,
    )
  }
  const config = entry.config
  const model = ctx.getModel(config.modelId)

  // The sub-agent's own registry tools, plus the injected stop signal. A sub-
  // agent does NOT itself get delegation tools (spawning is one level deep per
  // primary step) — `buildAgentToolSet` only resolves the registry.
  const tools = buildAgentToolSet(ctx.toolRegistry, config.toolIds, ctx.toolDeps, {
    simulate: ctx.simulate,
    fixtures: ctx.fixtures,
  })
  let stopSignalled = false
  let reason: string | undefined
  const toolSet: Record<string, Tool> = { ...tools }
  if (allowStopSignal && config.output.kind === 'text') {
    toolSet[SIGNAL_STOP_TOOL_NAME] = tool({
      description: signalStopDescription(),
      inputSchema: signalStopInputSchema(),
      execute: (args) => {
        stopSignalled = true
        const r = (args as { reason?: unknown }).reason
        reason = typeof r === 'string' ? r : ''
        return Promise.resolve({ acknowledged: true })
      },
    })
  }

  const { message, vars: spawnVars } = agentSpawnInput(input)
  const vars = { ...ctx.promptVariables, ...spawnVars }
  const systemPrompt = substitutePromptVariables(config.prompt, vars)
  const messages = coerceToMessages(message)

  const result = await runAgentGeneration({
    model,
    modelId: config.modelId,
    output: config.output,
    maxTurns: config.maxTurns,
    exposeThinking: config.exposeThinking,
    systemPrompt,
    messages,
    tools: toolSet,
    sink: ctx.sink,
  })

  // Fallback stop channel for object/boolean sub-agents (no tool loop): a
  // reserved `__stop` field in the structured output.
  if (
    !stopSignalled &&
    (config.output.kind === 'object' || config.output.kind === 'boolean')
  ) {
    const o = result.output as Record<string, unknown>
    if (o && o.__stop) {
      stopSignalled = true
      reason = typeof o.reason === 'string' ? o.reason : undefined
    }
  }

  if (ctx.subStepRecorder) {
    await ctx.subStepRecorder.record({
      nodeId: `sub:${primaryNodeId}:${ordinal}`,
      nodeKind: 'agent',
      parentNodeId: primaryNodeId,
      itemIndex: ordinal,
      sequence: 0,
      input: message,
      status: 'completed',
      output: result.output,
      meta: { ...result.meta, subAgentName: entry.name },
    })
  }

  return { output: result.output, meta: result.meta, stopSignalled, reason }
}

async function runWorkflowTarget<TDeps>(
  target: SubAgentTarget,
  input: unknown,
  ordinal: number,
  sub: SubAgentCtx<TDeps>,
): Promise<SpawnRunResult> {
  const { ctx, primaryNodeId } = sub
  const entry = workflowFromManifest(ctx.manifest ?? [], target.id)
  if (!entry) {
    throw new Error(
      `Sub-workflow target ${target.id} is not in the run manifest.`,
    )
  }
  const obj = (input ?? {}) as Record<string, unknown>
  const triggerInput = 'input' in obj ? obj.input : obj
  // Fresh output cache; record inner nodes as children of the primary node.
  const childCtx: RunNodeContext<TDeps> = {
    ...ctx,
    nodeOutputs: new Map(),
    subStepRecorder: undefined,
  }
  const record = ctx.subStepRecorder
    ? {
        recorder: ctx.subStepRecorder,
        parentNodeId: primaryNodeId,
        itemIndex: ordinal,
      }
    : undefined
  const output = await executeSubgraph(entry.graph, triggerInput, childCtx, record)
  return { output, stopSignalled: false }
}

function makeRunSubAgent<TDeps>(
  sub: SubAgentCtx<TDeps>,
  allowStopSignal: boolean,
): RunSubAgent {
  return async (target, input, ordinal) => {
    try {
      return target.kind === 'workflow'
        ? await runWorkflowTarget(target, input, ordinal, sub)
        : await runAgentTarget(target, input, ordinal, sub, allowStopSignal)
    } catch (err) {
      // An agent target self-records its child step only on success; record a
      // failed one here so the trace shows the break. Workflow targets record
      // their own inner failed step via `executeSubgraph`.
      if (target.kind === 'agent' && sub.ctx.subStepRecorder) {
        await sub.ctx.subStepRecorder
          .record({
            nodeId: `sub:${sub.primaryNodeId}:${ordinal}`,
            nodeKind: 'agent',
            parentNodeId: sub.primaryNodeId,
            itemIndex: ordinal,
            sequence: 0,
            input,
            status: 'failed',
            error: errorMessage(err),
          })
          .catch(() => {})
      }
      throw err
    }
  }
}

/**
 * Build the delegation tool set for a primary agent whose config whitelists
 * sub-agents/workflows. Returns `spawn_*` tools (one per target, named &
 * documented from the target), plus the shared `await_subagents` and
 * `check_subagents` tools — all backed by one {@link SpawnManager} for this node
 * execution. Empty when the whitelist is empty.
 */
export function synthesizeDelegationTools<TDeps>(
  subAgents: SubAgentsConfig,
  sub: SubAgentCtx<TDeps>,
): Record<string, Tool> {
  if (subAgents.targets.length === 0) return {}
  const manifest = sub.ctx.manifest ?? []
  const infos = synthesizeTargets(subAgents.targets, (target) => {
    if (target.kind === 'agent') {
      const e = agentFromManifest(manifest, target.id, target.version ?? null)
      return {
        displayName: e?.name || target.id,
        promptVariables: e ? inferPromptVariables(e.config.prompt) : [],
      }
    }
    const e = workflowFromManifest(manifest, target.id)
    return { displayName: e?.name || target.id }
  })

  const runSubAgent = makeRunSubAgent(sub, subAgents.allowStopSignal)
  const manager = new SpawnManager({
    maxConcurrent: subAgents.maxConcurrent,
    maxSpawns: subAgents.maxSpawns,
    runSubAgent,
  })

  const tools: Record<string, Tool> = {}
  for (const info of infos) {
    tools[info.toolName] = tool({
      description: spawnDescription(info),
      inputSchema: spawnInputSchema(info),
      execute: (args) => Promise.resolve(manager.spawn(info.target, args)),
    })
  }
  tools[AWAIT_TOOL_NAME] = tool({
    description: awaitDescription(),
    inputSchema: awaitInputSchema(),
    execute: (args) => manager.join((args as { spawnIds?: string[] }).spawnIds),
  })
  tools[CHECK_TOOL_NAME] = tool({
    description: checkDescription(),
    inputSchema: checkInputSchema(),
    execute: () => Promise.resolve({ spawns: manager.check() }),
  })
  return tools
}
