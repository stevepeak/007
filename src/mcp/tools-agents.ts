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

import { boundedLimit, optString, reqString, type WfMcpTool } from './tools'

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
//     a customer-visible change. Note the real consequence of that pairing:
//     this surface can only ever ADD to the agent catalog, never tidy it — and
//     there is no unarchive anywhere in the SDK, so the asymmetry is at least
//     the safe way round.
//
//     ── `publish_agent`: the decision, made rather than inherited (ART-234) ──
//
//     It stays out. The argument above was written for `create_agent` and has
//     been re-examined on its own terms; this is the conclusion, not an
//     inheritance.
//
//     What makes it different from `publish_workflow`, which IS here: a workflow
//     version changes one thing, what its own trigger runs next, and the caller
//     must name the version it read (`baseVersionNumber`) so a concurrent
//     publish cannot be silently overwritten. An agent version floats into every
//     workflow that references it — so one call changes what an unknown number
//     of live workflows do, at once, with no per-workflow gate and no natural
//     concurrency token. The blast radius is not knowable from the arguments.
//
//     The cost of keeping it out is real and worth stating plainly: every
//     improvement authored here needs a person to open the console and press
//     Publish. That is the intended shape — the model proposes, a person ships —
//     and the rest of this ticket's work is about making the proposal complete
//     enough to review: `update_agent_draft` now preflights, `list_agent_versions`
//     shows what would change, `get_agent` reports which workflows are affected,
//     and `run_eval({ draftAgentId })` grades the draft before anyone publishes it.
//
//     If it ever ships, these are the gates it needs, and none of them exist yet:
//     the reference count as a refusal above some threshold, a dry run naming
//     every affected workflow, and a confirmation token echoed from a prior call
//     so the publish cannot be the first thing a session does.
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

/** Recent real calls returned by default, and the ceiling. */
const DEFAULT_AGENT_CALLS = 10
const MAX_AGENT_CALLS = 50

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
 * Fields the previous draft had SET that the caller's payload simply left out.
 *
 * Compared against the RAW argument, deliberately — not against the parsed
 * config. `agentConfigSchema` fills every default, so a parsed config always has
 * every key and an omission is invisible one line later: `subAgents` comes back
 * as `{ targets: [] }`, indistinguishable from a caller who meant to clear it.
 * The omission only exists in what was sent.
 *
 * That is the whole point. The fields most likely to be lost are the ones a model
 * never learned exist — `subAgents` above all, the editor's entire Sub-agents
 * section. A config read, edited for its prompt and re-sent drops the whitelist,
 * the write succeeds, zod backfills an empty one, and nothing says so until
 * delegation quietly stops happening.
 *
 * `changedKeys` answers "how does this differ from what is live", which is what a
 * reviewer wants. This answers "did I just delete something I never looked at".
 */
function droppedKeys(
  before: Record<string, unknown> | undefined,
  sent: Record<string, unknown>,
): string[] {
  if (!before) return []
  // `Object.hasOwn`, not `k in sent`: an inherited key (`toString`, `constructor`)
  // would otherwise read as "the caller sent this" and silence a real omission.
  return Object.keys(before)
    .filter((k) => {
      if (Object.hasOwn(sent, k)) return false
      const was = before[k]
      if (was == null) return false
      // An empty array/object was already doing nothing, so losing it is not a
      // loss — reporting it would train the reader to ignore this field.
      if (Array.isArray(was)) return was.length > 0
      if (typeof was === 'object') return Object.keys(was).length > 0
      return true
    })
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

/**
 * The agent READ surface that workflows already had.
 *
 * Agents and workflows have the identical entity → draft → versions model, and
 * workflows got seven lifecycle tools to agents' two. The asymmetry was not a
 * decision — `publish_agent`'s absence is argued, but "what did v7 look like" and
 * "which workflows run this" never were. Without them a model could not answer
 * when a regression started, could not restore a known-good config, and could not
 * say what a publish would affect.
 */
export function agentReadTools(): WfMcpTool[] {
  return [
    {
      name: 'list_agent_versions',
      title: 'List agent versions',
      description: [
        'The published version history of one agent, newest first — each version’s number, its author’s change note and the AI summary of what moved. Pass `versionNumber` to read that version’s full config.',
        '',
        'This is how you answer "when did this regress", "what did the last publish actually change", and "what did it look like before". It is also the input to a rollback: update_agent_draft({ fromVersion }) restores one into the draft.',
        '',
        'Relevant to eval drift too. A Goal normally FLOATS to the agent’s latest published version, so republishing changes everything under test while leaving every sample’s hash identical — get_eval_run reports that as `agentRepublishedSinceLastRun`, and this is what says which version it moved to and what changed in it.',
      ].join('\n'),
      inputSchema: {
        agentId: z.string().describe('Agent id, from list_agents.'),
        versionNumber: z
          .number()
          .nullish()
          .describe(
            'Drill in: return this version’s full AgentConfig instead of the history list.',
          ),
      },
      readOnly: true,
      run: async (client, args) => {
        const agentId = reqString(args.agentId, 'agentId')
        const detail = await client.getAgent(agentId)
        if (!detail) return { error: `No agent found for id ${agentId}.` }
        const versions = await client.listAgentVersions(agentId)
        const wanted =
          typeof args.versionNumber === 'number' ? args.versionNumber : undefined

        if (wanted != null) {
          const target = versions.find((v) => v.versionNumber === wanted)
          if (!target) {
            return {
              error: `Agent "${detail.agent.name}" has no version ${wanted}. Published: ${
                versions
                  .map((v) => v.versionNumber)
                  .sort((a, b) => a - b)
                  .join(', ') || '(none yet)'
              }.`,
            }
          }
          const full = await client.getAgentVersion(target.id)
          if (!full) {
            return { error: `Version ${wanted} could not be read back.` }
          }
          return {
            agentId,
            versionNumber: full.versionNumber,
            changeNote: target.changeNote,
            summary: target.aiSummaryShort,
            publishedAt: target.publishedAt,
            // Immutable, so this is exactly what ran — not a reconstruction.
            config: full.config,
            isLive: full.versionNumber === detail.agent.latestVersionNumber,
          }
        }

        return {
          agentId,
          name: detail.agent.name,
          live: detail.agent.latestVersionNumber,
          versions: [...versions]
            .sort((a, b) => b.versionNumber - a.versionNumber)
            .map((v) => ({
              versionNumber: v.versionNumber,
              changeNote: v.changeNote,
              summary: v.aiSummaryShort,
              details: v.aiSummaryLong,
              publishedAt: v.publishedAt,
            })),
          note:
            versions.length === 0
              ? 'This agent has never been published, so no workflow can run it yet.'
              : undefined,
        }
      },
    },

    {
      name: 'list_agent_calls',
      title: 'List agent calls',
      description: [
        'This agent’s most recent real executions, newest first — turns, tokens, USD, which tools it called and how often, and whether it stopped early. The evidence behind every tuning decision the config exposes.',
        '',
        'Read it before changing `maxTurns`, `toolTokenBudget`, `answerReservePercent` or the tool list. `stoppedOnTokenBudget` / `stoppedOnContextLimit` in particular explain a thin or truncated answer that otherwise reads as a prompt problem — the agent did not decide to stop, it ran out of room.',
        '`toolCalls` is how you see an agent reaching for the wrong tool, or never reaching for one it was given. A `spawn_*` / `await_subagents` id is a synthesized delegation tool, not a registered one.',
        '',
        'Real runs only: an eval’s simulated runs never appear here, so this is production behaviour and not test behaviour. An iteration fan-out folds into one row — `callCount` and `itemIndexes` say how many executions it covers.',
      ].join('\n'),
      inputSchema: {
        agentId: z.string().describe('Agent id, from list_agents.'),
        limit: z
          .number()
          .nullish()
          .describe(
            `How many rows (default ${DEFAULT_AGENT_CALLS}, max ${MAX_AGENT_CALLS}).`,
          ),
      },
      readOnly: true,
      run: async (client, args) => {
        const agentId = reqString(args.agentId, 'agentId')
        const limit = boundedLimit(
          args.limit,
          DEFAULT_AGENT_CALLS,
          MAX_AGENT_CALLS,
        )
        const calls = await client.listAgentCalls({ agentId, limit })
        const budgetCapped = calls.filter((c) => c.stoppedOnTokenBudget).length
        const contextCapped = calls.filter((c) => c.stoppedOnContextLimit).length
        return {
          agentId,
          count: calls.length,
          // Counted, not left to be spotted row by row: a pattern of hitting a
          // ceiling is a config finding, and one row hitting it is noise.
          stoppedEarly: { onTokenBudget: budgetCapped, onContextLimit: contextCapped },
          calls: calls.map((c) => ({
            runId: c.runId,
            nodeId: c.nodeId,
            workflow: c.workflowName,
            agentVersion: c.agentVersion,
            model: c.model,
            status: c.status,
            error: c.error,
            callCount: c.callCount,
            failedCount: c.failedCount,
            turns: c.turns,
            inputTokens: c.inputTokens,
            outputTokens: c.outputTokens,
            costUsd: c.costUsd,
            durationMs: c.durationMs,
            toolCalls: c.toolCalls,
            stoppedOnTokenBudget: c.stoppedOnTokenBudget,
            stoppedOnContextLimit: c.stoppedOnContextLimit,
            subAgentName: c.subAgentName,
          })),
          note:
            calls.length === 0
              ? 'This agent has never run in a real workflow — so nothing here says whether it works, only that nothing has used it. run_eval grades it against samples instead.'
              : budgetCapped > 0 || contextCapped > 0
                ? `${budgetCapped + contextCapped} of these calls ran out of room rather than finishing on their own. Raising toolTokenBudget / answerReservePercent, or trimming the tool set, is the lever — not the prompt.`
                : undefined,
        }
      },
    },
  ]
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
        icon: z
          .string()
          .nullish()
          .describe(
            'Icon name for the agent’s chip (e.g. "scale", "search"), as the console’s picker uses. Worth setting: without one, every agent in a workflow author’s node picker looks identical. An unknown name falls back to the default.',
          ),
        color: z
          .string()
          .nullish()
          .describe('Colour key for the chip (e.g. "amber", "sky").'),
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
          icon: optString(args.icon),
          color: optString(args.color),
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
      description: [
        'Replace an agent’s unsaved DRAFT config. Read get_agent first and send the WHOLE config back with your edits applied — this overwrites the draft outright, so any field you omit is LOST. Not a patch.',
        '',
        'The fields it is easiest to lose by omission, because nothing prompts for them: `subAgents` (the delegation whitelist — `targets`, `maxConcurrent`, `maxSpawns`, `allowStopSignal`), `toolTokenBudget`, `answerReservePercent`, `requireToolFirstTurn` and `webCitations`. An edit that reads a config, changes the prompt and re-sends will silently delete a sub-agent whitelist it never knew about. `removed` in the reply names anything that disappeared — check it.',
        '',
        'The config is checked before it is written, the same way create_agent checks it: the schema field by field, `modelId` against the enabled catalog, every `toolId` against the tool catalog, and the model’s capabilities against what the config needs. Those used to pass straight through, so a bogus model id or an unregistered tool saved cleanly and failed on the first real run.',
        '',
        '`fromVersion` restores a published version into the draft instead of sending a config — how you get back to a known-good agent after an edit made things worse, without relaying the whole object.',
        '',
        'Nothing is published: the draft changes what run_eval (with draftAgentId) and run_agent_preview measure, and no workflow runs it until a person publishes. It also replaces whatever draft someone had open in the editor, so say what you changed. Publishing is deliberately not available here.',
      ].join('\n'),
      inputSchema: {
        agentId: z.string().describe('Agent id, from list_agents.'),
        config: z
          .record(z.string(), z.unknown())
          .nullish()
          .describe(
            'The complete AgentConfig — the same object get_agent returns under `draft.config` / `currentVersion.config`, edited. Not a patch. Omit when using fromVersion.',
          ),
        fromVersion: z
          .number()
          .nullish()
          .describe(
            'Restore this published versionNumber into the draft instead of sending a config. Cannot be combined with `config`.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const agentId = reqString(args.agentId, 'agentId')
        const fromVersion =
          typeof args.fromVersion === 'number' ? args.fromVersion : undefined
        const raw = args.config
        const hasConfig = !!raw && typeof raw === 'object' && !Array.isArray(raw)
        if (fromVersion != null && hasConfig) {
          return {
            error:
              'Pass either `config` (an edit) or `fromVersion` (a restore), not both.',
          }
        }
        if (fromVersion == null && !hasConfig) {
          throw new Error(
            'Missing required argument `config` — the complete AgentConfig object, from get_agent. Or pass `fromVersion` to restore a published version.',
          )
        }
        const before = await client.getAgent(agentId)
        if (!before) return { error: `No agent found for id ${agentId}.` }
        const published = before.currentVersion?.config as
          | Record<string, unknown>
          | undefined

        let config: AgentConfig
        if (fromVersion != null) {
          const versions = await client.listAgentVersions(agentId)
          const target = versions.find((v) => v.versionNumber === fromVersion)
          if (!target) {
            return {
              error: `Agent ${agentId} has no published version ${fromVersion}. Published versions are ${
                versions.length > 0
                  ? versions
                      .map((v) => v.versionNumber)
                      .sort((a, b) => a - b)
                      .join(', ')
                  : '(none yet)'
              }.`,
            }
          }
          const full = await client.getAgentVersion(target.id)
          if (!full) {
            return { error: `Version ${fromVersion} could not be read back.` }
          }
          // A stored version was valid when it was published; running it through
          // the preflight anyway is not paranoia — the CATALOG moves underneath
          // it, so a version whose model has since been disabled is exactly what
          // a restore needs to be told about before it is graded.
          config = full.config
        } else {
          const checked = await preflightAgentConfig(client, raw)
          if ('error' in checked) return checked
          config = checked.config
        }

        await client.updateAgentDraft({ agentId, config })

        // Diff against the PUBLISHED version, not the previous draft: "what does
        // this agent now do differently from what is live" is the question a
        // person reviewing the draft has, and the one an accidental dropped
        // field answers loudly.
        const next = config as unknown as Record<string, unknown>
        // Against what was SENT, not what was stored — see `droppedKeys`. A
        // restore has no payload to check, and is deliberate by definition.
        const removed = hasConfig
          ? droppedKeys(
              before.draft?.config,
              raw as Record<string, unknown>,
            )
          : []
        return {
          ok: true,
          agentId,
          restoredFrom: fromVersion,
          draftDiffersFromPublishedIn: changedKeys(published, next),
          // Against the PREVIOUS DRAFT, because that is what this call
          // overwrote. `changedKeys` above answers "how does this differ from
          // live"; only this answers "did I just delete something".
          removed,
          warning:
            removed.length > 0
              ? `The config you sent DROPPED these fields, which the previous draft had set: ${removed.join(', ')}. If that was not deliberate, the config was incomplete — read get_agent again and re-send it whole.`
              : undefined,
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
        messages: z
          .array(
            z.object({
              role: z.string().describe('"user" or "assistant".'),
              text: z.string(),
            }),
          )
          .nullish()
          .describe(
            'Prior turns, in order, for an agent whose `inputKind` is `conversation` — the thread it answers, with `input` appended as the current turn. For such an agent the THREAD is the input, so previewing one with a single string tests it under conditions it never sees in production. Ignored for a `task` agent, whose only turn is its own userPrompt.',
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
        // Roles are narrowed here rather than in the schema: a z.enum would emit
        // JSON Schema a strict-mode client may drop (see the conventions note in
        // `tools.ts`), and the handler parses the array defensively anyway.
        const messages = (Array.isArray(args.messages) ? args.messages : [])
          .map((m) => m as { role?: unknown; text?: unknown })
          .filter(
            (m): m is { role: 'user' | 'assistant'; text: string } => { return (m.role === 'user' || m.role === 'assistant') &&
              typeof m.text === 'string' },
          )
        // The handler rejects this too, but from here the message can name the
        // variables this particular agent declares instead of the generic ask.
        if (
          !input &&
          messages.length === 0 &&
          Object.keys(promptVariables).length === 0
        ) {
          return {
            error:
              'Provide `input`, `messages` (for a conversation agent), or `promptVariables` for the agent’s `${…}` variables. get_agent shows which the prompts use.',
          }
        }
        // Not a refusal — the handler ignores `messages` for a task agent, so
        // this would otherwise be a silently-discarded argument, and the reader
        // would conclude the thread had been taken into account.
        const ignoredMessages =
          messages.length > 0 && chosen.config.inputKind !== 'conversation'

        const result = await client.runAgentPreview({
          config: chosen.config,
          input: input || undefined,
          promptVariables,
          messages: messages.length > 0 ? messages : undefined,
          // No `liveToolIds`, ever — see the note at the top of this file.
        })
        return {
          ranConfig: chosen.source,
          turnsSeeded: messages.length > 0 ? messages.length : undefined,
          warning: ignoredMessages
            ? `This agent's inputKind is "${chosen.config.inputKind}", so the ${messages.length} turn(s) you passed were IGNORED — only a conversation agent answers a thread. The reply above came from its userPrompt alone.`
            : undefined,
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
    {
      name: 'discard_agent_draft',
      title: 'Discard agent draft',
      description: [
        'Throw away an agent’s unsaved draft, so the editor and every preview show the published version again. The undo for update_agent_draft.',
        '',
        'It exists because the draft-only write path is justified partly on "the editor’s discard draft undoes it wholesale" — and that undo was reachable only by a person, so the model that wrote a bad draft could not take it back. The reply names the fields that were differing from the published version, since that is what is being thrown away.',
        '',
        'It also discards whatever a person had unsaved in the editor. Same caveat as the workflow twin: there is one draft row per agent and this clears it.',
      ].join('\n'),
      inputSchema: {
        agentId: z.string().describe('Agent id, from list_agents.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const agentId = reqString(args.agentId, 'agentId')
        const detail = await client.getAgent(agentId)
        if (!detail) return { error: `No agent found for id ${agentId}.` }
        if (!detail.draft) {
          return { ok: true, agentId, note: 'There was no draft to discard.' }
        }
        // Read what is being lost BEFORE losing it — a draft is unversioned, so
        // after this call the old config exists nowhere.
        const lost = changedKeys(
          detail.currentVersion?.config,
          detail.draft.config,
        )
        await client.discardAgentDraft({ agentId })
        return {
          ok: true,
          agentId,
          discarded: lost,
          note:
            lost.length === 0
              ? 'The draft already matched the published version, so nothing of substance was lost.'
              : `Those fields differed from v${detail.currentVersion?.versionNumber ?? '—'} and are gone. The published version is unchanged — it always was.`,
        }
      },
    },

    {
      name: 'update_agent',
      title: 'Rename or restyle an agent',
      description: [
        'Change an agent’s name, icon or colour. Nothing about its config is touched and nothing is published — for the config use update_agent_draft, and for the description use update_description.',
        '',
        'Cosmetic, and worth having for two reasons. A bad name is otherwise unfixable from here, and an MCP-authored catalog is otherwise visually undifferentiated — every agent in the console’s picker looks the same, which is a real cost when a workflow author is choosing between them.',
        '',
        'The name is what every agent node’s picker shows and what list_agents matches on; it is display metadata, not identity — the id is identity, and it never changes.',
      ].join('\n'),
      inputSchema: {
        agentId: z.string().describe('Agent id, from list_agents.'),
        name: z.string().nullish().describe('New name for the agent.'),
        icon: z
          .string()
          .nullish()
          .describe(
            'Icon name for the agent’s chip, as the console’s picker uses (e.g. "scale", "search"). An unknown name falls back to the default rather than erroring.',
          ),
        color: z
          .string()
          .nullish()
          .describe('Colour key for the agent’s chip (e.g. "amber", "sky").'),
      },
      readOnly: false,
      run: async (client, args) => {
        const agentId = reqString(args.agentId, 'agentId')
        const name = optString(args.name)
        const icon = optString(args.icon)
        const color = optString(args.color)
        if (!name && !icon && !color) {
          return {
            error:
              'Pass at least one of `name`, `icon` or `color`. For the description use update_description; for the config use update_agent_draft.',
          }
        }
        const before = await client.getAgent(agentId)
        if (!before) return { error: `No agent found for id ${agentId}.` }
        await client.updateAgentMeta({ agentId, name, icon, color })
        return {
          agentId,
          before: { name: before.agent.name },
          after: { name: name ?? before.agent.name, icon, color },
          // Named because a rename is the one cosmetic edit with a readable
          // consequence: it changes what a workflow author sees in the picker.
          referencedBy: before.agent.workflows.map((w) => w.name),
          note: 'Display only — no version was created and no workflow changed what it runs.',
        }
      },
    },

    {
      name: 'triage_feedback',
      title: 'Triage customer feedback',
      description: [
        'Acknowledge a piece of customer feedback and/or write the staff-only internal note on it — how it was investigated, what was found, what was done.',
        '',
        'This closes the loop the rest of this surface already supports. `list_feedback` calls thumbs-down rows "the highest-value input for authoring eval samples", and `draft_sample_from_run` exists to turn one into a test — but an agent that triaged a complaint, drafted the sample and fixed the draft could not acknowledge the row or write down what it did. So the queue never drained and the same item came back next session. `list_feedback` already RETURNS `internalNote`; this is the write it was missing.',
        '',
        'The internal note is staff-only and sits alongside the customer’s own note — the customer never sees it. Pass an empty string to clear it.',
        '',
        'Acknowledging does not delete or hide anything: it marks the row as dealt with so it drops out of the outstanding queue that get_dashboard counts.',
      ].join('\n'),
      inputSchema: {
        subjectId: z
          .string()
          .describe(
            'The rated subject’s id, as list_feedback returns it (`subjectId`) — not the run id.',
          ),
        acknowledged: z
          .boolean()
          .nullish()
          .describe(
            'true marks it dealt with and drops it out of the outstanding queue; false puts it back.',
          ),
        internalNote: z
          .string()
          .nullish()
          .describe(
            'The staff-only resolution note. Empty string clears it. The customer never sees this.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const subjectId = reqString(args.subjectId, 'subjectId')
        const acknowledged =
          typeof args.acknowledged === 'boolean' ? args.acknowledged : undefined
        // NOT `optString`: an empty note is the documented way to clear one, and
        // `optString` treats '' as absent — the same trap `update_description`
        // guards against.
        const note =
          typeof args.internalNote === 'string' ? args.internalNote : undefined
        if (acknowledged === undefined && note === undefined) {
          return {
            error:
              'Pass `acknowledged`, `internalNote`, or both — there is nothing else this tool changes.',
          }
        }
        // Resolve first: neither setter checks that the row exists, so a wrong
        // subjectId would update zero rows and answer `{ ok: true }`.
        const existing = await client.getFeedbackForSubjects({
          subjectIds: [subjectId],
        })
        const row = existing[0]
        if (!row) {
          return {
            error: `No feedback found for subject ${subjectId}. Ids come from list_feedback — its \`subjectId\`, which is the rated message, not the run.`,
          }
        }
        if (note !== undefined) {
          await client.setFeedbackInternalNote({
            subjectId,
            note: note.trim() === '' ? null : note,
          })
        }
        if (acknowledged !== undefined) {
          await client.setFeedbackAcknowledged({ subjectId, acknowledged })
        }
        return {
          subjectId,
          rating: row.rating,
          runId: row.runId,
          before: {
            // Stored as a TIMESTAMP, reported as a boolean plus the time: "was
            // this dealt with" is the question, and "when" is the evidence.
            acknowledged: row.acknowledgedAt != null,
            acknowledgedAt: row.acknowledgedAt,
            internalNote: row.internalNote,
          },
          after: {
            acknowledged: acknowledged ?? row.acknowledgedAt != null,
            internalNote: note === undefined ? row.internalNote : note || null,
          },
          note:
            acknowledged === true
              ? 'Marked dealt with, so it leaves the outstanding queue get_dashboard counts. The row and the customer’s own note are untouched.'
              : undefined,
        }
      },
    },
  ]
}
