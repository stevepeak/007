import { Sparkles } from 'lucide-react'

import type { WorkflowGraph } from '../../engine'
import { useSummarizeChanges } from '../hooks'

import { PublishVersionDialog } from './publish-version-dialog'

export function PublishDialog({
  workflowId,
  graph,
  publishing,
  error,
  onCancel,
  onConfirm,
}: {
  workflowId: string
  graph: WorkflowGraph
  publishing: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (input: {
    changeNote: string
    aiSummary: { short: string; long: string } | null
  }) => void
}) {
  const summarize = useSummarizeChanges()
  return (
    <PublishVersionDialog
      summarize={() => summarize.mutateAsync({ workflowId, graph })}
      icon={<Sparkles className="size-4 text-indigo-600" />}
      intro="Add a note about what changed. We'll also summarize the changes with AI — you can publish without waiting for it."
      publishing={publishing}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
