import type { AgentConfig, WorkflowGraph } from '../../engine/graph'
import { errorMessage } from '../../engine/run-node'
import type { WfChangeSummary } from '../protocol'
import {
  summarizeAgentChanges,
  summarizeWorkflowChanges,
} from '../summarize-changes'

import type { CreateWfSdkHandlersOptions, WfServerContext } from './shared'

// ---------------------------------------------------------------------------
// Change summaries for a publish
// ---------------------------------------------------------------------------
//
// Shared by both versioned entities. The resolution order and the failure
// posture are the interesting part and must stay identical for workflows and
// agents: a summary is decorative metadata on a publish, so nothing in here is
// ever allowed to fail the publish it describes.

const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`

function sentence(parts: string[], whenEmpty: string): WfChangeSummary {
  if (parts.length === 0) return { short: whenEmpty, long: '' }
  const joined = parts.join(', ')
  return {
    short: joined.charAt(0).toUpperCase() + joined.slice(1) + '.',
    long: '',
  }
}

// Fallback change summary when no model is available: a plain count of
// structural deltas between the last published version and the graph to publish.
export function heuristicChangeSummary(
  prev: WorkflowGraph | null,
  next: WorkflowGraph,
): WfChangeSummary {
  if (!prev) return { short: 'Initial version.', long: '' }
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]))
  const added = [...nextNodes.keys()].filter((id) => !prevNodes.has(id)).length
  const removed = [...prevNodes.keys()].filter(
    (id) => !nextNodes.has(id),
  ).length
  let edited = 0
  for (const [id, nn] of nextNodes) {
    const pn = prevNodes.get(id)
    if (!pn) continue
    if (
      JSON.stringify({ l: pn.label, c: pn.config }) !==
      JSON.stringify({ l: nn.label, c: nn.config })
    ) {
      edited++
    }
  }
  const edgeDelta = next.edges.length - prev.edges.length
  const parts: string[] = []
  if (added) parts.push(`added ${plural(added, 'node')}`)
  if (removed) parts.push(`removed ${plural(removed, 'node')}`)
  if (edited) parts.push(`edited ${plural(edited, 'node')}`)
  if (edgeDelta > 0) parts.push(`added ${plural(edgeDelta, 'connection')}`)
  else if (edgeDelta < 0)
    parts.push(`removed ${plural(-edgeDelta, 'connection')}`)
  return sentence(parts, 'No structural changes.')
}

// The agent counterpart. An agent has no nodes to count, so the structural
// delta is field-level: which parts of the contract moved. Tools are the one
// collection worth counting in and out; everything else is changed-or-not.
export function heuristicAgentChangeSummary(
  prev: AgentConfig | null,
  next: AgentConfig,
): WfChangeSummary {
  if (!prev) return { short: 'Initial version.', long: '' }
  const parts: string[] = []
  if (prev.modelId !== next.modelId) parts.push('changed the model')
  if (prev.prompt !== next.prompt) parts.push('edited the prompt')
  if (prev.userPrompt !== next.userPrompt) parts.push('edited the user prompt')

  const prevTools = new Set(prev.toolIds)
  const nextTools = new Set(next.toolIds)
  const toolsAdded = next.toolIds.filter((t) => !prevTools.has(t)).length
  const toolsRemoved = prev.toolIds.filter((t) => !nextTools.has(t)).length
  if (toolsAdded) parts.push(`added ${plural(toolsAdded, 'tool')}`)
  if (toolsRemoved) parts.push(`removed ${plural(toolsRemoved, 'tool')}`)

  if (prev.maxTurns !== next.maxTurns) parts.push('changed the turn limit')
  if (prev.inputKind !== next.inputKind) parts.push('changed the input kind')
  if (JSON.stringify(prev.output) !== JSON.stringify(next.output)) {
    parts.push('changed the output contract')
  }
  if (JSON.stringify(prev.subAgents) !== JSON.stringify(next.subAgents)) {
    parts.push('changed delegation')
  }
  return sentence(parts, 'No configuration changes.')
}

/**
 * Resolve the model to summarize with: the host's explicit choice, else the
 * first model it offers. `null` when the host offers none, in which case the
 * caller falls back to its heuristic.
 */
async function summaryModelId<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
  env: unknown,
): Promise<string | null> {
  return (
    opts.summaryModelId ?? (await opts.config.listModels({ env }))[0]?.id ?? null
  )
}

// A change summary is decorative metadata on a publish. Letting the model call
// fail the request means an unparseable response — or a provider being down —
// blocks publishing, which is absurd for a feature whose whole job is to write a
// nicer sentence than the heuristic does. Fall through to the structural
// summary and log the reason.
function warnFallback(err: unknown): void {
  console.warn(
    '[wf] AI change summary failed; falling back to the structural summary:',
    errorMessage(err),
  )
}

// One place that resolves a workflow change summary. Order of precedence:
//   1. a host `summarizeChanges` override (rare — most hosts don't set it),
//   2. the SDK's own AI summarizer via the host's `getModel` seam (the default),
//   3. a structural heuristic when no model is available.
// Used by the `summarizeChanges` method and by the background summary generated
// when a version is published before its summary is ready. `env` is resolved by
// the caller (inside the request scope) and passed through to `getModel`.
export async function computeChangeSummary<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
  input: {
    previousGraph: WorkflowGraph | null
    nextGraph: WorkflowGraph
    ctx: WfServerContext
    req: Request
    env: unknown
  },
): Promise<WfChangeSummary> {
  if (opts.summarizeChanges) {
    return await opts.summarizeChanges({
      previousGraph: input.previousGraph,
      nextGraph: input.nextGraph,
      ctx: input.ctx,
      req: input.req,
    })
  }
  const modelId = await summaryModelId(opts, input.env)
  if (modelId) {
    try {
      return await summarizeWorkflowChanges({
        getModel: opts.config.getModel,
        modelId,
        env: input.env,
        previousGraph: input.previousGraph,
        nextGraph: input.nextGraph,
      })
    } catch (err) {
      warnFallback(err)
    }
  }
  return heuristicChangeSummary(input.previousGraph, input.nextGraph)
}

/**
 * The agent twin. Same precedence and same never-fail posture; the host override
 * is `summarizeAgentChanges`, kept separate from the workflow one because the
 * payload a host would inspect is a different shape.
 */
export async function computeAgentChangeSummary<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
  input: {
    previousConfig: AgentConfig | null
    nextConfig: AgentConfig
    ctx: WfServerContext
    req: Request
    env: unknown
  },
): Promise<WfChangeSummary> {
  if (opts.summarizeAgentChanges) {
    return await opts.summarizeAgentChanges({
      previousConfig: input.previousConfig,
      nextConfig: input.nextConfig,
      ctx: input.ctx,
      req: input.req,
    })
  }
  const modelId = await summaryModelId(opts, input.env)
  if (modelId) {
    try {
      return await summarizeAgentChanges({
        getModel: opts.config.getModel,
        modelId,
        env: input.env,
        previousConfig: input.previousConfig,
        nextConfig: input.nextConfig,
      })
    } catch (err) {
      warnFallback(err)
    }
  }
  return heuristicAgentChangeSummary(input.previousConfig, input.nextConfig)
}
