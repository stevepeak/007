import type {
  AgentNodeMeta,
  AgentTurnTiming,
} from './nodes/agent-generation-types'
import { formatElapsedMs } from './text'

// Where an agent step's time went, derived from the timing its turns recorded.
//
// Three readers ask the same question in three shapes — the run viewer draws it
// as a waterfall, the trace exporter turns it into child spans, the MCP server
// summarises it for a model — so the arithmetic lives here once, pure, in the
// layer all three can import. Every reader must cope with `null`: steps recorded
// before turn timing existed have none, and the honest rendering of those is no
// timeline at all.

/**
 * One phase of a turn.
 *   - waiting    : model call started, no output chunk yet (queueing, prefill)
 *   - thinking   : the model's reasoning, first reasoning chunk to first
 *                  non-reasoning chunk
 *   - generating : the model writing its answer or tool calls
 *   - model      : a model call that wasn't streamed, so can't be split
 *   - tools      : first tool start to last tool end
 */
export type TimelineSegmentKind =
  'waiting' | 'thinking' | 'generating' | 'model' | 'tools'

/** A span of time, in ms offsets from the timeline's origin. */
export type TimelineSpan = { startMs: number; endMs: number }

export type TimelineSegment = TimelineSpan & { kind: TimelineSegmentKind }

export type TimelineToolCall = TimelineSpan & {
  toolCallId: string
  toolName: string
  failed: boolean
}

export type TimelineTurn = TimelineSpan & {
  /** Zero-based position in `meta.steps`. */
  index: number
  segments: TimelineSegment[]
  toolCalls: TimelineToolCall[]
}

/** The single largest segment of the step — where to look first. */
export type TimelineSlowest = {
  turnIndex: number
  kind: TimelineSegmentKind
  ms: number
  /** `ms` as a share of the whole timeline, 0..1. */
  share: number
  /** For a `tools` segment: the slowest call in it. */
  toolName?: string
  toolMs?: number
}

export type AgentTimeline = {
  /** Epoch ms every offset is relative to: the first timed turn's start. */
  originAt: number
  totalMs: number
  turns: TimelineTurn[]
  slowest: TimelineSlowest | null
}

type Step = AgentNodeMeta['steps'][number]

/**
 * A turn's model phases, as offsets from the turn's start. The model call is
 * taken to begin with the turn (see `AgentTurnTiming`), and every phase is
 * clamped inside it so a rounding wobble can't draw past the call's end.
 */
export function modelSegments(turn: AgentTurnTiming): TimelineSegment[] {
  const modelMs = turn.modelMs
  if (modelMs == null || modelMs <= 0) return []
  const clamp = (ms: number) => Math.min(Math.max(ms, 0), modelMs)
  if (turn.firstOutputMs == null) {
    return [{ kind: 'model', startMs: 0, endMs: modelMs }]
  }
  const firstOutput = clamp(turn.firstOutputMs)
  // Recorded reasoning always begins at the first output chunk — reasoning that
  // started after the answer did isn't recorded (see `turnTiming`).
  const reasoningEnd = clamp(firstOutput + (turn.reasoningMs ?? 0))
  const out: TimelineSegment[] = []
  if (firstOutput > 0)
    out.push({ kind: 'waiting', startMs: 0, endMs: firstOutput })
  if (reasoningEnd > firstOutput) {
    out.push({ kind: 'thinking', startMs: firstOutput, endMs: reasoningEnd })
  }
  if (modelMs > reasoningEnd) {
    out.push({ kind: 'generating', startMs: reasoningEnd, endMs: modelMs })
  }
  return out
}

function readSteps(meta: unknown): Step[] | null {
  const steps = (meta as { steps?: unknown } | null | undefined)?.steps
  return Array.isArray(steps) ? (steps as Step[]) : null
}

/**
 * Lay an agent step's turns out on one time axis. Null when no turn carries
 * timing — a step recorded before timing existed, or not an agent step at all.
 * Takes `unknown` because every caller reads it off a stored `meta` column.
 */
export function agentTimeline(meta: unknown): AgentTimeline | null {
  const steps = readSteps(meta)
  if (!steps) return null
  const timed = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => {
      return (
        typeof step.startedAt === 'number' &&
        typeof step.durationMs === 'number'
      )
    })
  if (timed.length === 0) return null

  const originAt = Math.min(...timed.map(({ step }) => step.startedAt!))
  const turns: TimelineTurn[] = timed.map(({ step, index }) => {
    const turnStart = step.startedAt! - originAt
    const toolCalls: TimelineToolCall[] = (step.toolCalls ?? [])
      .filter((tc) => {
        return (
          typeof tc.startedAt === 'number' && typeof tc.finishedAt === 'number'
        )
      })
      .map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        failed: tc.failed === true,
        startMs: tc.startedAt! - originAt,
        endMs: tc.finishedAt! - originAt,
      }))
    const segments = modelSegments(step).map((s) => ({
      ...s,
      startMs: s.startMs + turnStart,
      endMs: s.endMs + turnStart,
    }))
    if (toolCalls.length > 0) {
      segments.push({
        kind: 'tools',
        startMs: Math.min(...toolCalls.map((t) => t.startMs)),
        endMs: Math.max(...toolCalls.map((t) => t.endMs)),
      })
    }
    return {
      index,
      startMs: turnStart,
      endMs: turnStart + step.durationMs!,
      segments,
      toolCalls,
    }
  })
  const totalMs = Math.max(
    ...turns.map((t) => t.endMs),
    ...turns.flatMap((t) => t.toolCalls.map((tc) => tc.endMs)),
  )
  return { originAt, totalMs, turns, slowest: slowestSegment(turns, totalMs) }
}

function slowestSegment(
  turns: TimelineTurn[],
  totalMs: number,
): TimelineSlowest | null {
  let best: TimelineSlowest | null = null
  for (const turn of turns) {
    for (const seg of turn.segments) {
      const ms = seg.endMs - seg.startMs
      if (ms <= 0 || (best && ms <= best.ms)) continue
      best = {
        turnIndex: turn.index,
        kind: seg.kind,
        ms,
        share: totalMs > 0 ? ms / totalMs : 0,
      }
      if (seg.kind === 'tools') {
        const call = turn.toolCalls.reduce((a, b) => {
          return b.endMs - b.startMs > a.endMs - a.startMs ? b : a
        })
        best.toolName = call.toolName
        best.toolMs = call.endMs - call.startMs
      }
    }
  }
  return best
}

const SEGMENT_PHRASE: Record<TimelineSegmentKind, string> = {
  waiting: "waiting for the model's first token",
  thinking: 'model reasoning',
  generating: 'the model writing its output',
  model: 'the model call',
  tools: 'running tools',
}

/** What a segment kind is, in a reader's words. */
export function segmentPhrase(kind: TimelineSegmentKind): string {
  return SEGMENT_PHRASE[kind]
}

/** "73% of this step was model reasoning on turn 2". */
export function describeSlowest(slowest: TimelineSlowest): string {
  const pct = Math.round(slowest.share * 100)
  const tool =
    slowest.kind === 'tools' && slowest.toolName
      ? ` (slowest call: ${slowest.toolName}, ${formatElapsedMs(slowest.toolMs ?? 0)})`
      : ''
  return `${pct}% of this step was ${SEGMENT_PHRASE[slowest.kind]}${tool} on turn ${slowest.turnIndex + 1}`
}

/** One span a trace exporter should emit, with absolute epoch-ms bounds. */
export type TimingSpan = {
  op: 'wf.agent.turn' | 'wf.tool.call'
  name: string
  startAt: number
  endAt: number
  attributes: Record<string, string | number | boolean>
  children: TimingSpan[]
}

/**
 * The child spans an agent step's turns become in a trace: one `wf.agent.turn`
 * per timed turn, each holding one `wf.tool.call` per timed tool call. Empty
 * for a step with no timing. The exporter owns the tracer; this owns only what
 * the spans say.
 */
export function agentTimingSpans(meta: unknown): TimingSpan[] {
  const steps = readSteps(meta)
  if (!steps) return []
  const count = steps.length
  const out: TimingSpan[] = []
  for (const [i, step] of steps.entries()) {
    if (
      typeof step.startedAt !== 'number' ||
      typeof step.durationMs !== 'number'
    ) {
      continue
    }
    const attributes: TimingSpan['attributes'] = {
      'wf.turn': i + 1,
      'wf.turn_count': count,
      'wf.duration_ms': step.durationMs,
    }
    if (step.modelMs != null) attributes['wf.model_ms'] = step.modelMs
    if (step.reasoningMs != null)
      attributes['wf.reasoning_ms'] = step.reasoningMs
    if (step.firstOutputMs != null) {
      attributes['wf.first_output_ms'] = step.firstOutputMs
    }
    if (step.toolMs != null) attributes['wf.tool_ms'] = step.toolMs
    out.push({
      op: 'wf.agent.turn',
      name: `Turn ${i + 1} of ${count}`,
      startAt: step.startedAt,
      endAt: step.startedAt + step.durationMs,
      attributes,
      children: (step.toolCalls ?? [])
        .filter((tc) => {
          return (
            typeof tc.startedAt === 'number' &&
            typeof tc.finishedAt === 'number'
          )
        })
        .map((tc) => ({
          op: 'wf.tool.call' as const,
          name: tc.toolName,
          startAt: tc.startedAt!,
          endAt: tc.finishedAt!,
          attributes: {
            'wf.tool_id': tc.toolName,
            'wf.tool_call_id': tc.toolCallId,
            'wf.duration_ms': tc.durationMs ?? tc.finishedAt! - tc.startedAt!,
            'wf.tool_failed': tc.failed === true,
          },
          children: [],
        })),
    })
  }
  return out
}

/**
 * A compact, model-readable account of an agent step's timing: per turn, where
 * the time went, and each tool call's duration. Null when the step has none.
 * Small on purpose — it rides alongside a `meta` that is often clipped, so it
 * must survive where the full trace doesn't.
 */
export function agentTimingSummary(meta: unknown): {
  totalMs: number
  slowest: string | null
  turns: Array<{
    turn: number
    durationMs: number
    modelMs?: number
    reasoningMs?: number
    firstOutputMs?: number
    toolMs?: number
    toolCalls: Array<{ tool: string; durationMs: number; failed?: true }>
  }>
} | null {
  const timeline = agentTimeline(meta)
  const steps = readSteps(meta)
  if (!timeline || !steps) return null
  return {
    totalMs: timeline.totalMs,
    slowest: timeline.slowest ? describeSlowest(timeline.slowest) : null,
    turns: timeline.turns.map((t) => {
      const step = steps[t.index]
      return {
        turn: t.index + 1,
        durationMs: t.endMs - t.startMs,
        ...(step.modelMs != null ? { modelMs: step.modelMs } : {}),
        ...(step.reasoningMs != null ? { reasoningMs: step.reasoningMs } : {}),
        ...(step.firstOutputMs != null
          ? { firstOutputMs: step.firstOutputMs }
          : {}),
        ...(step.toolMs != null ? { toolMs: step.toolMs } : {}),
        toolCalls: t.toolCalls.map((tc) => ({
          tool: tc.toolName,
          durationMs: tc.endMs - tc.startMs,
          ...(tc.failed ? { failed: true as const } : {}),
        })),
      }
    }),
  }
}
