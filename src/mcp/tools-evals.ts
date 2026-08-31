import { z } from 'zod'

import { MANUAL_TRIGGER_KIND } from '../engine/trigger-registry'
import {
  checkTreeSchema,
  evalSampleInputSchema,
  evalSampleLayer,
  evalToolsSchema,
  unavailableCheckTypes,
} from '../eval/checks'
import { clip } from '../server/clip'
import type { WfDataClient, WfEvalTargetKind } from '../server/protocol'

import { optString, reqString, type WfMcpTool } from './tools'

// The eval AUTHORING surface — the point of the whole MCP server. Reading a
// trace is useful; turning what a trace shows into a Goal with samples that run
// tomorrow is the thing a person will not do by hand ten times.
//
// The UI vocabulary is used throughout (Goal / Sample), because that is what the
// author sees in the editor and what the tool descriptions have to line up with.
// The wire keeps the older `set` / `row` identifiers.
//
// ── The one thing that makes or breaks a generated Sample ────────────────────
//
// A Sample's `input` is a discriminated union, and exactly ONE variant is legal
// per target: a `task` agent takes `{ kind: 'task', variables }`, a
// `conversation` agent takes `{ kind: 'conversation', turns, variables }`, and a
// workflow takes `{ kind: 'trigger', payload, variables }`. A model that guesses
// gets a validation failure at best and a Sample that grades the wrong thing at
// worst.
//
// So the target's contract is never something the model has to go looking for:
// `create_eval_set` and `get_eval_set` both RESOLVE it and hand back the exact
// input shape to write, with the target's declared variables already named. The
// preflight is also why a Goal can't be created against a target that doesn't
// exist — `createEvalSet` stores `targetId` as an opaque string with no FK, so
// a hallucinated id would otherwise land a Goal that fails only at run time.

/** A generous per-field budget: a Sample is read in order to be REWRITTEN. */
const SAMPLE_FIELD_CHARS = 8000

/**
 * What a Sample for this target has to look like — resolved from the target
 * itself, so the next `upsert_eval_sample` call needs no second lookup.
 */
type TargetContract = {
  targetKind: WfEvalTargetKind
  targetId: string
  name: string
  /** The `input.kind` a Sample against this target MUST use. */
  sampleInputKind: 'task' | 'conversation' | 'trigger'
  /** A ready-to-fill `input` value in exactly that shape. */
  inputTemplate: Record<string, unknown>
  /** The trigger kind the target is actually invoked under. */
  triggerKind: string
  /** Anything that would make a run of this Goal fail or grade nothing. */
  warnings: string[]
}

function agentInputTemplate(
  inputKind: 'task' | 'conversation',
  variables: string[],
): Record<string, unknown> {
  // Named with an empty value rather than omitted: an unfilled `${var}` renders
  // literally into the prompt, and a key the model can SEE is one it fills.
  const vars = Object.fromEntries(variables.map((v) => [v, '']))
  if (inputKind === 'conversation') {
    return {
      kind: 'conversation',
      turns: [{ role: 'user', text: '' }],
      variables: vars,
    }
  }
  return { kind: 'task', variables: vars }
}

/** The trigger kind a workflow's own graph declares, draft included. */
function graphTriggerKind(detail: {
  currentVersion: {
    graph: { nodes: { kind: string; config: unknown }[] }
  } | null
  draft: { graph: { nodes: { kind: string; config: unknown }[] } } | null
}): string | null {
  const graph = detail.currentVersion?.graph ?? detail.draft?.graph
  const trigger = graph?.nodes.find((n) => n.kind === 'trigger')
  if (!trigger) return null
  const config = trigger.config as { triggerKind?: unknown }
  return typeof config.triggerKind === 'string' ? config.triggerKind : null
}

/**
 * Resolve a target to the Sample shape it accepts, or explain why it can't be
 * a target at all.
 */
async function resolveTargetContract(
  client: WfDataClient,
  targetKind: WfEvalTargetKind,
  targetId: string,
): Promise<TargetContract | { error: string }> {
  if (targetKind === 'agent') {
    const detail = await client.getAgent(targetId)
    if (!detail) {
      return {
        error: `No agent found for id ${targetId}. Ids come from list_agents — a name is not an id.`,
      }
    }
    const { agent } = detail
    const warnings: string[] = []
    if (agent.latestVersionNumber == null) {
      warnings.push(
        `Agent "${agent.name}" has no published version, so a run of this goal has nothing to execute. Publish it before running the goal.`,
      )
    }
    return {
      targetKind: 'agent',
      targetId,
      name: agent.name,
      sampleInputKind: agent.inputKind,
      inputTemplate: agentInputTemplate(agent.inputKind, agent.inputVariables),
      // Not the caller's choice: an agent goal is always started through the
      // manual wrapper (`resolveEvalTarget`), whatever the set records.
      triggerKind: MANUAL_TRIGGER_KIND,
      warnings,
    }
  }

  const detail = await client.getWorkflow(targetId)
  if (!detail) {
    return {
      error: `No workflow found for id ${targetId}. Ids come from list_workflows.`,
    }
  }
  const warnings: string[] = []
  const declared = graphTriggerKind(detail)
  if (!declared) {
    warnings.push(
      'This workflow has no trigger node, so the goal falls back to the `manual` trigger.',
    )
  }
  const triggerKind = declared ?? MANUAL_TRIGGER_KIND
  // The trigger's declared payload fields, so the sample's `payload` is written
  // against the real event shape instead of an invented one.
  const events = await client.listTriggerEvents().catch(() => [])
  const event = events.find((e) => e.kind === triggerKind)
  const payload = Object.fromEntries(
    (event?.fields ?? []).map((f) => [f.name, null]),
  )
  return {
    targetKind: 'workflow',
    targetId,
    name: detail.workflow.name,
    sampleInputKind: 'trigger',
    inputTemplate: { kind: 'trigger', payload, variables: {} },
    triggerKind,
    warnings,
  }
}

/** Clip a Sample's fat JSON fields without changing its shape. */
function clipRow(row: {
  input: unknown
  tools: unknown
  checks: unknown
}): Record<string, unknown> {
  return {
    ...row,
    input: clip(row.input, SAMPLE_FIELD_CHARS),
    tools: clip(row.tools, SAMPLE_FIELD_CHARS),
    checks: clip(row.checks, SAMPLE_FIELD_CHARS),
  }
}

/**
 * The layer a Sample tests, plus anything about it that can't produce a verdict.
 *
 * Derived from the same `input` + `tools` the editor derives it from, so the
 * answer here and the badge on the sample can't disagree. Its value is the
 * silent-failure it names: a `frozen` sample with a `tool_called` check grades
 * the absence of a call the agent was never able to make, which reads as a real
 * failure and isn't one.
 */
function describeSample(
  input: unknown,
  tools: unknown,
  checks: unknown,
): { layer: string; warnings: string[] } {
  // Both parses are of payloads the server just ACCEPTED, so neither can throw;
  // re-parsing here applies the same defaults the stored row got.
  const parsedInput = evalSampleInputSchema.parse(
    input ?? { kind: 'task', variables: {} },
  )
  const parsedTools = evalToolsSchema.parse(
    tools ?? { mode: 'mocked', fixtures: {} },
  )
  const parsedChecks = checkTreeSchema.parse(
    checks ?? { op: 'and', checks: [] },
  )
  const unavailable = new Set<string>(unavailableCheckTypes(parsedTools))
  const dead = [...new Set(parsedChecks.checks.map((c) => c.type))].filter(
    (t) => unavailable.has(t),
  )
  const warnings: string[] = []
  if (dead.length > 0) {
    warnings.push(
      `Checks ${dead.join(', ')} can never pass under tools mode "${parsedTools.mode}" — the agent calls no tools, so they grade an absence. Use mode "mocked" for trajectory checks, or drop them.`,
    )
  }
  if (
    parsedInput.kind === 'task' &&
    Object.values(parsedInput.variables).includes('')
  ) {
    warnings.push(
      'Some prompt variables are empty strings — an unfilled `${var}` renders literally into the prompt.',
    )
  }
  return { layer: evalSampleLayer(parsedInput, parsedTools), warnings }
}

const TARGET_KIND_DESC =
  '"agent" (the default) or "workflow". An agent goal grades one agent in isolation; a workflow goal runs the whole graph.'

export function evalReadTools(): WfMcpTool[] {
  return [
    {
      name: 'list_eval_sets',
      title: 'List eval goals',
      description:
        'List every eval Goal — a named set of Samples run against one agent or workflow and graded by its check tree. Shows what each targets, whether it pins a version, and how many Samples it holds.',
      inputSchema: {
        includeArchived: z
          .boolean()
          .nullish()
          .describe('Include archived goals. Default false.'),
      },
      readOnly: true,
      run: async (client, args) => {
        return await client.listEvalSets({
          includeArchived: args.includeArchived === true,
        })
      },
    },

    {
      name: 'get_eval_set',
      title: 'Get eval goal',
      description:
        "One Goal and all its Samples — each Sample's input, tool mode, and checks. Also resolves the TARGET CONTRACT: the exact `input` shape a new Sample here must use and the variables it must fill. Read this before adding Samples to an existing goal.",
      inputSchema: {
        setId: z.string().describe('Goal id, from list_eval_sets.'),
      },
      readOnly: true,
      run: async (client, args) => {
        const setId = reqString(args.setId, 'setId')
        const detail = await client.getEvalSet(setId)
        if (!detail) return { error: `No eval goal found for id ${setId}.` }
        const contract = await resolveTargetContract(
          client,
          detail.set.targetKind,
          detail.set.targetId,
        )
        return {
          set: detail.set,
          target: contract,
          rows: detail.rows.map(clipRow),
        }
      },
    },
  ]
}

export function evalWriteTools(): WfMcpTool[] {
  return [
    {
      name: 'create_eval_set',
      title: 'Create eval goal',
      description:
        'Create a Goal — the named set a batch of Samples belongs to — against one agent or workflow. The target is resolved first, so a wrong id fails here instead of at run time, and the result hands back the exact `input` shape and variable names the Samples must use. Leave targetVersion unset: a goal that floats to the latest published version keeps grading what actually ships.',
      inputSchema: {
        name: z
          .string()
          .describe(
            'What this goal tests, e.g. "Conflict check — refusal cases".',
          ),
        targetId: z
          .string()
          .describe('Agent id (list_agents) or workflow id (list_workflows).'),
        targetKind: z.string().nullish().describe(TARGET_KIND_DESC),
        description: z.string().nullish().describe('Optional longer note.'),
        targetVersion: z
          .number()
          .nullish()
          .describe(
            'Pin to one published version number. Omit (the default) to float to latest — pin only to reproduce a historical result.',
          ),
        triggerKind: z
          .string()
          .nullish()
          .describe(
            'Normally omit — derived from the target (agents always run under `manual`; a workflow uses the kind its own trigger node declares).',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const name = reqString(args.name, 'name')
        const targetId = reqString(args.targetId, 'targetId')
        const targetKind: WfEvalTargetKind =
          optString(args.targetKind) === 'workflow' ? 'workflow' : 'agent'
        const contract = await resolveTargetContract(
          client,
          targetKind,
          targetId,
        )
        if ('error' in contract) return contract
        const { setId } = await client.createEvalSet({
          name,
          description: optString(args.description),
          targetKind,
          targetId,
          targetVersion:
            typeof args.targetVersion === 'number' ? args.targetVersion : null,
          triggerKind: optString(args.triggerKind) ?? contract.triggerKind,
        })
        return {
          setId,
          target: contract,
          next: `Write samples with upsert_eval_sample({ setId: "${setId}", … }), one call per sample, each with input.kind "${contract.sampleInputKind}".`,
        }
      },
    },

    {
      name: 'upsert_eval_sample',
      title: 'Write eval sample',
      description: [
        'Create a Sample in a Goal (omit `id`) or overwrite one (pass its `id`). One call per sample.',
        '',
        "`input` — the target's own contract, and exactly one shape is legal. Take it from the `target` that create_eval_set / get_eval_set returned:",
        '  • task agent:         { "kind": "task", "variables": { … } } — every declared variable filled.',
        '  • conversation agent: { "kind": "conversation", "turns": [{ "role": "user", "text": "…" }], "variables": { … } }',
        '  • workflow:           { "kind": "trigger", "payload": { … }, "variables": { … } }',
        '',
        '`tools` — one mode, and it decides what the sample can grade:',
        '  • { "mode": "mocked", "fixtures": { "<toolId>": <canned result> } } — deterministic; the ONLY mode where tool_called / tool_args_match mean anything.',
        '  • { "mode": "live" } — read tools really execute; grades retrieval end to end.',
        '  • { "mode": "frozen" } — no tools at all; grades the answer alone. Pair with a conversation input that already stages the retrieved context.',
        'Write tools never execute in any mode.',
        '',
        '`checks` — { "op": "and" | "or", "checks": [ … ] }, each one of: tool_called {toolId, called}, tool_args_match {toolId, path?, match, value}, node_visited {nodeId, visited}, node_input_match {nodeId, path?, match, value}, output_match {path?, match, value}, llm_judge {rubric, path?}. `match` is equals | contains | jsonpath | regex. Prefer a deterministic check where one exists and an llm_judge rubric only for what cannot be asserted literally.',
      ].join('\n'),
      inputSchema: {
        setId: z.string().describe('Goal id the sample belongs to.'),
        name: z
          .string()
          .describe(
            'What this sample tests — the failure mode, not the input.',
          ),
        id: z
          .string()
          .nullish()
          .describe('Sample id to overwrite. Omit to create a new one.'),
        description: z.string().nullish().describe('Optional longer note.'),
        input: z
          .record(z.string(), z.unknown())
          .nullish()
          .describe(
            'The sample input. See the tool description for the shape.',
          ),
        tools: z
          .record(z.string(), z.unknown())
          .nullish()
          .describe('Tool behaviour: mocked (default) | live | frozen.'),
        checks: z
          .record(z.string(), z.unknown())
          .nullish()
          .describe('The check tree that grades the run.'),
        sortOrder: z
          .number()
          .nullish()
          .describe('Position in the goal. Defaults to 0.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const setId = reqString(args.setId, 'setId')
        const name = reqString(args.name, 'name')
        // Passed through unparsed on purpose: `upsertEvalRow` validates each
        // payload against the same schemas the grader reads, and its message
        // names the exact path that is wrong. Re-checking here would only add a
        // second, differently-worded rejection of the same thing.
        const { rowId } = await client.upsertEvalRow({
          id: optString(args.id),
          setId,
          name,
          description: optString(args.description),
          input: args.input as never,
          tools: args.tools as never,
          checks: args.checks as never,
          sortOrder:
            typeof args.sortOrder === 'number' ? args.sortOrder : undefined,
        })
        return {
          rowId,
          ...describeSample(args.input, args.tools, args.checks),
        }
      },
    },

    {
      name: 'delete_eval_sample',
      title: 'Delete eval sample',
      description:
        'Archive a Sample. It drops out of its Goal and out of the count, but past eval reports that graded it still resolve — nothing is erased.',
      inputSchema: {
        rowId: z.string().describe('Sample id, from get_eval_set.'),
      },
      readOnly: false,
      run: async (client, args) => {
        return await client.deleteEvalRow(reqString(args.rowId, 'rowId'))
      },
    },
  ]
}
