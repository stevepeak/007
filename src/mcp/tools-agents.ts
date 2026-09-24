import { z } from 'zod'

import {
  agentConfigSchema,
  agentInputVariables,
  agentModelRequirements,
} from '../engine/graph'
import {
  REQUIREMENT_REASON,
  unmetRequirements,
} from '../engine/model-capabilities'
import { clip } from '../server/clip'
import type {
  AgentConfig,
  AgentNodeMeta,
  AgentPreviewResult,
  ModelOption,
  ToolOption,
  WfDataClient,
} from '../server/protocol'

import { optString, reqString, type WfMcpTool } from './tools'

// The agent write path — the endgame of the "extend the surface" queue, and the
// only tools here with real blast radius.
//
// The loop these exist to close: read a failing eval (`get_eval_run`) → change
// the agent → find out whether the change helped. Until now the middle step had
// no tool at all, so a model could diagnose a bad prompt precisely and then hand
// the fix back as prose for a person to retype.
//
// Two lines are drawn deliberately, and both of them are about who is left
// holding the consequence:
//
//   • **Drafts, never re-publishes.** `publish_agent` is NOT here. A published
//     version floats into every workflow that references the agent (see the
//     float-to-latest rule), so publishing OVER an agent workflows already run
//     is the single action in this file's neighborhood that changes what
//     customers get. A draft changes what the next eval run measures and nothing
//     else, and the editor's "discard draft" undoes it wholesale. The model
//     proposes; a person ships.
//
//     `create_agent` is not the exception it looks like. Creating an agent seeds
//     a published v1 — `createAgent` always has, and the UI's "New agent" button
//     does exactly this — but a brand-new id is referenced by no graph, so that
//     version floats into nothing. Wiring it into a workflow is a separate act
//     with its own gates (an agent node in the editor, or `patch_workflow_draft`
//     + `publish_workflow`, which refuse on a lint error or a stale base).
//     Deleting one is not here either: `archiveAgent` has no tool, so the
//     failure mode of a model that over-creates is clutter a person clears, not
//     a customer-visible change.
//   • **Simulated tools, never live ones.** `run_agent_preview` does not accept
//     `liveToolIds`, so every tool in a previewed run is stood in for by the
//     model and nothing outside this process is touched. The playground in the
//     UI does offer live tools — behind a per-tool toggle a person flips, having
//     read the warning. That confirmation has no equivalent in a tool call, and
//     the tools in question search real client matters and write real records.
//     `run_tool_preview` is absent for the same reason and more bluntly: its
//     entire purpose is to execute the real thing.
//
// What a preview IS good for, given simulated tools: prompt shape, output
// contract, tone, and whether the agent asks for the right tools in the right
// order. It is a cheap smoke test between an edit and a real eval sweep — one
// model call against `run_eval`'s dozens. It is NOT evidence the agent answers
// correctly; only a graded run against real tools is that.

/** Preview output/step text, clipped — a step's text can be a whole answer. */
const PREVIEW_TEXT_CHARS = 4000

/** Tool call I/O in a preview trace. Simulated, but the model still writes prose. */
const PREVIEW_TOOL_CHARS = 600

/**
 * Top-level config keys that differ between two configs.
 *
 * Deliberately shallow and deliberately local: the editor's own differ lives in
 * `src/ui`, which nothing on this path may import (see the entry-point closure
 * test), and a per-field diff is more than the receipt below needs.
 *
 * It exists because `updateAgentDraft` REPLACES the draft. A model that read the
 * config, edited one line, and re-sent it with a field quietly dropped has
 * written a config that is wrong in a way nothing else would report — the write
 * succeeds, and the loss only shows up as an eval regression later. Naming every
 * field that now differs turns that into something the model can see one line
 * after causing it.
 */
export function changedKeys(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): string[] {
  if (!before) return Object.keys(after).sort()
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys]
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .sort()
}

/**
 * The config a run/preview should use, and whether it is actually different
 * from what is live.
 *
 * `unsavedFields` is the part that isn't obvious. A draft row is NOT a signal
 * that someone has edits in flight — 007 keeps one alongside every agent, and
 * publishing leaves it matching the version it published, so `draft !== null` is
 * true for nearly every agent in the system. Reporting "ran the unsaved draft"
 * off that alone is a statement that is simultaneously accurate and useless: the
 * caller reads it as evidence their edit was measured, when the run measured the
 * published config under another name. Empty here means "same as live".
 */
export function draftOrPublished(
  detail: {
    draft: { config: AgentConfig } | null
    currentVersion: { config: AgentConfig } | null
  } | null,
): {
  config: AgentConfig
  source: 'draft' | 'published'
  unsavedFields: string[]
} | null {
  if (!detail) return null
  if (detail.draft) {
    return {
      config: detail.draft.config,
      source: 'draft',
      unsavedFields: changedKeys(
        detail.currentVersion?.config,
        detail.draft.config,
      ),
    }
  }
  if (detail.currentVersion) {
    return {
      config: detail.currentVersion.config,
      source: 'published',
      unsavedFields: [],
    }
  }
  return null
}

/**
 * Ids a refusal will name before it stops counting. The enabled catalog is small
 * but not fixed, and a hundred ids buries the sentence that says what to do.
 */
const MAX_NAMED_MODELS = 20

/** Ids in an error, capped and countable — a list to pick the right one from. */
function nameIds(ids: string[]): string {
  const shown = ids.slice(0, MAX_NAMED_MODELS)
  const rest = ids.length - shown.length
  return rest > 0
    ? `${shown.join(', ')} (+${rest} more — call list_models)`
    : shown.join(', ')
}

/**
 * The config an agent will be CREATED with, or the reason it cannot be.
 *
 * Three things are checked here that the schema cannot, and all three are the
 * same failure: an id the model wrote from memory. `modelId` is passed opaquely
 * to the host's `getModel`, `toolIds` are registry keys resolved at run time, and
 * neither has a foreign key — so a plausible-looking wrong one produces an agent
 * that saves, lists, and fails the first time it is actually run, at which point
 * nothing points at the tool call that authored it. The same argument
 * `create_eval_set` makes for resolving its target before storing it.
 *
 * The capability gate is the third: an agent given tools needs a model that can
 * call them, and the editor never offers one that can't (the row is disabled with
 * the reason). A tool call has no disabled row, so the check has to be here or
 * nowhere. It only fires on a model the catalog KNOWS lacks something — see
 * `unmetRequirements`.
 *
 * Deliberately NOT checked: `subAgents.targets`, whose ids are also unresolved
 * pointers. Delegation is not something an agent gets on the call that creates
 * it — it names other agents by id, so it is a second pass by construction — and
 * `update_agent_draft` has no such check either. A wrong target there fails on a
 * draft, which is the shape of mistake this file is relaxed about.
 */
async function preflightAgentConfig(
  client: WfDataClient,
  raw: unknown,
): Promise<{ config: AgentConfig } | { error: string }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      error:
        'Missing required argument `config` — an object with at least `modelId`, `prompt` and `userPrompt`.',
    }
  }
  const parsed = agentConfigSchema.safeParse(raw)
  if (!parsed.success) {
    // Field-by-field: the schema's messages are written for an author (the
    // `userPrompt` refinement explains how data reaches an agent at all), and a
    // stringified ZodError buries them.
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
      .join('\n')
    return { error: `The config is not valid:\n${issues}` }
  }
  const config = parsed.data

  const models: ModelOption[] = await client.listModels()
  const model = models.find((m) => m.id === config.modelId)
  if (!model) {
    return {
      error: `No enabled model has the id "${config.modelId}". Ids are composite \`provider:model\` and must be passed verbatim from list_models — the provider-native half alone will 404. Enabled: ${nameIds(
        models.map((m) => m.id),
      )}`,
    }
  }

  if (config.toolIds.length > 0) {
    const catalog: ToolOption[] = await client.listTools()
    const known = new Set(catalog.map((t) => t.id))
    const unknown = config.toolIds.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      return {
        error: `These tool ids are not in the catalog: ${unknown.join(
          ', ',
        )}. An agent can only be given a registered tool — call get_tool_catalog for the ids.`,
      }
    }
  }

  const requirements = agentModelRequirements(config)
  const unmet = unmetRequirements(model, requirements)
  if (unmet.length > 0) {
    const capable = models
      .filter((m) => unmetRequirements(m, requirements).length === 0)
      .map((m) => m.id)
    return {
      error: `Model "${model.id}" cannot run this agent: ${unmet
        .map((k) => REQUIREMENT_REASON[k])
        .join(', ')}. The config needs ${Object.keys(requirements)
        .filter((k) => requirements[k as keyof typeof requirements] === true)
        .join(', ')}. Models that can: ${nameIds(capable)}`,
    }
  }

  return { config }
}

/** Values for `${…}` prompt variables — strings only, as the handler parses them. */
function stringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/** A preview's trace, reduced to what a reader of the ANSWER wants next. */
function summarizePreview(result: AgentPreviewResult): unknown {
  const meta: AgentNodeMeta = result.meta
  return {
    output: clip(result.output, PREVIEW_TEXT_CHARS),
    model: meta.model,
    turns: meta.steps.length,
    tokens: meta.totalUsage,
    // Both mean the loop stopped for a reason nobody chose per-run, so an answer
    // that looks thin has an explanation that isn't the prompt.
    stoppedOnTokenBudget: meta.stoppedOnTokenBudget,
    stoppedOnContextLimit: meta.stoppedOnContextLimit,
    steps: meta.steps.map((s) => ({
      stepNumber: s.stepNumber,
      finishReason: s.finishReason,
      text: clip(s.text, PREVIEW_TEXT_CHARS),
      toolCalls: s.toolCalls.map((c) => ({
        toolName: c.toolName,
        input: clip(c.input, PREVIEW_TOOL_CHARS),
        // Simulated: the MODEL wrote this, standing in for the real tool. Named
        // as such on every call so a plausible-looking result is never mistaken
        // for something that was actually fetched.
        simulatedOutput: clip(c.output, PREVIEW_TOOL_CHARS),
      })),
    })),
  }
}

export function agentWriteTools(): WfMcpTool[] {
  return [
    {
      name: 'create_agent',
      title: 'Create agent',
      description:
        'Create a new reusable agent — the same thing the console’s "New agent" button makes, configured in one call instead of by hand. It starts at version 1 with a matching draft, and NO workflow references it yet, so nothing runs it until someone adds an agent node pointing at it; that wiring is a separate, gated step. `config` needs three fields: `modelId` (from list_models, verbatim — ids are composite `provider:model`), `prompt` (the system prompt: INSTRUCTIONS only, since it is the provider’s cache prefix) and `userPrompt` (the single user turn, and the only way per-call data reaches a task agent — write `${variable}` tokens and each workflow node maps them). Everything else defaults: `toolIds` [] (ids from get_tool_catalog), `maxTurns` 5, `output` {"kind":"text"} (or `boolean`, or `object` with a `schema`), `inputKind` "task" (use "conversation" for a chat agent, whose nodes must bind `conversation`), `reasoning` false, `webSearch` "off". The model, the tool ids and the model’s capabilities are checked before anything is written, so a wrong id fails here rather than on the first real run. Preview it with run_agent_preview, then give it a Goal with create_eval_set.',
      inputSchema: {
        name: z
          .string()
          .describe(
            'Display name, e.g. "Conflict checker". Shown on the agent card and in a workflow’s node picker.',
          ),
        config: z
          .record(z.string(), z.unknown())
          .describe(
            'The AgentConfig — same shape get_agent returns under `currentVersion.config`. Only modelId, prompt and userPrompt are required; see the tool description for the defaults.',
          ),
        description: z
          .string()
          .nullish()
          .describe(
            'One line on what the agent is for. Shown on the card, and used in the synthesized `spawn_*` tool description when another agent delegates to this one — so write it for a reader who has to choose.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const name = reqString(args.name, 'name')
        const preflight = await preflightAgentConfig(client, args.config)
        if ('error' in preflight) return preflight
        const { config } = preflight

        const { agentId } = await client.createAgent({
          name,
          description: optString(args.description),
          config,
        })
        const variables = agentInputVariables(config)
        return {
          ok: true,
          agentId,
          name,
          versionNumber: 1,
          // The binding contract, stated on creation for the same reason
          // `create_eval_set` states its target's: the next thing anyone does
          // with this agent — a node, a Sample, a preview — has to supply
          // exactly these, and going to look them up is a round trip that the
          // config just went past.
          inputContract: {
            inputKind: config.inputKind,
            variables,
            note:
              config.inputKind === 'conversation'
                ? 'Every workflow node pointing at this agent MUST bind `conversation` to a message source, or the run throws.'
                : variables.length > 0
                  ? 'Every workflow node pointing at this agent must map each of these variables.'
                  : 'The user turn has no `${variables}`, so it renders the same on every call — usually a mistake for a task agent, since nothing per-run reaches it.',
          },
          output: config.output.kind,
          toolIds: config.toolIds,
          note: 'Version 1 is published, but no workflow references this agent yet, so nothing runs it. Publishing a LATER version is not available here — a person does that in the console once it is wired up.',
          next: `Smoke-test it with run_agent_preview({ agentId: "${agentId}", ${
            variables.length > 0
              ? `promptVariables: { ${variables.map((v) => `${v}: "…"`).join(', ')} }`
              : 'input: "…"'
          } }), then create_eval_set({ targetId: "${agentId}", targetKind: "agent", … }) to grade it. Further edits go to the draft via update_agent_draft.`,
        }
      },
    },

    {
      name: 'update_agent_draft',
      title: 'Update agent draft',
      description:
        'Replace an agent’s unsaved DRAFT config. Read get_agent first and send the WHOLE config back with your edits applied — this overwrites the draft outright, so any field you omit is lost. Nothing is published: the draft changes what run_eval (with draftAgentId) and run_agent_preview measure, and no workflow runs it until a person publishes. It also replaces whatever draft someone had open in the editor, so say what you changed. Publishing is deliberately not available here.',
      inputSchema: {
        agentId: z.string().describe('Agent id, from list_agents.'),
        config: z
          .record(z.string(), z.unknown())
          .describe(
            'The complete AgentConfig — the same object get_agent returns under `draft.config` / `currentVersion.config`, edited. Not a patch.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const agentId = reqString(args.agentId, 'agentId')
        const config = args.config
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          throw new Error(
            'Missing required argument `config` — the complete AgentConfig object, from get_agent.',
          )
        }
        const before = await client.getAgent(agentId)
        if (!before) return { error: `No agent found for id ${agentId}.` }

        await client.updateAgentDraft({
          agentId,
          config: config as unknown as AgentConfig,
        })

        // Diff against the PUBLISHED version, not the previous draft: "what does
        // this agent now do differently from what is live" is the question a
        // person reviewing the draft has, and the one an accidental dropped
        // field answers loudly.
        const published = before.currentVersion?.config as
          | Record<string, unknown>
          | undefined
        return {
          ok: true,
          agentId,
          draftDiffersFromPublishedIn: changedKeys(
            published,
            config as Record<string, unknown>,
          ),
          note: published
            ? 'Saved as a draft only — the published version is unchanged and still what every workflow runs. Check the field list above: anything you did not mean to change means the config you sent was incomplete.'
            : 'Saved as a draft. This agent has never been published, so it has no live version to compare against.',
          next: `Try it with run_agent_preview, or grade it with run_eval({ setIds: […], draftAgentId: "${agentId}" }).`,
        }
      },
    },

    {
      name: 'run_agent_preview',
      title: 'Run agent preview',
      description:
        'Run one agent once, in isolation, against a made-up input — the playground. Runs the DRAFT — what the agent editor shows — so it tests edits before they are published; the reply’s `unsavedFields` names the fields that actually differ from the live version, and is empty when the draft merely matches it. ALL TOOLS ARE SIMULATED: the model writes plausible tool results rather than any real search or record being touched, so this checks prompt, format and which tools the agent reaches for, and is NOT evidence the answer is correct. Nothing is persisted and no workflow is affected. Cheap — one model call — so use it between an edit and a run_eval sweep.',
      inputSchema: {
        agentId: z.string().describe('Agent id, from list_agents.'),
        input: z
          .string()
          .nullish()
          .describe(
            'The user message to run against. Required unless the agent’s prompts take only `${…}` variables, in which case pass promptVariables.',
          ),
        promptVariables: z
          .record(z.string(), z.string())
          .nullish()
          .describe(
            'Values for the `${name}` variables in the agent’s prompts, keyed by name. get_agent shows which ones it declares.',
          ),
        usePublished: z
          .boolean()
          .nullish()
          .describe(
            'Run the published version instead of the draft. Default false — the draft is the point.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const agentId = reqString(args.agentId, 'agentId')
        const detail = await client.getAgent(agentId)
        if (!detail) return { error: `No agent found for id ${agentId}.` }

        const usePublished = args.usePublished === true
        const chosen = usePublished
          ? detail.currentVersion
            ? {
                config: detail.currentVersion.config,
                source: 'published' as const,
                unsavedFields: [],
              }
            : null
          : draftOrPublished(detail)
        if (!chosen) {
          return {
            error: usePublished
              ? `Agent ${agentId} has never been published; omit usePublished to run its draft.`
              : `Agent ${agentId} has neither a draft nor a published version to run.`,
          }
        }

        const input = optString(args.input) ?? ''
        const promptVariables = stringRecord(args.promptVariables)
        // The handler rejects this too, but from here the message can name the
        // variables this particular agent declares instead of the generic ask.
        if (!input && Object.keys(promptVariables).length === 0) {
          return {
            error:
              'Provide `input`, or `promptVariables` for the agent’s `${…}` variables. get_agent shows which the prompts use.',
          }
        }

        const result = await client.runAgentPreview({
          config: chosen.config,
          input: input || undefined,
          promptVariables,
          // No `liveToolIds`, ever — see the note at the top of this file.
        })
        return {
          ranConfig: chosen.source,
          // Said explicitly because "ran the draft" is true of almost every
          // agent and means nothing on its own — see `draftOrPublished`.
          unsavedFields: chosen.unsavedFields,
          ...(summarizePreview(result) as Record<string, unknown>),
          note:
            chosen.source === 'draft' && chosen.unsavedFields.length === 0
              ? 'Every tool result above was written by the model, not fetched. Note the draft is IDENTICAL to the published version, so this ran what is already live.'
              : 'Every tool result above was written by the model, not fetched. Grade the agent with run_eval before trusting the answer.',
        }
      },
    },
  ]
}
