import { resolveBinding } from '../binding'
import { decisionAgentReasoning, runDecisionAgent } from '../decision-agent'
import type { AgentNode, Decider, DecisionUsage, DecisionVerdict } from '../graph'
import {
  decisionAgentFromManifest,
  type WfRunManifestEntry,
} from '../run-manifest'

import { resolveNodeInputs } from './agent-inputs'

// An agent node whose `agentId` names a DECISION agent.
//
// A decision agent is ONE provider call — no prompt, no tool loop — so it does
// not go through `executeAgentNode`'s generation machinery; `runNode` asks the
// manifest which kind the node points at and sends it here instead. The agent
// owns the questions, thresholds, verdicts and rollup rules; the node
// contributes only the subject (`config.source`, else the incoming input) and
// the `${variables}` its `inputs` bind.
//
// Like Branch and Switch it does NOT forward its input: the output IS the
// judgment, so a downstream ref to the node yields `{ answers, reasoning,
// verdict, because }`, and a Switch routes on `verdict`.

export type DecisionAgentNodeResult = {
  /** Verdict per question id — what refs address as `answers.<id>.value`. */
  answers: Record<string, DecisionVerdict>
  /** How every question was answered, one line, for the run record. */
  reasoning: string
  /** The rolled-up verdict — the first matching rule's. Never absent. */
  verdict: string
  /** Which rule fired and what it read. */
  because: string
  /** What actually answered, for the run record. */
  modelId?: string
  usage?: DecisionUsage
}

export type DecisionAgentNodeMeta = {
  modelId?: string
  /** Question ids asked, in order — enough to read a step without its config. */
  questionIds: string[]
  usage?: DecisionUsage
  /**
   * The decision agent this node ran, and the exact version of it. Recorded on
   * the step for the same reason a generation agent node records its version:
   * "which questions did this actually ask" is otherwise unanswerable once the
   * agent has been republished.
   */
  agentId: string
  agentName: string
  agentVersion: number
}

export type ExecuteDecisionAgentNodeArgs = {
  node: AgentNode
  /** The prior node's output — judged when the node has no `source` ref. */
  input: unknown
  nodeOutputs: Map<string, unknown>
  /** Resolves the decision agent's `modelId` to a decider. Bound by the dispatcher. */
  getDecider: (modelId: string) => Decider
  /**
   * The frozen run manifest, which is where `config.agentId` is resolved — the
   * node never reads a live agent row, so republishing an agent mid-run cannot
   * change what this node asks.
   */
  manifest: readonly WfRunManifestEntry[]
  /**
   * Deep-rehydrates blob-ref values before the state is judged. Without it a
   * spilled upstream output (a whole extracted document, which is exactly the
   * kind of thing worth judging) would be sent as its POINTER — and the provider
   * would confidently answer questions about a JSON blob reference.
   */
  rehydrate?: (value: unknown) => Promise<unknown>
}

/** Does this agent node point at a decision agent in the frozen manifest? */
export function isDecisionAgentNode(
  node: AgentNode,
  manifest: readonly WfRunManifestEntry[],
): boolean {
  return (
    decisionAgentFromManifest(
      manifest,
      node.config.agentId,
      node.config.version,
    ) != null
  )
}

export async function executeDecisionAgentNode(
  deps: ExecuteDecisionAgentNodeArgs,
): Promise<{
  result: DecisionAgentNodeResult
  meta: DecisionAgentNodeMeta
}> {
  const { node, input, nodeOutputs, getDecider, rehydrate, manifest } = deps
  const { agentId, version, source } = node.config

  const entry = decisionAgentFromManifest(manifest, agentId, version)
  if (!entry) {
    throw new Error(
      `Agent node ${node.id} references decision agent ${agentId || '(none)'}, which is not in this run's manifest. Publish a version of it, then republish this workflow so the reference resolves.`,
    )
  }

  const subject = source
    ? resolveBinding(source, nodeOutputs, { nodeId: node.id, name: 'source' })
    : input

  // Delegated to the very same `runDecisionAgent` the playground and the eval
  // cell call — a verdict that passed its Goal and a verdict that routes
  // production must come off one code path, or the suite grades something the
  // graph does not run.
  const r = await runDecisionAgent({
    config: entry.config,
    state: subject,
    variables: await resolveNodeInputs(node, nodeOutputs, rehydrate),
    getDecider,
    rehydrate,
  })
  return {
    result: {
      answers: r.answers,
      reasoning: decisionAgentReasoning(r),
      verdict: r.verdict,
      because: r.because,
      modelId: r.modelId,
      usage: r.usage,
    },
    meta: {
      modelId: r.modelId,
      questionIds: Object.keys(r.answers),
      usage: r.usage,
      agentId,
      agentName: entry.name,
      agentVersion: entry.versionNumber,
    },
  }
}
