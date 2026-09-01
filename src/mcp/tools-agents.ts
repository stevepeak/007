import { z } from 'zod'

import { clip } from '../server/clip'
import type {
  AgentConfig,
  AgentNodeMeta,
  AgentPreviewResult,
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
//   • **Drafts, never publishes.** `publish_agent` is NOT here. A published
//     version floats into every workflow that references the agent (see the
//     float-to-latest rule), so publishing is the single action in this file's
//     neighborhood that changes what customers get. A draft changes what the
//     next eval run measures and nothing else, and the editor's "discard draft"
//     undoes it wholesale. The model proposes; a person ships.
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
