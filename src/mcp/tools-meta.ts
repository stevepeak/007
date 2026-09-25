import { z } from 'zod'

import type { WfDataClient } from '../server/protocol'

import { optString, reqString, type WfMcpTool } from './tools'

// `update_description` — the one editable piece of prose that every authored
// entity carries and that none of the other write tools can reach.
//
// It is one tool across five entity kinds rather than five near-identical ones.
// A description is not part of any entity's *definition*: it is unversioned
// display metadata, it never changes what a run does, and the storage methods
// behind it (`updateWorkflow`, `updateAgentMeta`, `updateEvalSet`,
// `upsertEvalRow`, `setRunNote`) differ only in which id they take. Five catalog
// entries for that would cost every session's context five tool descriptions to
// say the same sentence.
//
// `run` is the odd one and belongs here anyway. A run's NOTE is not a
// description — it is the shared "why did this fail / what was tried" scratchpad,
// written after the fact — but it is the same operation on the same kind of
// field: one unversioned string, no effect on anything that executes. Without it
// an MCP triage session left no trace on the run it investigated: the finding
// lived only in a chat transcript, while `list_runs.search` reads the note.
//
// The thing this is careful about is the NO-OP. `updateEvalSet` does not check
// that the set exists — a wrong id updates zero rows and returns `{ ok: true }`,
// which reads as success. So every kind is resolved first and the reply carries
// `before` / `after`, making "I set the description" a claim the caller can see
// evidence for rather than infer from the absence of an error.

/** The entity kinds that carry an editable prose field. */
const KINDS = ['workflow', 'agent', 'eval_set', 'eval_sample', 'run'] as const
type MetaKind = (typeof KINDS)[number]

/**
 * Clearing stores `''`, not NULL.
 *
 * Not a shortcut around a nullable column — it is what the console already
 * writes. The agent editor commits `description.trim()` on blur with no
 * empty-guard (`use-agent-editor-state.ts`), so a description cleared by hand is
 * already an empty string. Writing NULL from here would make two identical-
 * looking edits store two different values, and `updateAgentMeta`'s wire schema
 * doesn't accept null anyway.
 */
const CLEARED = ''

type Applied = {
  kind: MetaKind
  id: string
  name: string
  before: string | null
  after: string
}

/**
 * Resolve the entity, write the description, and report what it used to say.
 *
 * Every branch reads BEFORE writing for the same reason the handlers do: a
 * description is unversioned, so once it is overwritten the old text exists
 * nowhere except the `wf_change` row this write is about to produce.
 */
async function applyDescription(
  client: WfDataClient,
  kind: MetaKind,
  id: string,
  description: string,
  setId: string | undefined,
): Promise<Applied | { error: string }> {
  if (kind === 'workflow') {
    const detail = await client.getWorkflow(id)
    if (!detail) {
      return {
        error: `No workflow found for id ${id}. Ids come from list_workflows.`,
      }
    }
    await client.updateWorkflow({ workflowId: id, description })
    return {
      kind,
      id,
      name: detail.workflow.name,
      before: detail.workflow.description,
      after: description,
    }
  }

  if (kind === 'agent') {
    const detail = await client.getAgent(id)
    if (!detail) {
      return {
        error: `No agent found for id ${id}. Ids come from list_agents — a name is not an id.`,
      }
    }
    await client.updateAgentMeta({ agentId: id, description })
    return {
      kind,
      id,
      name: detail.agent.name,
      before: detail.agent.description,
      after: description,
    }
  }

  if (kind === 'eval_set') {
    const detail = await client.getEvalSet(id)
    if (!detail) {
      return {
        error: `No eval goal found for id ${id}. Ids come from list_eval_sets.`,
      }
    }
    await client.updateEvalSet({ setId: id, description })
    return {
      kind,
      id,
      name: detail.set.name,
      before: detail.set.description,
      after: description,
    }
  }

  // A Sample. There is no update-one-field path in the data layer — the only
  // writer is `upsertEvalRow`, which REPLACES `input` / `tools` / `checks` with
  // whatever this call passes and silently defaults any of them that it omits.
  // So the row is read back and re-sent whole. Nothing here is a patch.
  if (!setId) {
    return {
      error:
        'Editing a Sample needs its `setId` as well as its `id` — a Sample is only addressable through its Goal. get_eval_set returns both.',
    }
  }
  const detail = await client.getEvalSet(setId)
  if (!detail) {
    return { error: `No eval goal found for id ${setId}.` }
  }
  const row = detail.rows.find((r) => r.id === id)
  if (!row) {
    return {
      error: `Goal "${detail.set.name}" has no sample with id ${id}. get_eval_set lists its samples with their ids.`,
    }
  }
  await client.upsertEvalRow({
    id: row.id,
    setId: row.setId,
    name: row.name,
    description,
    input: row.input,
    tools: row.tools,
    checks: row.checks,
    sortOrder: row.sortOrder,
  })
  return {
    kind,
    id,
    name: row.name,
    before: row.description,
    after: description,
  }
}

/**
 * A run's triage note.
 *
 * Split out from `applyDescription` rather than folded into its chain because
 * nothing about it is a "description": the field is `note`, the writer is
 * `setRunNote`, and the before-image comes off the run summary. Sharing the tool
 * is the point; sharing the function body would only obscure that.
 *
 * Not attributed and not private — anyone looking at the run can read and
 * overwrite it, and the last write wins. So a note that replaces someone else's
 * returns what it replaced.
 */
async function applyRunNote(
  client: WfDataClient,
  runId: string,
  note: string,
): Promise<Applied | { error: string }> {
  const detail = await client.getRun(runId)
  if (!detail) {
    return {
      error: `No run found for id ${runId}. Ids come from list_runs, get_run or list_feedback.`,
    }
  }
  await client.setRunNote({ runId, note })
  return {
    kind: 'run',
    id: runId,
    name: detail.run.workflowName ?? runId,
    before: detail.run.note ?? null,
    after: note,
  }
}

export function metaWriteTools(): WfMcpTool[] {
  return [
    {
      name: 'update_description',
      title: 'Update a description or run note',
      description: [
        "Rewrite the unversioned prose on a workflow, agent, eval Goal, eval Sample or run. For the first four that is the DESCRIPTION — what the thing is FOR, which is what a person (or the next model) reads before opening it. For a run it is the triage NOTE. Nothing else is touched in either case: this never changes what a run does and never publishes anything.",
        '',
        'Pick `kind` and pass that entity’s id:',
        '  • workflow    — id from list_workflows',
        '  • agent       — id from list_agents',
        '  • eval_set    — Goal id from list_eval_sets',
        '  • eval_sample — Sample id from get_eval_set, AND its `setId` (a Sample is only addressable through its Goal)',
        '  • run         — run id from list_runs. Writes the run’s NOTE, not a description: the shared "why did this fail / what was tried / what to check next" scratchpad. Use it to leave the finding of a triage on the run itself — it is searchable from list_runs, and otherwise an investigation exists only in this conversation. Markdown. Not attributed and not private: the last write wins, so the reply shows what it replaced.',
        '',
        'Pass an empty string to clear it. The reply carries `before` and `after`, so a wrong id is a refusal here rather than a silent no-op that reads as success. The edit lands in the `wf_change` feed attributed to whoever authorized this session.',
      ].join('\n'),
      inputSchema: {
        kind: z
          .string()
          .describe(
            'What to edit: "workflow", "agent", "eval_set", "eval_sample" or "run".',
          ),
        id: z.string().describe('The entity’s id — see the tool description.'),
        description: z
          .string()
          .describe('The new description. Empty string clears it.'),
        setId: z
          .string()
          .nullish()
          .describe(
            'Only for kind "eval_sample": the Goal the Sample belongs to.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const kind = optString(args.kind) ?? ''
        if (!KINDS.includes(kind as MetaKind)) {
          return {
            error: `Unknown kind "${kind}". Use one of: ${KINDS.join(', ')}.`,
          }
        }
        const id = reqString(args.id, 'id')
        // NOT `optString`: an empty description is the documented way to clear
        // one, and `optString` treats '' as absent — which would turn "clear
        // this" into "write the string 'undefined' or nothing at all".
        const description =
          typeof args.description === 'string' ? args.description : undefined
        if (description === undefined) {
          throw new Error(
            'Missing required argument `description`. Pass an empty string to clear it.',
          )
        }
        const text = description.trim() === '' ? CLEARED : description
        return kind === 'run'
          ? await applyRunNote(client, id, text)
          : await applyDescription(
              client,
              kind as MetaKind,
              id,
              text,
              optString(args.setId),
            )
      },
    },
  ]
}
