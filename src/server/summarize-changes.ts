import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'

import type { RunContext } from '../engine/config'
import type { WorkflowGraph } from '../engine/graph'

import type { WfChangeSummary } from './protocol'

// The AI change summarizer — owned by the SDK so every host gets git-style
// publish summaries for free. It stays provider-agnostic: the host's `getModel`
// resolves the model (and reads its own live bindings out of the RunContext's
// `env`), so the only thing the host supplies is the same model seam it already
// wires for agent nodes. Nothing here knows about OpenRouter, API keys, etc.

const summarySchema = z.object({
  short: z
    .string()
    .describe(
      'A concise one-line subject in the imperative mood, like a git commit subject. No trailing period.',
    ),
  long: z
    .string()
    .describe(
      'An optional longer body: a few "-" bullet points of the notable changes. Empty string if the change is trivial.',
    ),
})

// Positions are cosmetic (canvas layout) and would just be noise to the model —
// strip them so the diff the model sees is purely behavioral.
function describeGraph(graph: WorkflowGraph) {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      config: n.config,
    })),
    edges: graph.edges.map((e) => ({
      source: e.source,
      target: e.target,
      condition: e.condition,
    })),
  }
}

export async function summarizeWorkflowChanges(input: {
  /** The host's model factory (from `WfSdkConfig.getModel`). */
  getModel: (modelId: string, ctx: RunContext) => LanguageModel
  /** Which model to summarize with (defaults to the host's first offered model). */
  modelId: string
  /** The host's live bindings, passed through to `getModel`. Opaque to the SDK. */
  env: unknown
  previousGraph: WorkflowGraph | null
  nextGraph: WorkflowGraph
}): Promise<WfChangeSummary> {
  const model = input.getModel(input.modelId, {
    triggerKind: '__summarize__',
    // Internal utility call — a one-line changelog wants a direct answer, not a
    // reasoning pass. `reasoning: false` is the explicit, provider-agnostic
    // signal the host honors; it replaces the host having to sniff triggerKind.
    reasoning: false,
    env: input.env,
    promptVariables: {},
  })

  const previous = input.previousGraph
    ? JSON.stringify(describeGraph(input.previousGraph))
    : 'none (this is the first published version)'
  const next = JSON.stringify(describeGraph(input.nextGraph))

  const { object } = await generateObject({
    model,
    schema: summarySchema,
    prompt: [
      'You are writing a git-style commit message describing a change to an',
      'automation workflow — a graph of nodes (triggers, tools, agents,',
      'branches, outputs) connected by edges.',
      '',
      'Compare the PREVIOUS and NEXT versions and summarize what changed for a',
      'human reviewer. Focus on meaningful behavioral changes (nodes added,',
      'removed, or reconfigured; tools or agents swapped; branching/logic',
      'changes) and ignore cosmetic canvas moves. Be specific but brief.',
      '',
      `PREVIOUS:\n${previous}`,
      '',
      `NEXT:\n${next}`,
    ].join('\n'),
  })

  return object
}
