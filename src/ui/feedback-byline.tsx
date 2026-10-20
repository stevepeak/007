import { ThumbsDown, ThumbsUp } from 'lucide-react'
import type { ReactNode } from 'react'

import type { WfFeedbackRating, WfFeedbackRow } from '../server/protocol'

import { formatTimestamp } from './cost'

// The feedback triage list and the single-item page draw a rating the same
// way: a filled thumb, then "rater @ correlation · time".

/** What a rater with no snapshot label is shown as. */
export const UNKNOWN_RATER_LABEL = 'Unknown user'

export function RatingIcon({
  rating,
  size = 'sm',
}: {
  rating: WfFeedbackRating
  size?: 'sm' | 'md'
}) {
  const sizeClass = size === 'md' ? 'h-5 w-5' : 'h-4 w-4'
  return rating === 'up' ? (
    <ThumbsUp className={`${sizeClass} fill-current text-emerald-600`} />
  ) : (
    <ThumbsDown className={`${sizeClass} fill-current text-rose-600`} />
  )
}

// `trailing` renders inside the same wrapping row, after the timestamp.
export function FeedbackByline({
  row,
  trailing,
}: {
  row: WfFeedbackRow
  trailing?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="font-medium text-neutral-900">
        {row.raterLabel || UNKNOWN_RATER_LABEL}
      </span>
      {row.correlationLabel ? (
        <>
          <span className="text-neutral-400">@</span>
          <span className="font-medium text-neutral-600">
            {row.correlationLabel}
          </span>
        </>
      ) : null}
      <span className="text-neutral-300">·</span>
      <span className="text-xs text-neutral-500">
        {formatTimestamp(row.createdAt)}
      </span>
      {trailing}
    </div>
  )
}
