import { z } from 'zod'

import {
  agentNodeFor,
  agentStepsOf,
  draftSampleFromRun,
  type RunDraftFeedback,
  type RunDraftLayer,
} from '../eval/from-run'
import type { WfDataClient } from '../server/protocol'

import { optString, reqString, type WfMcpTool } from './tools'

// `draft_sample_from_run` — the reason this MCP server is worth more than the
// eval editor's own "Create sample" button.
//
// Samples invented from nothing test what someone imagined might go wrong.
// Samples mined from `list_feedback` test what actually did: a real input, the
// real context the agent had, and a human who said the answer was bad. This
// tool does the conversion and hands back a DRAFT — it deliberately does not
// write, so a bad conversion is something you read rather than something you
// find in a Goal a week later. The model reviews it, rewrites the rubric, and
// calls `upsert_eval_sample`.
//
// Singular, unlike the name in the ticket: a run has several agent steps and
// they are different agents with different contracts, so one call drafts one
// sample and an ambiguous run answers with the choice instead of guessing.
//
// Read-only on purpose. Drafting reads a trace and returns a value; only saving
// needs `--write`.

const LAYERS: RunDraftLayer[] = ['trajectory', 'synthesis']

/** A one-line, obviously-provisional name, from whatever the sample is about. */
function draftName(agentName: string, input: unknown): string {
  const i = input as {
    kind?: string
    variables?: Record<string, string>
    turns?: { role: string; text?: string }[]
  }
  const source =
    i.kind === 'conversation'
      ? [...(i.turns ?? [])].reverse().find((t) => t.role === 'user')?.text
      : Object.values(i.variables ?? {})[0]
  const line = (source ?? '').split('\n').find((l) => l.trim().length > 0)
  if (!line) return `${agentName} sample`
  const trimmed = line.trim()
  return trimmed.length > 70 ? `${trimmed.slice(0, 69)}…` : trimmed
}

/** The customer rating on this run, if it has one. Never fatal. */
async function feedbackForRun(
  client: WfDataClient,
  runId: string,
): Promise<RunDraftFeedback | null> {
  try {
    const { rows } = await client.listFeedback({})
    const row = rows.find((r) => r.runId === runId)
    return row ? { rating: row.rating, note: row.note } : null
  } catch {
    // A host with no feedback wiring must still be able to draft from a run.
    return null
  }
}

export function draftTools(): WfMcpTool[] {
  return [
    {
      name: 'draft_sample_from_run',
      title: 'Draft an eval sample from a run',
      description: [
        'Convert one real run into a DRAFT eval Sample — the highest-value samples are mined from runs that actually failed, not invented. Nothing is written: review the draft, rewrite its judge rubric, then save it with upsert_eval_sample.',
        '',
        'Pair it with list_feedback: a thumbs-down row names the run whose answer a human called bad, and the draft made from that run is a test for exactly that failure.',
        '',
        'Two layers produce different samples from the same run, so pick one:',
        "  • trajectory (default) — the run's real tool results become `mocked` fixtures. Deterministic, and the only layer where tool_called / tool_args_match grade anything.",
        '  • synthesis — the same tool results are folded into a seeded assistant turn and the tool set is frozen, so the sample grades the answer alone with no retrieval nondeterminism. Conversation agents only.',
        '',
        'A run with several agent steps answers with the choice of steps rather than guessing; name one with `cursor`.',
      ].join('\n'),
      inputSchema: {
        runId: z
          .string()
          .describe(
            'Run id, from list_runs or list_feedback (the `runId` field).',
          ),
        layer: z
          .string()
          .nullish()
          .describe('"trajectory" (default) or "synthesis".'),
        cursor: z
          .number()
          .nullish()
          .describe(
            'Which agent step to draft from, by its `cursor`. Omit when the run has only one.',
          ),
      },
      readOnly: true,
      run: async (client, args) => {
        const runId = reqString(args.runId, 'runId')
        const requested = optString(args.layer) ?? 'trajectory'
        if (!LAYERS.includes(requested as RunDraftLayer)) {
          return {
            error: `Unknown layer "${requested}". Use "trajectory" or "synthesis".`,
          }
        }
        const layer = requested as RunDraftLayer

        const detail = await client.getRun(runId)
        if (!detail) return { error: `No run found for id ${runId}.` }

        const candidates = agentStepsOf(detail.steps)
        if (candidates.length === 0) {
          return {
            error: `Run ${runId} recorded no agent steps, so there is no agent call to build a sample from.`,
          }
        }
        const cursor = args.cursor
        let chosen = candidates[0]
        if (typeof cursor === 'number') {
          const match = candidates.find((c) => c.cursor === cursor)
          if (!match) {
            return {
              error: `Run ${runId} has no agent step with cursor ${cursor}.`,
              candidates,
            }
          }
          chosen = match
        } else if (candidates.length > 1) {
          // Not a guess to make on the caller's behalf: each step is a different
          // agent, and a sample drafted from the wrong one grades the wrong thing.
          return {
            error: `Run ${runId} has ${candidates.length} agent steps. Name one with \`cursor\`.`,
            candidates,
          }
        }
        const step = detail.steps.find((s) => s.cursor === chosen.cursor)
        if (!step)
          return { error: `Step ${chosen.cursor} vanished from the run.` }

        const node = agentNodeFor(detail.graph, step.nodeId)
        // `meta.agentId` is the durable link; the graph node is the fallback for
        // steps recorded before that stamp existed.
        const agentId = chosen.agentId ?? node?.config.agentId ?? null
        if (!agentId) {
          return {
            error: `Step ${chosen.cursor} doesn't name the agent it ran, and the run's graph no longer holds node ${step.nodeId}, so there is no target to draft against.`,
          }
        }
        const agent = await client.getAgent(agentId)
        if (!agent) {
          return {
            error: `The run's agent ${agentId} no longer exists, so a sample for it has no target.`,
          }
        }

        const feedback = await feedbackForRun(client, runId)
        const drafted = draftSampleFromRun({
          step,
          steps: detail.steps,
          node,
          target: {
            inputKind: agent.agent.inputKind,
            inputVariables: agent.agent.inputVariables,
          },
          layer,
          feedback,
        })
        if ('error' in drafted) return { error: drafted.error }

        const goals = (await client.listEvalSets({}).catch(() => []))
          .filter((s) => s.targetKind === 'agent' && s.targetId === agentId)
          .map((s) => ({ setId: s.id, name: s.name }))

        return {
          runId,
          cursor: chosen.cursor,
          layer,
          target: {
            agentId,
            agentName: agent.agent.name,
            inputKind: agent.agent.inputKind,
            ranVersion: chosen.agentVersion,
            latestVersion: agent.agent.latestVersionNumber,
          },
          feedback,
          draft: {
            name: draftName(agent.agent.name, drafted.input),
            // Provenance, kept on the row: which run this came from is the first
            // thing anyone asks of a sample that starts failing.
            description: `Drafted from run ${runId} (step ${chosen.cursor}) — ${layer} layer.`,
            input: drafted.input,
            tools: drafted.tools,
            checks: drafted.checks,
          },
          notes: drafted.notes,
          goals,
          next:
            goals.length > 0
              ? `Rewrite the rubric, then upsert_eval_sample({ setId: "${goals[0].setId}", …draft }).`
              : `No goal targets ${agent.agent.name} yet — create_eval_set({ name, targetId: "${agentId}" }) first, then upsert_eval_sample with this draft.`,
        }
      },
    },
  ]
}
