import { interpolateUserText } from '../prompt-variables'
import type { StreamSink } from '../stream-sink'
import { formatElapsedMs } from '../text'

import type {
  AgentToolCallTiming,
  AgentTurnTiming,
} from './agent-generation-types'

// Where a turn's time goes — the model call, the reasoning inside it, each tool
// call — measured from the AI SDK's own lifecycle callbacks.
//
// `onStepFinish` alone cannot answer this: it fires once, after the model AND
// every tool of the turn are done, so everything it knows carries the same
// instant. The SDK hands out finer seams (step start, model call start/end,
// tool execution start/end, and on the streaming path every chunk); this module
// listens on all of them, keeps per-turn notes, and hands the turn's figures to
// the tracer when the turn is recorded.
//
// It also owns the live TOOL lines in the run feed. A tool line written at turn
// end carries the turn-end timestamp, which made a 4-minute model call followed
// by a 2-second search indistinguishable from the reverse. Writing it from the
// execution callbacks stamps it with the real start, and the end line carries
// the real duration.

/** One SDK tool call as the execution callbacks describe it. */
type ToolCallRef = { toolCallId: string; toolName: string; input: unknown }

/** Per-turn notes, reset at each step start. */
type TurnNotes = {
  startedAt?: number
  modelStartedAt?: number
  modelEndedAt?: number
  firstOutputAt?: number
  firstReasoningAt?: number
  firstNonReasoningAt?: number
}

export type TurnClockArgs = {
  /** Display only — the user-facing status line per tool. */
  streamToolCalls: boolean
  toolStatusLabels?: Record<string, string>
  sink?: StreamSink
  /** Injectable for tests. */
  now?: () => number
}

/**
 * The live clock for one tool loop. Its `callbacks` go onto the SDK call
 * options; `onChunk` goes onto the streaming call only; the tracer reads a
 * finished turn back with `takeTurn`.
 */
export type TurnClock = ReturnType<typeof createTurnClock>

/** Chunk kinds that are model output (as opposed to bookkeeping parts). */
const REASONING_CHUNK = 'reasoning-delta'
const NON_REASONING_OUTPUT_CHUNKS = new Set([
  'text-delta',
  'tool-input-start',
  'tool-call',
])

export function createTurnClock(args: TurnClockArgs) {
  const now = args.now ?? Date.now
  const { sink } = args
  let turn: TurnNotes = {}
  const tools = new Map<string, AgentToolCallTiming>()
  // Calls whose start line went out live, so the turn-end fallback doesn't
  // write a second one.
  const announced = new Set<string>()

  const announce = (tc: ToolCallRef, ts: number) => {
    announced.add(tc.toolCallId)
    logToolCallStart(args, tc, ts)
  }

  const callbacks = {
    onStepStart: () => {
      turn = { startedAt: now() }
    },
    onLanguageModelCallStart: () => {
      // The first attempt's start: a retried call's time is still model time.
      turn.modelStartedAt ??= now()
    },
    onLanguageModelCallEnd: () => {
      turn.modelEndedAt = now()
    },
    onToolExecutionStart: (event: { toolCall: ToolCallRef }) => {
      const startedAt = now()
      tools.set(event.toolCall.toolCallId, { startedAt })
      announce(event.toolCall, startedAt)
    },
    onToolExecutionEnd: (event: {
      toolCall: ToolCallRef
      toolOutput: { type: string }
    }) => {
      const finishedAt = now()
      const { toolCallId, toolName } = event.toolCall
      const startedAt = tools.get(toolCallId)?.startedAt ?? finishedAt
      const failed = event.toolOutput.type === 'tool-error'
      const durationMs = finishedAt - startedAt
      tools.set(toolCallId, {
        startedAt,
        finishedAt,
        durationMs,
        ...(failed ? { failed: true } : {}),
      })
      void sink?.log?.({
        ts: finishedAt,
        level: 'tool',
        message: `${toolName} ${failed ? 'failed after' : 'finished in'} ${formatElapsedMs(durationMs)}`,
        meta: {
          tool: toolName,
          toolCallId,
          durationMs,
          ...(failed ? { failed: true } : {}),
        },
      })
    },
  }

  return {
    callbacks,
    /** For `streamText` only — `generateText` has no chunks. */
    onChunk: (event: { chunk: { type: string } }) => {
      const type = event.chunk.type
      const reasoning = type === REASONING_CHUNK
      if (!reasoning && !NON_REASONING_OUTPUT_CHUNKS.has(type)) return
      const t = now()
      turn.firstOutputAt ??= t
      if (reasoning) turn.firstReasoningAt ??= t
      else turn.firstNonReasoningAt ??= t
    },
    /** Whether this call's start line already went out live. */
    announced: (toolCallId: string) => announced.has(toolCallId),
    /**
     * When the model's reasoning for the current turn ended, if it was timed —
     * the honest timestamp for that turn's thinking line, which is otherwise
     * written at turn end, after the tools it led to.
     */
    reasoningEndedAt: (): number | undefined => {
      return turn.firstNonReasoningAt ?? turn.modelEndedAt
    },
    /** Timing for one tool call of the turn being recorded, if it executed. */
    toolTiming: (toolCallId: string): AgentToolCallTiming | undefined => {
      return tools.get(toolCallId)
    },
    /**
     * The current turn's figures, closed at `now`. Empty when the turn was never
     * opened (a caller driving `onStepFinish` by hand).
     */
    takeTurn: (toolCallIds: string[]): AgentTurnTiming => {
      const endedAt = now()
      const timing = turnTiming({
        notes: turn,
        endedAt,
        tools: toolCallIds
          .map((id) => tools.get(id))
          .filter((t): t is AgentToolCallTiming => t != null),
      })
      turn = {}
      return timing
    },
  }
}

/**
 * The "Called X" dev line, plus the user-facing status line when the node opted
 * into one and the tool has a template. `ts` is omitted on the turn-end
 * fallback (a call that never reached `execute` — provider-executed, or input
 * that failed validation), where the sink's own stamp is already the truth.
 */
export function logToolCallStart(
  args: Pick<TurnClockArgs, 'sink' | 'streamToolCalls' | 'toolStatusLabels'>,
  tc: ToolCallRef,
  ts?: number,
): void {
  const { sink } = args
  if (!sink) return
  const stamp = ts != null ? { ts } : {}
  void sink.log?.({
    ...stamp,
    level: 'tool',
    message: `Called ${tc.toolName}`,
    meta: { tool: tc.toolName, input: tc.input, toolCallId: tc.toolCallId },
  })
  if (!args.streamToolCalls) return
  const template = args.toolStatusLabels?.[tc.toolName]
  const message = template && interpolateUserText(template, tc.input).trim()
  if (message) {
    void sink.log?.({
      ...stamp,
      level: 'progress',
      message,
      meta: { progress: 'tool', tool: tc.toolName },
    })
  }
}

/**
 * Fold a turn's raw instants into the recorded figures. Pure, so the arithmetic
 * — in particular what counts as reasoning — is testable without a model.
 */
export function turnTiming(args: {
  notes: TurnNotes
  endedAt: number
  tools: AgentToolCallTiming[]
}): AgentTurnTiming {
  const { notes, endedAt } = args
  if (notes.startedAt == null) return {}
  const out: AgentTurnTiming = {
    startedAt: notes.startedAt,
    durationMs: Math.max(0, endedAt - notes.startedAt),
  }
  const modelStart = notes.modelStartedAt ?? notes.startedAt
  if (notes.modelEndedAt != null) {
    out.modelMs = Math.max(0, notes.modelEndedAt - modelStart)
  }
  if (notes.firstOutputAt != null) {
    out.firstOutputMs = Math.max(0, notes.firstOutputAt - modelStart)
  }
  // Reasoning is the run of reasoning chunks before the model switched to
  // writing — or, for a turn that reasoned and then simply ended, up to the end
  // of the model call. Reasoning that arrives AFTER the answer began isn't the
  // wait the reader is asking about, so it doesn't count.
  if (notes.firstReasoningAt != null) {
    const until = notes.firstNonReasoningAt ?? notes.modelEndedAt
    if (until != null && until >= notes.firstReasoningAt) {
      out.reasoningMs = until - notes.firstReasoningAt
    }
  }
  const timed = args.tools.filter(
    (t) => t.startedAt != null && t.finishedAt != null,
  )
  if (timed.length > 0) {
    const first = Math.min(...timed.map((t) => t.startedAt!))
    const last = Math.max(...timed.map((t) => t.finishedAt!))
    out.toolMs = last - first
  }
  return out
}
