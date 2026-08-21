import type { EvalSampleInput, EvalTools } from './checks'
import { toolFixtures } from './checks'
import { seededMessagesToUiMessages } from './synthesis'

// The one place a Sample's AUTHORING shape (input + tools) becomes the ENGINE's
// run signals. Keeping the translation here — pure, and covered by
// `invoke.test.ts` — is what lets the two vocabularies stay separate: an author
// picks "conversation input, frozen tools", and the executor only ever sees
// `triggerInput` / `promptVariables` / `fixtures` / `freezeTools` / `liveReads`.
//
// Before the split these signals were assembled inline in the run handler from
// four independently-authorable fields, where `seededMessages` silently won over
// `triggerInput` and `freezeTools` silently voided `fixtures`. The union makes
// each combination explicit and unrepresentable-if-contradictory.

/** The engine-facing signals one Sample invocation runs with. */
export type EvalInvocation = {
  /** What the trigger emits — a seeded thread for a conversation Sample. */
  triggerInput: Record<string, unknown>
  /** Values the target's prompt `${vars}` interpolate from. */
  promptVariables: Record<string, string>
  /** Canned read-tool outputs; empty outside `mocked`. */
  fixtures: Record<string, unknown>
  /** Run the agent with no tools at all (`frozen`). */
  freezeTools: boolean
  /** Let read tools execute for real instead of returning a fixture (`live`). */
  liveReads: boolean
}

/**
 * Translate a Sample's authored input + tools into the run signals the engine
 * takes. Write tools stay neutralized in every mode — the caller runs with
 * `simulate: true` regardless, and `liveReads` only re-enables the READ side.
 */
export function evalInvocation(
  input: EvalSampleInput,
  tools: EvalTools,
): EvalInvocation {
  return {
    ...invocationInput(input),
    fixtures: toolFixtures(tools),
    freezeTools: tools.mode === 'frozen',
    liveReads: tools.mode === 'live',
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
