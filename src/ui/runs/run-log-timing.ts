import type { AgentNodeMeta } from '../../server/protocol'
import { formatDurationMs } from '../cost'

// The duration text on the run log's "Turn N of M" and tool-call rows. Pure, so
// the rules — what a turn's breakdown names, and that an untimed step names
// nothing — are tested away from the markup.

type Step = AgentNodeMeta['steps'][number]
type ToolCall = Step['toolCalls'][number]

/**
 * `4m 53s · model 4m 41s (thinking 3m 10s) · tools 12s` — or null for a turn
 * recorded before timing existed. Thinking appears only when the provider
 * streamed its reasoning separately; otherwise model time can't be split.
 */
export function turnDurationLabel(step: Step): string | null {
  if (step.durationMs == null) return null
  const parts = [formatDurationMs(step.durationMs)]
  if (step.modelMs != null) {
    const thinking =
      step.reasoningMs != null && step.reasoningMs > 0
        ? ` (thinking ${formatDurationMs(step.reasoningMs)})`
        : ''
    parts.push(`model ${formatDurationMs(step.modelMs)}${thinking}`)
  }
  if (step.toolMs != null) parts.push(`tools ${formatDurationMs(step.toolMs)}`)
  return parts.join(' · ')
}

/** `4.2s`, `failed after 1.1s`, or null when the call wasn't timed. */
export function toolCallDurationLabel(tc: ToolCall): string | null {
  const ms =
    tc.durationMs ??
    (tc.startedAt != null && tc.finishedAt != null
      ? tc.finishedAt - tc.startedAt
      : null)
  if (ms == null) return null
  return tc.failed
    ? `failed after ${formatDurationMs(ms)}`
    : formatDurationMs(ms)
}
