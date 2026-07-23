import { useQuery } from '@tanstack/react-query'

import type {
  WfFeedbackListInput,
  WfFeedbackSubmitInput,
} from '../server/protocol'

import { useWfClient } from './context'
import { keys, useWfMutation } from './hooks-shared'

// The triage list (filtered rated subjects + facet dropdowns).
export function useFeedback(input: WfFeedbackListInput) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.feedback(input),
    queryFn: () => client.listFeedback(input),
  })
}

// Current rating/note for a set of subjects — re-hydrates the thumbs widget.
// `enabled` guards the query so an empty subject set never round-trips.
export function useFeedbackForSubjects(subjectIds: string[]) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.feedbackForSubjects(subjectIds),
    queryFn: () => client.getFeedbackForSubjects({ subjectIds }),
    enabled: subjectIds.length > 0,
  })
}

// Submit / change / clear a thumb. Invalidates every feedback list variant and
// the per-subject hydration so both the widget and the triage view refresh.
export function useSubmitFeedback() {
  return useWfMutation(
    (client, input: WfFeedbackSubmitInput) => client.submitFeedback(input),
    (input) => [keys.feedbackAll, keys.feedbackForSubjects([input.subjectId])],
  )
}

// Acknowledge / reopen a subject's feedback (staff triage).
export function useSetFeedbackAck() {
  return useWfMutation(
    (client, input: { subjectId: string; acknowledged: boolean }) =>
      client.setFeedbackAcknowledged(input),
    (input) => [
      keys.feedbackAll,
      keys.feedbackForSubjects([input.subjectId]),
    ],
  )
}

// Set / clear the staff-only internal note (resolution log) on a feedback item.
// Invalidates the list + the per-subject hydration the detail view reads.
export function useSetFeedbackInternalNote() {
  return useWfMutation(
    (client, input: { subjectId: string; note: string | null }) =>
      client.setFeedbackInternalNote(input),
    (input) => [
      keys.feedbackAll,
      keys.feedbackForSubjects([input.subjectId]),
    ],
  )
}
