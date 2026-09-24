import { z } from 'zod'

import type { WfDataClient } from '../server/protocol'

import { optString, reqString, type WfMcpTool } from './tools'

// `update_description` — the one editable piece of prose that every authored
// entity carries and that none of the other write tools can reach.
//
// It is one tool across four entity kinds rather than four near-identical ones.
// A description is not part of any entity's *definition*: it is unversioned
// display metadata, it never changes what a run does, and the four storage
// methods behind it (`updateWorkflow`, `updateAgentMeta`, `updateEvalSet`,
// `upsertEvalRow`) differ only in which id they take. Four catalog entries for
// that would cost every session's context four tool descriptions to say the
// same sentence.
//
// The thing this is careful about is the NO-OP. `updateEvalSet` does not check
// that the set exists — a wrong id updates zero rows and returns `{ ok: true }`,
// which reads as success. So every kind is resolved first and the reply carries
// `before` / `after`, making "I set the description" a claim the caller can see
// evidence for rather than infer from the absence of an error.

/** The entity kinds that carry an editable `description` column. */
const KINDS = ['workflow', 'agent', 'eval_set', 'eval_sample'] as const
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

export function metaWriteTools(): WfMcpTool[] {
  return [
    {
      name: 'update_description',
      title: 'Update a description',
      description: [
        "Rewrite the description of a workflow, agent, eval Goal or eval Sample — the prose that says what the thing is FOR, which is what a person (or the next model) reads before opening it. Nothing else about the entity is touched: a description is unversioned display metadata, so this never changes what a run does and never publishes anything.",
        '',
        'Pick `kind` and pass that entity’s id:',
        '  • workflow    — id from list_workflows',
        '  • agent       — id from list_agents',
        '  • eval_set    — Goal id from list_eval_sets',
        '  • eval_sample — Sample id from get_eval_set, AND its `setId` (a Sample is only addressable through its Goal)',
        '',
        'Pass an empty string to clear it. The reply carries `before` and `after`, so a wrong id is a refusal here rather than a silent no-op that reads as success. The edit lands in the `wf_change` feed attributed to whoever authorized this session.',
      ].join('\n'),
      inputSchema: {
        kind: z
          .string()
          .describe(
            'What to edit: "workflow", "agent", "eval_set" or "eval_sample".',
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
        return await applyDescription(
          client,
          kind as MetaKind,
          id,
          description.trim() === '' ? CLEARED : description,
          optString(args.setId),
        )
      },
    },
  ]
}
