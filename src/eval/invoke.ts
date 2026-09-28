import type { EvalSampleInput, EvalToolMode, EvalTools } from '../engine/eval-schema'
import { toolFixtures, toolModes } from '../engine/eval-schema'

import { seededMessagesToUiMessages } from './synthesis'

// The one place a Sample's AUTHORING shape (input + tools) becomes the ENGINE's
// run signals. Keeping the translation here — pure, and covered by
// `invoke.test.ts` — is what lets the two vocabularies stay separate: an author
// picks "a conversation input, this tool pinned and that one live", and the
// executor only ever sees `triggerInput` / `promptVariables` / `fixtures` /
// `toolModes` / `liveReads`.
//
// Before the split these signals were assembled inline in the run handler from
// four independently-authorable fields, where `seededMessages` silently won over
// `triggerInput` and `freezeTools` silently voided `fixtures`.

/** The engine-facing signals one Sample invocation runs with. */
export type EvalInvocation = {
  /** What the trigger emits — a seeded thread for a conversation Sample. */
  triggerInput: Record<string, unknown>
  /** Values the target's prompt `${vars}` interpolate from. */
  promptVariables: Record<string, string>
  /** Canned outputs for the mocked read tools, keyed by tool id. */
  fixtures: Record<string, unknown>
  /**
   * Which read tools run live and which return their fixture, by tool id. The
   * engine consults this first and falls back to `liveReads` for a tool the
   * sample says nothing about.
   */
  toolModes: Record<string, EvalToolMode>
  /** What a tool with no entry in `toolModes` does — see `EvalTools.fallback`. */
  liveReads: boolean
}

/**
 * Translate a Sample's authored input + tools into the run signals the engine
 * takes. Write tools stay neutralized whatever a tool's mode says — the caller
 * runs with `simulate: true` regardless, and a `live` tool only re-enables the
 * READ side.
 */
export function evalInvocation(
  input: EvalSampleInput,
  tools: EvalTools,
): EvalInvocation {
  return {
    ...invocationInput(input),
    fixtures: toolFixtures(tools),
    toolModes: toolModes(tools),
    liveReads: tools.fallback === 'live',
  }
}

function invocationInput(
  input: EvalSampleInput,
): Pick<EvalInvocation, 'triggerInput' | 'promptVariables'> {
  switch (input.kind) {
    // The authored transcript BECOMES the agent's message history, reaching it
    // through the wrapper's `conversation` binding on `trigger.messages`. The
    // run starts mid-conversation and the model produces only its next reply.
    case 'conversation':
      return {
        triggerInput: { messages: seededMessagesToUiMessages(input.turns) },
        promptVariables: input.variables,
      }
    // A workflow target has no single prompt to fill in — it receives whatever
    // its trigger routed, verbatim.
    case 'trigger':
      return {
        triggerInput: input.payload,
        promptVariables: input.variables,
      }
    // A task agent's only turn is its own `userPrompt`, so the Sample supplies
    // the values that template interpolates from and nothing else.
    case 'task':
      return { triggerInput: {}, promptVariables: input.variables }
  }
}
