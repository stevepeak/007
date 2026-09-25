import { z } from 'zod'

import type { JsonSchema } from '../engine'
import { MANUAL_TRIGGER_KIND } from '../engine/trigger-registry'
import {
  checkTreeSchema,
  describeCheckVocabulary,
  evalSampleInputSchema,
  evalSampleLayer,
  evalToolsSchema,
  toolFixtures,
  unavailableCheckTypes,
  type CheckTree,
  type EvalTools,
} from '../eval/checks'
import { clip } from '../server/clip'
import type {
  AgentConfig,
  WfDataClient,
  WfEvalTargetKind,
} from '../server/protocol'

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
//
// ── The contract carries the target's TOOLS and OUTPUT SCHEMA too ────────────
//
// Two fields of a Sample are keyed against the target rather than free-form, and
// both used to be authored blind here:
//
//   • `tools.fixtures` is keyed by tool id. The console's mock editor only ever
//     offers the target agent's own wired tools and seeds each fixture from that
//     tool's JSON Schema. Over MCP it was a free record — and a fixture keyed on
//     a tool the agent doesn't have is simply dead. It validates, it stores, it
//     is never read, and nothing ever says so.
//   • a judge's `path` addresses a field of the target's declared output. The
//     console builds a dropdown from the output schema; over MCP it was a free
//     string, and a path that doesn't exist grades `undefined` — which reads as
//     the agent answering badly.
//
// Same failure class as ART-146: authored against prose, validated against
// nothing, reported nowhere. So the contract returns `toolIds` and
// `outputSchema`, and `describeSample` lints what was written against them.

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
  /**
   * Tool ids this target can actually call — the only legal keys for
   * `tools.fixtures`. Null for a workflow target, whose tools are spread across
   * however many agent nodes its graph holds.
   */
  toolIds: string[] | null
  /**
   * The target's declared output JSON Schema, when it produces a structured
   * object — the set of legal `path` values for `output_match` and both judges.
   * Null when the agent answers with free text (then omit `path`).
   */
  outputSchema: JsonSchema | null
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
 * The config a Goal's samples will actually be graded against.
 *
 * The PUBLISHED version, not the draft — a Goal floats to the latest published
 * version (or pins one), so the draft is not what a run of it executes. Reading
 * the draft here would describe tools and an output shape the eval will never
 * see, which is a worse lie than saying nothing.
 */
function gradedConfig(detail: {
  currentVersion: { config: AgentConfig } | null
}): AgentConfig | null {
  return detail.currentVersion?.config ?? null
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
    const config = gradedConfig(detail)
    return {
      targetKind: 'agent',
      targetId,
      name: agent.name,
      sampleInputKind: agent.inputKind,
      inputTemplate: agentInputTemplate(agent.inputKind, agent.inputVariables),
      // Not the caller's choice: an agent goal is always started through the
      // manual wrapper (`resolveEvalTarget`), whatever the set records.
      triggerKind: MANUAL_TRIGGER_KIND,
      // Null (unknown) rather than [] (known-empty) when the agent has never
      // been published: the difference decides whether a fixture warning is a
      // finding or noise.
      toolIds: config ? config.toolIds : null,
      outputSchema:
        config?.output.kind === 'object'
          ? (config.output.schema)
          : null,
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
    // A workflow's tools belong to whichever agent nodes its graph holds, and
    // its output is the Output node's — neither is one list. get_workflow shows
    // the graph; this doesn't pretend to summarize it.
    toolIds: null,
    outputSchema: null,
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

/** Top-level field names of a structured output schema, for path checking. */
function outputPaths(schema: JsonSchema | null): string[] | null {
  if (!schema || schema.type !== 'object') return null
  const props = (schema.properties ?? {}) as Record<string, unknown>
  const keys = Object.keys(props)
  return keys.length > 0 ? keys : null
}

/**
 * Fixtures keyed on a tool the target cannot call — dead weight that validates.
 *
 * Only ever reported against a KNOWN tool list (`toolIds != null`): a workflow
 * target, or an agent that has never been published, has no list to check
 * against, and guessing there would produce a warning about nothing.
 */
function deadFixtures(tools: EvalTools, toolIds: string[] | null): string[] {
  if (!toolIds) return []
  const allowed = new Set(toolIds)
  return Object.keys(toolFixtures(tools)).filter((id) => !allowed.has(id))
}

/** Judge / output-match `path`s that name no field of the declared output. */
function deadPaths(checks: CheckTree, schema: JsonSchema | null): string[] {
  const paths = outputPaths(schema)
  if (!paths) return []
  const known = new Set(paths)
  const used = checks.checks
    .filter(
      (c) => { return c.type === 'output_match' ||
        c.type === 'llm_judge' ||
        c.type === 'decision_judge' },
    )
    .map((c) => (c as { path?: string }).path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  // Only the leading segment is checked. A dotted path may address anything
  // below a declared field, and `outputPaths` only knows the top level — so a
  // wrong first segment is provably dead while a wrong tail is not knowable here.
  return [...new Set(used)].filter((p) => !known.has(p.split('.')[0]))
}

/**
 * The layer a Sample tests, plus anything about it that can't produce a verdict.
 *
 * Derived from the same `input` + `tools` the editor derives it from, so the
 * answer here and the badge on the sample can't disagree. Its value is the
 * silent-failure it names: a `frozen` sample with a `tool_called` check grades
 * the absence of a call the agent was never able to make, which reads as a real
 * failure and isn't one.
 *
 * The three lints that follow are all of the same kind — things that store
 * cleanly and then grade nothing, which is the worst outcome an eval can have
 * because it looks like a result.
 */
function describeSample(
  input: unknown,
  tools: unknown,
  checks: unknown,
  target?: { toolIds: string[] | null; outputSchema: JsonSchema | null },
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
  // A Sample with no checks grades as `error`, not `fail` — so it shows up in a
  // report looking like an outage. Worth saying at write time, because the most
  // common way to get one used to be renaming a sample.
  if (parsedChecks.checks.length === 0) {
    warnings.push(
      'This sample has NO checks, so a run of it produces an `error` verdict rather than a pass or a fail — it will read in the report as infrastructure trouble. Add at least one check.',
    )
  }
  if (target) {
    const orphaned = deadFixtures(parsedTools, target.toolIds)
    if (orphaned.length > 0) {
      warnings.push(
        `Fixtures are keyed on tools this target cannot call: ${orphaned.join(', ')}. They will never be read. The target's tools are ${(target.toolIds ?? []).join(', ') || '(none)'}.`,
      )
    }
    const missing = deadPaths(parsedChecks, target.outputSchema)
    if (missing.length > 0) {
      warnings.push(
        `These check paths name no field of the target's output schema: ${missing.join(', ')}. A path that doesn't resolve grades \`undefined\`, which reads as a wrong answer. Fields are ${(outputPaths(target.outputSchema) ?? []).join(', ')}.`,
      )
    }
  }
  return { layer: evalSampleLayer(parsedInput, parsedTools), warnings }
}

const TARGET_KIND_DESC =
  '"agent" (the default) or "workflow". An agent goal grades one agent in isolation; a workflow goal runs the whole graph.'

/**
 * The check vocabulary as the tool description states it — generated, so a new
 * check type or field appears here the moment it is added to the schema.
 */
const CHECK_VOCABULARY = describeCheckVocabulary()
  .map((line) => `      • ${line}`)
  .join('\n')

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
        "One Goal and all its Samples — each Sample's input, tool mode, and checks. Also resolves the TARGET CONTRACT: the exact `input` shape a new Sample here must use, the variables it must fill, the tool ids its `fixtures` may be keyed on, and the output schema its judge `path`s may address. Read this before adding Samples to an existing goal.",
      inputSchema: {
        setId: z.string().describe('Goal id, from list_eval_sets.'),
        includeArchived: z
          .boolean()
          .nullish()
          .describe(
            'Include archived Samples (they carry `archived: true`). Default false. Archiving erases nothing — this is how you find a Sample to restore with delete_eval_sample({ restore: true }).',
          ),
      },
      readOnly: true,
      run: async (client, args) => {
        const setId = reqString(args.setId, 'setId')
        const detail = await client.getEvalSet(setId, {
          includeArchived: args.includeArchived === true,
        })
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
      name: 'update_eval_set',
      title: 'Update eval goal',
      description: [
        "Edit a Goal itself: rename it, repoint it at a different target, pin or unpin the target version, archive it or bring it back. Everything except the Samples, which are `upsert_eval_sample`'s job, and the description, which is `update_description`'s.",
        '',
        'Only the fields you pass are changed; the rest are left alone.',
        '',
        '`targetVersion` is the reproducibility knob and the reason this tool exists. A Goal normally FLOATS to the target’s latest published version, which is what you want — it keeps grading what actually ships. Pin a number only to reproduce a historical result, and unpin it (`floatTargetVersion: true`) afterwards, or the Goal quietly stops measuring the live agent.',
        '',
        'Repointing `targetId` changes what every Sample in the Goal is run against, and the Samples do not move with it — an `input` written for a `task` agent grades nothing against a `conversation` one. The target is resolved first and the reply carries its contract, so check `sampleInputKind` still matches your Samples.',
        '',
        '`archived: true` retires a Goal; `archived: false` brings it back. Nothing is erased either way, and past reports that graded it still resolve.',
      ].join('\n'),
      inputSchema: {
        setId: z.string().describe('Goal id, from list_eval_sets.'),
        name: z.string().nullish().describe('New name for the goal.'),
        targetId: z
          .string()
          .nullish()
          .describe(
            'Repoint the goal at a different agent/workflow. Pass targetKind too when the kind changes.',
          ),
        targetKind: z.string().nullish().describe(TARGET_KIND_DESC),
        targetVersion: z
          .number()
          .nullish()
          .describe(
            'Pin the goal to this published version number. To go back to floating, pass floatTargetVersion instead.',
          ),
        floatTargetVersion: z
          .boolean()
          .nullish()
          .describe(
            'Clear an existing version pin so the goal floats to the target’s latest published version again.',
          ),
        archived: z
          .boolean()
          .nullish()
          .describe('true retires the goal; false restores it.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const setId = reqString(args.setId, 'setId')
        const before = await client.getEvalSet(setId)
        if (!before) {
          return {
            error: `No eval goal found for id ${setId}. Ids come from list_eval_sets.`,
          }
        }
        const targetId = optString(args.targetId)
        const targetKind: WfEvalTargetKind | undefined =
          optString(args.targetKind) === 'workflow'
            ? 'workflow'
            : optString(args.targetKind) === 'agent'
              ? 'agent'
              : undefined
        // Resolve a repoint BEFORE writing it, for the same reason
        // `create_eval_set` does: `targetId` has no FK, so a wrong id lands a
        // Goal that fails only when someone runs it.
        const nextKind = targetKind ?? before.set.targetKind
        const contract = targetId
          ? await resolveTargetContract(client, nextKind, targetId)
          : null
        if (contract && 'error' in contract) return contract

        // `null` and `undefined` mean different things on the wire here — the
        // column is nullable and null IS the "float to latest" value — so the
        // unpin is a separate boolean rather than an overloaded null.
        const float = args.floatTargetVersion === true
        const pin =
          typeof args.targetVersion === 'number' ? args.targetVersion : undefined
        if (float && pin !== undefined) {
          return {
            error:
              'Pass either `targetVersion` (to pin) or `floatTargetVersion: true` (to unpin), not both.',
          }
        }

        await client.updateEvalSet({
          setId,
          name: optString(args.name),
          targetId,
          // Only sent alongside a repoint: changing the KIND without the id
          // would leave the Goal pointing an agent id at the workflow table.
          targetKind: targetId ? targetKind : undefined,
          targetVersion: float ? null : pin,
          archived:
            typeof args.archived === 'boolean' ? args.archived : undefined,
        })
        const after = await client.getEvalSet(setId, { includeArchived: true })
        return {
          setId,
          before: before.set,
          after: after?.set ?? null,
          // Only when the target moved: otherwise this is a paragraph the caller
          // already read on the way in.
          target: contract ?? undefined,
          warnings:
            contract &&
            before.rows.length > 0 &&
            !('error' in contract) &&
            before.rows.some(
              (r) => r.input.kind !== contract.sampleInputKind,
            )
              ? [
                  `This goal has Samples whose input.kind is not "${contract.sampleInputKind}", which is what the new target requires. Those samples will not grade anything until their inputs are rewritten.`,
                ]
              : undefined,
        }
      },
    },

    {
      name: 'upsert_eval_sample',
      title: 'Write eval sample',
      description: [
        'Create a Sample in a Goal (omit `id`) or edit one (pass its `id`). One call per sample.',
        '',
        'Editing is a PATCH: a field you omit keeps the value it already had. To clear one, pass its empty value (`checks: { "op": "and", "checks": [] }`) rather than leaving it out.',
        '',
        "`input` — the target's own contract, and exactly one shape is legal. Take it from the `target` that create_eval_set / get_eval_set returned:",
        '  • task agent:         { "kind": "task", "variables": { … } } — every declared variable filled.',
        '  • conversation agent: { "kind": "conversation", "turns": [ … ], "variables": { … } }',
        '  • workflow:           { "kind": "trigger", "payload": { … }, "variables": { … } }',
        '',
        'A conversation `turn` is { "role": "user" | "assistant", "text": "…" }. An assistant turn may also carry `toolCalls`: [{ "tool": "<toolId>", "args": …, "output": … }] — the call it is treated as having made and the result it saw. That is how you STAGE retrieved context: seed the search the assistant "already ran" and its chunks, and the run begins mid-conversation with only the final reply left to produce. Pair it with tools mode "frozen" for a synthesis test.',
        '',
        '`tools` — one mode, and it decides what the sample can grade:',
        '  • { "mode": "mocked", "fixtures": { "<toolId>": <canned result> } } — deterministic; the ONLY mode where tool_called / tool_args_match mean anything. Keys must be tools the target actually has (`target.toolIds`); any other key is never read.',
        '  • { "mode": "live" } — read tools really execute; grades retrieval end to end.',
        '  • { "mode": "frozen" } — no tools at all; grades the answer alone. Pair with a conversation input whose assistant `toolCalls` already stage the retrieved context (see above).',
        'Write tools never execute in any mode.',
        '',
        '`checks` — { "op": "and" | "or", "checks": [ … ] }. Every legal check, with `?` marking an optional field:',
        CHECK_VOCABULARY,
        '',
        '`match` is equals | contains | jsonpath | regex. `path` addresses a field of the target’s declared output (`target.outputSchema`); omit it to grade the whole output.',
        '',
        'The two judges are the same assertion reached two ways. `llm_judge` asks a chat model to write a verdict and rate its own confidence. `decision_judge` puts one yes/no question to a DECISION model, which returns a calibrated probability, and `threshold` (default 0.5) is where you draw the line — so a borderline row reads as 0.52 instead of as a coin-flip pass with a cheerful 8/10 beside it. Use it for anything that reduces to a yes/no you would otherwise threshold by eye; keep `llm_judge` where you want the written critique. Their `modelId`s come from DIFFERENT catalogs — list_models for `llm_judge`, list_decision_models for `decision_judge` — and omitting one takes whatever sorts first.',
        '',
        'Prefer a deterministic check where one exists and a judge only for what cannot be asserted literally.',
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
          .describe(
            'Sample id to edit. Omit to create a new one. Fields you omit keep their current values.',
          ),
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
        const id = optString(args.id)
        // Read the Goal first, for two reasons that both need it: the target
        // contract the lints below check against, and the row's current values —
        // so the receipt can describe the MERGED sample rather than only the
        // fields this call happened to send.
        const detail = await client.getEvalSet(setId, { includeArchived: true })
        if (!detail) {
          return {
            error: `No eval goal found for id ${setId}. Ids come from list_eval_sets.`,
          }
        }
        const existing = id ? detail.rows.find((r) => r.id === id) : undefined
        if (id && !existing) {
          return {
            error: `Goal "${detail.set.name}" has no sample with id ${id}. get_eval_set lists its samples with their ids; omit \`id\` to create a new one.`,
            sampleIds: detail.rows.map((r) => r.id),
          }
        }
        const contract = await resolveTargetContract(
          client,
          detail.set.targetKind,
          detail.set.targetId,
        )
        // Passed through unparsed on purpose: `upsertEvalRow` validates each
        // payload against the same schemas the grader reads, and its message
        // names the exact path that is wrong. Re-checking here would only add a
        // second, differently-worded rejection of the same thing.
        const { rowId } = await client.upsertEvalRow({
          id,
          setId,
          name,
          description: optString(args.description),
          input: args.input as never,
          tools: args.tools as never,
          checks: args.checks as never,
          sortOrder:
            typeof args.sortOrder === 'number' ? args.sortOrder : undefined,
        })
        // The MERGED values, which is what the row now holds — an omitted field
        // kept what it had, so describing only what was sent would report a
        // sample that doesn't exist.
        const merged = {
          input: args.input ?? existing?.input,
          tools: args.tools ?? existing?.tools,
          checks: args.checks ?? existing?.checks,
        }
        return {
          rowId,
          created: !id,
          // Which fields this call actually replaced. Worth stating plainly: the
          // difference between "I renamed it" and "I rewrote its checks" is the
          // difference between a safe edit and a lost one.
          replaced: (['input', 'tools', 'checks'] as const).filter(
            (k) => args[k] != null,
          ),
          ...describeSample(
            merged.input,
            merged.tools,
            merged.checks,
            'error' in contract ? undefined : contract,
          ),
        }
      },
    },

    {
      name: 'delete_eval_sample',
      title: 'Archive or restore an eval sample',
      description:
        'Archive a Sample, or bring an archived one back with `restore: true`. An archived Sample drops out of its Goal and out of the count, but nothing is erased — past eval reports that graded it still resolve, and get_eval_set({ includeArchived: true }) still lists it, which is how you find one to restore.',
      inputSchema: {
        rowId: z.string().describe('Sample id, from get_eval_set.'),
        restore: z
          .boolean()
          .nullish()
          .describe(
            'true un-archives the Sample instead of archiving it, putting it back in its Goal.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const rowId = reqString(args.rowId, 'rowId')
        if (args.restore === true) {
          await client.restoreEvalRow(rowId)
          return { ok: true, rowId, archived: false }
        }
        await client.deleteEvalRow(rowId)
        return { ok: true, rowId, archived: true }
      },
    },
  ]
}
