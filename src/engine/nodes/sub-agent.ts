import { tool, type Tool } from 'ai'

import {
  agentFromManifest,
  inferPromptVariables,
  type SubAgentsConfig,
  type SubAgentTarget,
  workflowFromManifest,
} from '../graph'
import type { RunNodeContext } from '../run-node'
import {
  stepRowFor,
  type RecordStepArgs,
  type StepOutcome,
} from '../run-recorder'
import { toText } from '../text'

import { coerceToMessages, runAgentConfig } from './agent'
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

/**
 * What the EXECUTOR can supply: the run context plus the primary node's id. It
 * deliberately stops there — the executor doesn't resolve `informUser`, so it
 * can't know what the step surfaces.
 */
export type SubAgentRunCtx<TDeps> = {
  ctx: RunNodeContext<TDeps>
  primaryNodeId: string
}

/**
 * The full context this module consumes: {@link SubAgentRunCtx} plus the display
 * intent resolved from the primary node's `informUser`. The agent node fills the
 * two stream flags in, which is why they're required here and absent above — the
 * split makes "forgot to pass the author's choice down" a type error.
 *
 * A sub-agent has no node of its own, so it has no `informUser` to read. It
 * INHERITS the primary node's choice: delegation is an implementation detail of
 * the parent step, and the author picked what that step surfaces. Reading the
 * sub-agent's own stored config here would let a field the editor never writes
 * override an explicit authoring decision.
 */
export type SubAgentCtx<TDeps> = SubAgentRunCtx<TDeps> & {
  streamReasoning: boolean
  streamToolCalls: boolean
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
      vars[k] = toText(v)
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
  let stopSignalled = false
  let reason: string | undefined
  // A sub-agent does NOT itself get delegation tools (spawning is one level
  // deep per primary step) — only its registry tools, plus the stop signal.
  const extraTools: Record<string, Tool> = {}
  if (allowStopSignal && config.output.kind === 'text') {
    extraTools[SIGNAL_STOP_TOOL_NAME] = tool({
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

  // Bracket the sub-agent generation so the child step's Speed reflects real
  // work. Runs inline within the primary node's step, so wall-clock is exact.
  const startedAt = new Date()
  const result = await runAgentConfig({
    config,
    // The sub-agent's OWN config decides its model and whether it reasons; it
    // inherits the parent's display choice, never its thinking budget.
    modelId: config.modelId,
    reasoning: config.reasoning,
    promptTemplate: config.prompt,
    vars: { ...ctx.promptVariables, ...spawnVars },
    messages: coerceToMessages(message),
    // It runs its own conversation against its own model, so it guards against
    // ITS window, taken from its own frozen manifest entry.
    contextLength: entry.contextLength,
    // Inherited from the primary node's `informUser` — see {@link SubAgentCtx}.
    stream: { reasoning: sub.streamReasoning, toolCalls: sub.streamToolCalls },
    label: `Sub-agent ${target.id}`,
    extraTools,
    // Runs inline inside the primary node's step, so it shares that node's
    // model budget. Never frozen: freezeTools suppresses delegation entirely.
    ctx: { ...ctx, freezeTools: false },
  })

  // Fallback stop channel for object/boolean sub-agents, which don't get the
  // stop TOOL above (a one-turn structured sub-agent never calls tools, and a
  // strict schema can't carry a tool's side effect): a reserved `__stop` field
  // in the structured output.
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
    await ctx.subStepRecorder.record(
      subAgentStepRow({
        primaryNodeId,
        ordinal,
        input: message,
        startedAt,
        outcome: {
          ok: true,
          result: {
            recordedOutput: result.output,
            // Stamped with the agent it ran, like a top-level agent node — a
            // spawned sub-agent has no graph node of its own, so this is the
            // ONLY link from its step back to the agent (see
            // AgentNodeMeta.agentId).
            meta: {
              ...result.meta,
              agentId: target.id,
              agentVersion: entry.versionNumber,
              subAgentName: entry.name,
            },
          },
        },
      }),
    )
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

/**
 * A spawned agent's child step: keyed under the primary node by spawn ordinal,
 * since it has no graph node of its own.
 */
function subAgentStepRow(args: {
  primaryNodeId: string
  ordinal: number
  input: unknown
  startedAt?: Date
  outcome: StepOutcome
}): RecordStepArgs {
  return {
    ...stepRowFor({
      node: { id: `sub:${args.primaryNodeId}:${args.ordinal}`, kind: 'agent' },
      sequence: 0,
      input: args.input,
      startedAt: args.startedAt,
      outcome: args.outcome,
    }),
    parentNodeId: args.primaryNodeId,
    itemIndex: args.ordinal,
  }
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
          .record(
            subAgentStepRow({
              primaryNodeId: sub.primaryNodeId,
              ordinal,
              input,
              outcome: { ok: false, error: err },
            }),
          )
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
