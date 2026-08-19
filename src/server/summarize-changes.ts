import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'

import type { RunContext } from '../engine/config'
import type { AgentConfig, WorkflowGraph } from '../engine/graph'

import type { WfChangeSummary } from './protocol'

// The AI change summarizer — owned by the SDK so every host gets git-style
// publish summaries for free. It stays provider-agnostic: the host's `getModel`
// resolves the model (and reads its own live bindings out of the RunContext's
// `env`), so the only thing the host supplies is the same model seam it already
// wires for agent nodes. Nothing here knows about OpenRouter, API keys, etc.
//
// Both versioned entities go through it. Everything except *what a change means*
// — the JSON payload shaping and the domain sentence in the prompt — is shared,
// so `summarizeWorkflowChanges` and `summarizeAgentChanges` are thin wrappers
// over `summarizePayloadChanges` rather than two copies that drift.

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

// Salvage a summary from a model that answered in prose instead of JSON.
//
// This is a commit-message task, and a reasoning model asked for one will often
// return exactly the right content in exactly the wrong envelope — a fenced
// markdown block holding a subject line and a body, which is a git commit
// message, not the `{short, long}` object the schema asked for. `generateObject`
// throws `AI_NoObjectGeneratedError` on it and the whole summary is lost despite
// the model having done the work correctly.
//
// So: peel the envelope, and if what's inside still isn't JSON, read it as what
// it plainly is — first line as the subject, the rest as the body.
export function repairSummaryText(text: string): string | null {
  let body = text.trim()

  // Inlined reasoning (see the Venice `<think>` handling in the host's
  // `getModel`) sits in front of the answer. Drop it before anything else.
  body = body.replace(/^<think>[\s\S]*?<\/think>/i, '').trim()

  // Strip one wrapping code fence, with or without a language tag.
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(body)
  if (fenced) body = fenced[1].trim()

  if (!body) return null

  // The envelope may have been the only problem.
  try {
    JSON.parse(body)
    return body
  } catch {
    // Not JSON — fall through and read it as a commit message.
  }

  const lines = body.split('\n')
  const firstIdx = lines.findIndex((l) => l.trim().length > 0)
  if (firstIdx === -1) return null
  const short = lines[firstIdx].trim().replace(/\.$/, '')
  const long = lines
    .slice(firstIdx + 1)
    .join('\n')
    .trim()
  return JSON.stringify({ short, long })
}

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

/** What the model factory and the prompt need, minus anything domain-specific. */
type SummarizeSeam = {
  /** The host's model factory (from `WfSdkConfig.getModel`). */
  getModel: (modelId: string, ctx: RunContext) => LanguageModel
  /** Which model to summarize with (defaults to the host's first offered model). */
  modelId: string
  /** The host's live bindings, passed through to `getModel`. Opaque to the SDK. */
  env: unknown
}

/**
 * The shared summarizer. `intro` names the thing being changed and `guidance`
 * says what counts as a meaningful change in that domain; `previous` / `next`
 * are the already-shaped payloads (callers strip their own cosmetic noise).
 */
async function summarizePayloadChanges(
  input: SummarizeSeam & {
    intro: string
    guidance: string
    /** `null` means "no previous version"; any other value is the payload. */
    previous: unknown
    next: unknown
  },
): Promise<WfChangeSummary> {
  const model = input.getModel(input.modelId, {
    triggerKind: '__summarize__',
    // Internal utility call — a one-line changelog wants a direct answer, not a
    // reasoning pass. `reasoning: false` is the explicit, provider-agnostic
    // signal the host honors; it replaces the host having to sniff triggerKind.
    reasoning: false,
    env: input.env,
    promptVariables: {},
  })

  const previous =
    input.previous === null
      ? 'none (this is the first published version)'
      : JSON.stringify(input.previous)
  const next = JSON.stringify(input.next)

  const { object } = await generateObject({
    model,
    schema: summarySchema,
    // See `repairSummaryText`: models routinely return this particular task's
    // answer as a markdown-fenced commit message rather than JSON.
    repairText: ({ text }) => Promise.resolve(repairSummaryText(text)),
    prompt: [
      input.intro,
      '',
      'Compare the PREVIOUS and NEXT versions and summarize what changed for a',
      `human reviewer. ${input.guidance} Be specific but brief.`,
      '',
      `PREVIOUS:\n${previous}`,
      '',
      `NEXT:\n${next}`,
    ].join('\n'),
  })

  return object
}

export async function summarizeWorkflowChanges(
  input: SummarizeSeam & {
    previousGraph: WorkflowGraph | null
    nextGraph: WorkflowGraph
  },
): Promise<WfChangeSummary> {
  return await summarizePayloadChanges({
    ...input,
    intro: [
      'You are writing a git-style commit message describing a change to an',
      'automation workflow — a graph of nodes (triggers, tools, agents,',
      'branches, outputs) connected by edges.',
    ].join('\n'),
    guidance:
      'Focus on meaningful behavioral changes (nodes added, removed, or ' +
      'reconfigured; tools or agents swapped; branching/logic changes) and ' +
      'ignore cosmetic canvas moves.',
    previous: input.previousGraph ? describeGraph(input.previousGraph) : null,
    next: describeGraph(input.nextGraph),
  })
}

// Unlike a graph, an agent config has no cosmetic noise to strip: name, icon and
// color live on the entity row, not in the versioned config, so every field here
// is behavior and the whole object goes to the model as-is.
export async function summarizeAgentChanges(
  input: SummarizeSeam & {
    previousConfig: AgentConfig | null
    nextConfig: AgentConfig
  },
): Promise<WfChangeSummary> {
  return await summarizePayloadChanges({
    ...input,
    intro: [
      'You are writing a git-style commit message describing a change to an AI',
      'agent — its model, system prompt, user prompt, tools, turn and token',
      'budgets, output contract, and the agents it may delegate to.',
    ].join('\n'),
    guidance:
      'Focus on meaningful behavioral changes (model swapped; instructions ' +
      'added, removed or reworded; tools granted or revoked; turn or token ' +
      'budgets changed; output contract or input kind changed; delegation ' +
      'targets changed). When the prompt text changed, say what it now does ' +
      'differently rather than quoting it.',
    previous: input.previousConfig,
    next: input.nextConfig,
  })
}
