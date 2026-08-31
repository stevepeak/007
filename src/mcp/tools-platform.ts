import { z } from 'zod'

import { clip } from '../server/clip'
import type { ModelOption, WfChangeDTO } from '../server/protocol'

import { boundedLimit, optString, type WfMcpTool } from './tools'

// Two tools pulled off the "extend the surface" queue, each because something
// that already shipped was unusable without it. `WfDataClient` has ~70 methods
// and exposing them all would be worse than exposing fifteen good ones — tool
// descriptions are prompt, and a bloated registry degrades selection. So the
// bar is a written reason, not coverage.
//
//   • `list_models` — `run_eval` takes a `models` array of catalog ids and
//     NOTHING told the model which ids exist. Asked to sweep two models it had
//     to recall one from training or scrape one out of a run trace, and a wrong
//     id fails at the provider after the sweep has already been launched.
//   • `list_changes` — `get_eval_run`'s drift block reports "the target agent
//     was republished since the last run". The immediate next question is who
//     changed what, and `wf_change` is the only record of it: 007 keeps no
//     per-table `updated_by`.
//
// Deliberately NOT here: `get_dashboard` (no demonstrated need yet),
// `run_tool_preview` (executes the real tool against live services), and the
// agent write path (`update_agent_draft` / `publish_agent`), which is the
// endgame and wants its own ticket.

/** A change's `before`/`after` can be a whole agent config or workflow graph. */
const CHANGE_PAYLOAD_CHARS = 1200

export function platformReadTools(): WfMcpTool[] {
  return [
    {
      name: 'list_models',
      title: 'List models',
      description:
        "The models enabled for use here, with cost per 1M tokens, throughput and context window. Pass an `id` from this list VERBATIM wherever a model is named (run_eval's `models`, an agent's modelId) — ids are composite `provider:model` and the provider-native half alone will 404. Use it before any matrix sweep that names models.",
      inputSchema: {},
      readOnly: true,
      run: async (client) => {
        const [models, providers] = await Promise.all([
          client.listModels(),
          // Named so a reader can tell WHY two ids differ only by prefix, and
          // so "no models" is distinguishable from "no provider wired up".
          client.listProviders().catch(() => []),
        ])
        return {
          providers,
          models: models.map((m: ModelOption) => ({
            id: m.id,
            label: m.label,
            providerId: m.providerId,
            costPerMTok: m.costPerMTok,
            tokensPerSec: m.tokensPerSec,
            contextLength: m.contextLength,
            capabilities: m.capabilities,
          })),
          note: 'These are the ENABLED models only — the full catalog is larger and the rest are off on purpose.',
        }
      },
    },

    {
      name: 'list_changes',
      title: 'List changes',
      description:
        "The audit feed — who changed which workflow, agent, Goal or Sample, when, and which fields. This is the ONLY who-touched-this record: there is no per-row `updated_by` anywhere else. Use it to answer 'what changed since…', and to explain a drifted eval (get_eval_run's `agentRepublishedSinceLastRun`) by naming the publish that caused it.",
      inputSchema: {
        entityKind: z
          .string()
          .nullish()
          .describe(
            'One of: workflow, agent, eval_set, eval_row, model, assignment. Omit for all.',
          ),
        entityId: z
          .string()
          .nullish()
          .describe('Only changes to this one entity.'),
        parentId: z
          .string()
          .nullish()
          .describe(
            "Changes to an entity's children — a Goal's id returns its Samples' edits.",
          ),
        actorId: z
          .string()
          .nullish()
          .describe(
            'Only this actor. A service caller writes its own id (e.g. svc:mcp), never the person who minted its token.',
          ),
        limit: z
          .number()
          .nullish()
          .describe('How many rows (default 30, max 100).'),
      },
      readOnly: true,
      run: async (client, args) => {
        const rows = await client.listChanges({
          entityKind: optString(args.entityKind) as
            | WfChangeDTO['entityKind']
            | undefined,
          entityId: optString(args.entityId),
          parentId: optString(args.parentId),
          actorId: optString(args.actorId),
          limit: boundedLimit(args.limit, 30, 100),
        })
        return rows.map((r: WfChangeDTO) => ({
          ...r,
          // A published agent config or workflow graph rides along whole.
          before: clip(r.before, CHANGE_PAYLOAD_CHARS),
          after: clip(r.after, CHANGE_PAYLOAD_CHARS),
        }))
      },
    },
  ]
}
