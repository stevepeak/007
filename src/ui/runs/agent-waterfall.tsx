import {
  type AgentTimeline,
  type TimelineSegment,
  type TimelineSegmentKind,
  agentTimeline,
  describeSlowest,
  segmentPhrase,
} from '../../engine/agent-timeline'
import { cn } from '../cn'
import { formatDurationMs } from '../cost'
import { Tooltip } from '../tooltip'

// The per-agent-step waterfall: one bar per turn on a shared time axis, split
// into the phases the engine timed, with each tool call as its own thin bar
// beneath the turn that made it. The question it answers is the one a slow
// agent step raises — was it the model (and was the model thinking or
// writing?), or was it a tool — and the headline answers it in words before
// the reader has to read the bars.
//
// All the arithmetic is `agentTimeline` in the engine (shared with the trace
// exporter and the MCP server); this file only draws it. Steps recorded before
// timing existed have no timeline, and render nothing here.

const SEGMENT_FILL: Record<TimelineSegmentKind, string> = {
  waiting: 'bg-neutral-300',
  thinking: 'bg-violet-400',
  generating: 'bg-emerald-400',
  model: 'bg-neutral-400',
  tools: 'bg-sky-300',
}

const SEGMENT_LABEL: Record<TimelineSegmentKind, string> = {
  waiting: 'First token',
  thinking: 'Thinking',
  generating: 'Generating',
  model: 'Model',
  tools: 'Tools',
}

/** Offsets as a share of the axis, for absolute positioning. */
function place(
  span: { startMs: number; endMs: number },
  totalMs: number,
): { left: string; width: string } {
  if (totalMs <= 0) return { left: '0%', width: '0%' }
  return {
    left: `${(span.startMs / totalMs) * 100}%`,
    width: `${((span.endMs - span.startMs) / totalMs) * 100}%`,
  }
}

function Bar({
  span,
  totalMs,
  className,
  tip,
}: {
  span: { startMs: number; endMs: number }
  totalMs: number
  className: string
  tip: string
}) {
  // A floor of 2px, so a 40ms tool call on a 10-minute axis is still a mark
  // you can hover rather than nothing at all.
  return (
    <div
      className="absolute inset-y-0"
      style={{ ...place(span, totalMs), minWidth: 2 }}
    >
      <Tooltip content={tip} className="h-full w-full">
        <span className={cn('h-full w-full rounded-sm', className)} />
      </Tooltip>
    </div>
  )
}

function isSlowest(
  timeline: AgentTimeline,
  turnIndex: number,
  seg: TimelineSegment,
): boolean {
  const s = timeline.slowest
  return s != null && s.turnIndex === turnIndex && s.kind === seg.kind
}

export function AgentWaterfall({ meta }: { meta: unknown }) {
  const timeline = agentTimeline(meta)
  if (!timeline || timeline.totalMs <= 0) return null
  const { totalMs, turns, slowest } = timeline
  const kinds = new Set(turns.flatMap((t) => t.segments.map((s) => s.kind)))
  return (
    <div className="mb-3 rounded-lg border border-neutral-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[10px] font-medium tracking-wide text-neutral-400 uppercase">
          Timeline
        </span>
        <span className="text-xs font-semibold text-neutral-800 tabular-nums">
          {formatDurationMs(totalMs)}
        </span>
        {slowest ? (
          <span className="text-[11px] text-amber-700">
            {describeSlowest(slowest)}
          </span>
        ) : null}
        <span className="ml-auto flex flex-wrap gap-2">
          {[...kinds].map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 text-[10px] text-neutral-500"
            >
              <span className={cn('size-2 rounded-sm', SEGMENT_FILL[k])} />
              {SEGMENT_LABEL[k]}
            </span>
          ))}
        </span>
      </div>
      <div className="mt-1.5 space-y-1">
        {turns.map((turn) => (
          <div key={turn.index} className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 truncate text-[10px] font-medium text-neutral-500">
                Turn {turn.index + 1}
              </span>
              <div className="relative h-3 min-w-0 flex-1 rounded-sm bg-neutral-50">
                {turn.segments.map((seg, i) => (
                  <Bar
                    key={i}
                    span={seg}
                    totalMs={totalMs}
                    className={cn(
                      SEGMENT_FILL[seg.kind],
                      // Tools overlap the model on a streamed turn — the SDK
                      // runs a tool as soon as its call arrives — so the tool
                      // phase is drawn translucent over the model phases.
                      seg.kind === 'tools' && 'opacity-60',
                      isSlowest(timeline, turn.index, seg) &&
                        'ring-2 ring-amber-400 ring-offset-1',
                    )}
                    tip={`Turn ${turn.index + 1} · ${segmentPhrase(seg.kind)} · ${formatDurationMs(seg.endMs - seg.startMs)}`}
                  />
                ))}
              </div>
              <span className="w-12 shrink-0 text-right text-[10px] text-neutral-500 tabular-nums">
                {formatDurationMs(turn.endMs - turn.startMs)}
              </span>
            </div>
            {turn.toolCalls.map((tc) => (
              <div key={tc.toolCallId} className="flex items-center gap-2">
                <span className="w-24 shrink-0 truncate pl-2 text-[10px] text-neutral-400">
                  {tc.toolName}
                </span>
                <div className="relative h-1.5 min-w-0 flex-1">
                  <Bar
                    span={tc}
                    totalMs={totalMs}
                    className={tc.failed ? 'bg-red-400' : 'bg-sky-500'}
                    tip={`${tc.toolName} · ${formatDurationMs(tc.endMs - tc.startMs)}${tc.failed ? ' · failed' : ''}`}
                  />
                </div>
                <span className="w-12 shrink-0 text-right text-[10px] text-neutral-400 tabular-nums">
                  {formatDurationMs(tc.endMs - tc.startMs)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
