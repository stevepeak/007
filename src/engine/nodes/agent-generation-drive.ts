import type {
  LanguageModel,
  ModelMessage,
  TextStreamPart,
  ToolSet,
} from 'ai'

import { errorFeedLine } from '../error-detail'
import type { StreamSink } from '../stream-sink'

import type { BudgetGuard } from './agent-generation-guard'
import { issueStructured, parseObject } from './agent-generation-structured'
import type { AgentLoopState } from './agent-generation-turn'

// ONE options object, driven two ways.
//
// `streamText` and `generateText` take the same arguments, so the loop's whole
// policy — the turn ceiling, the context guard, the spend budget, the watchdogs,
// the step tracing — is shared verbatim rather than reimplemented per path. The
// only difference is how the RESULT is obtained, which is exactly the difference
// that matters, and it is the whole of what lives here.
//
// Each driver takes a THUNK rather than the options, for two reasons: the call
// has to happen inside `runGuarded` (with `streamText`, failures surface while the
// stream is consumed, not when the call is made, so consuming has to happen where
// the guard can tell a stall from a budget overrun), and the options object is a
// bare literal whose tool types would be lost crossing a parameter here.

/**
 * Whether this generation streams its answer, and — implicitly — when.
 *
 * WHETHER: the sink was given a `delta` channel, which happens only on a backend
 * that can carry a token stream (inline), and only for the node whose output IS
 * the run's answer. See `StreamSink.delta`.
 *
 * WHEN is the subtler half, and it is why {@link driveStream} gates each delta on
 * `state.stepMustAnswer` rather than forwarding the lot. `result.text` is the
 * FINAL step's text, not the concatenation across steps, so streaming every delta
 * would show the reader any preamble an intermediate tool-calling turn wrote
 * ("Let me search…") and then leave it stranded above the real answer — text
 * already sent cannot be retracted, and the settled message would disagree with
 * what was on screen. So deltas are forwarded only from a step we KNOW must
 * answer: one where `prepareStep` denied tools, or where the agent has no tools
 * to call. What the reader sees is then exactly the final step's text, byte for
 * byte, and the bridge's reconciliation against `wf_run.output` is a clean no-op.
 *
 * The conservative direction is the safe one: a step we can't prove is the answer
 * simply isn't streamed, which is the pre-streaming behaviour.
 *
 * A structured answer is never streamed: its text is JSON for the schema, not
 * prose for a reader, and the delta channel feeds a chat bubble.
 */
export function canStreamAnswer(
  sink: StreamSink | undefined,
  schema: Record<string, unknown> | null,
): boolean {
  return typeof sink?.delta === 'function' && !schema
}

/** What either driver hands back — the four things the loop's tail reads. */
export type LoopOutcome = {
  text: string
  finishReason: string
  /**
   * The provider's own error, captured off the stream. Only the streaming path
   * can produce one; `generateText` throws instead.
   */
  streamError: unknown
  /** The structured object, when this was a structured agent. */
  object: unknown
}

export type DriveArgs = {
  state: AgentLoopState
  /** The RAW model — never the schema-wrapped answering one, which belongs to a
   * single turn. The transcript-formatting call carries its own schema. */
  model: LanguageModel
  modelId: string
  maxTurns: number
  /** Null for a text agent — which is also what makes the plain path plain. */
  schema: Record<string, unknown> | null
  systemPrompt: string
  /** The rendered conversation, for the transcript-formatting call. */
  messagesForModel: ModelMessage[]
  guard: BudgetGuard
  sink?: StreamSink
}

/** The part of a `generateText` result these drivers read. */
type GeneratedTurn = {
  text: string
  finishReason: string
  responseMessages: ModelMessage[]
}

/** The part of a `streamText` result these drivers read. `PromiseLike`, not
 * `Promise`, because that is what the SDK hands back for these two. */
type StreamedTurn = {
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>
  text: PromiseLike<string>
  finishReason: PromiseLike<string>
}

/**
 * The non-streaming path: one `generateText`, then read the answer back.
 *
 * For a text agent that is the whole job. For a structured one the object is the
 * answering turn's text when the loop got that far and it parses; otherwise — the
 * model answered early in prose on a research turn, or the JSON came back mangled
 * — one schema-only call over the transcript formats what the loop found.
 */
export async function driveGenerate(
  generate: () => Promise<GeneratedTurn>,
  args: DriveArgs,
): Promise<LoopOutcome> {
  const { state, modelId, maxTurns, schema, sink } = args
  const generated = await generate()
  if (!schema) {
    return {
      text: generated.text,
      finishReason: generated.finishReason,
      streamError: undefined,
      object: undefined,
    }
  }
  const early = parseObject(generated.text, state.stepMustAnswer)
  if (early !== undefined || generated.finishReason === 'error') {
    return {
      text: generated.text,
      finishReason: generated.finishReason,
      streamError: undefined,
      object: early,
    }
  }
  void sink?.log?.({
    level: 'info',
    message: state.stepMustAnswer
      ? `→ ${modelId} (answering turn was not the expected object — formatting the transcript to the schema)`
      : `→ ${modelId} (answered on turn ${state.stepTraces.length}/${maxTurns} — formatting the transcript to the schema)`,
  })
  // This call sees every tool result and the model's own wrap-up, so it is a
  // formatting step, not a second investigation; it is also the cheap re-issue
  // this path has, since replaying the loop would re-run its tools. The trailing
  // nudge matters: a transcript that ends on an assistant turn otherwise reads as
  // a continuation and some providers return nothing.
  const formatted = await issueStructured({
    model: args.model,
    modelId,
    systemPrompt: args.systemPrompt,
    messages: [
      ...args.messagesForModel,
      // Every step's messages — `response.messages` is the FINAL step's only,
      // which would drop the tool calls and results this is for.
      ...generated.responseMessages,
      {
        role: 'user',
        content:
          'Return the result now, in the expected structured form, from what you found above.',
      },
    ],
    schema,
    guard: args.guard,
    sink,
  })
  state.stepTraces.push({
    stepNumber: state.stepTraces.length,
    finishReason: formatted.finishReason,
    text: JSON.stringify(formatted.object),
    toolCalls: [],
    usage: formatted.usage
      ? {
          inputTokens: formatted.usage.inputTokens,
          outputTokens: formatted.usage.outputTokens,
        }
      : undefined,
  })
  state.totalUsage.inputTokens += formatted.usage?.inputTokens ?? 0
  state.totalUsage.outputTokens += formatted.usage?.outputTokens ?? 0
  return {
    text: JSON.stringify(formatted.object),
    finishReason: formatted.finishReason,
    streamError: undefined,
    object: formatted.object,
  }
}

/**
 * The streaming path: `streamText`, drain the full stream, then read the settled
 * promises.
 *
 * Only reached for a text agent on a backend that gave the sink a `delta` channel
 * (see `streamAnswer` in the loop). Deltas are forwarded only from a step we KNOW
 * must answer, so what the reader sees is exactly the final step's text, byte for
 * byte.
 */
export async function driveStream(
  start: () => StreamedTurn,
  args: DriveArgs,
): Promise<LoopOutcome> {
  const { state, modelId, sink } = args
  const stream = start()
  let streamedChars = 0
  // `streamText` NEVER rejects — by design. A failed round-trip arrives as an
  // `error` part, sets `finishReason` to `error`, and leaves `stream.text`
  // resolving to the empty string; the default `onError` is a bare
  // `console.error`. Ignoring the part therefore doesn't just lose the provider's
  // status code and response body — it converts a real failure into a silent
  // empty answer, which the caller then has to describe without knowing anything
  // about it. Keep the first one (later parts are usually knock-on effects of the
  // same fault) and let the caller decide whether it mattered.
  let streamError: unknown
  for await (const part of stream.fullStream) {
    if (part.type === 'error') {
      streamError ??= part.error
      // Named here whether or not it proves fatal: an error the agent went on to
      // recover from is invisible everywhere else, and it's exactly what explains
      // a turn that took far longer than its answer suggests.
      void sink?.log?.({
        level: 'error',
        message: `✕ ${modelId} stream error: ${errorFeedLine(part.error)}`,
      })
      continue
    }
    if (part.type === 'text-delta' && state.stepMustAnswer && part.text) {
      streamedChars += part.text.length
      await sink?.delta?.(part.text)
    }
  }
  // Whether the answer actually streamed is otherwise invisible — the deltas are
  // unpersisted by design, so a run that quietly fell back to delivering its
  // answer in one piece looks identical afterwards to one that streamed. Say so
  // in the feed, where it can be read against the run that produced it.
  void sink?.log?.({
    level: 'info',
    message: streamedChars
      ? `⇢ streamed ${streamedChars} chars of the answer live`
      : '⇢ answer not streamed (no step was forced to answer; delivered whole)',
    meta: { streamedChars },
  })
  // Awaited after the stream is drained, so these are settled.
  //
  // `stream.text` is the one promise here that CAN reject: when the call produced
  // no output at all — a request that died before any stream existed (bad model
  // id, revoked key, a 5xx on the first round-trip) — it rejects with a generic
  // `NoOutputGeneratedError` whose message is "No output generated. Check the
  // stream for errors." The error it's telling us to go and check is the part we
  // just captured, and that one is the only copy carrying the provider's status
  // code and response body. So prefer it, and fall back to the SDK's when we have
  // nothing better.
  try {
    return {
      text: await stream.text,
      finishReason: await stream.finishReason,
      streamError,
      object: undefined,
    }
  } catch (err) {
    if (streamError instanceof Error) throw streamError
    throw err
  }
}
