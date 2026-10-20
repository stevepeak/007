import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { AnyAgentConfig } from '../../engine'
import { useWfClient } from '../context'
import { useSummarizeAgentChanges } from '../hooks'

import { PublishVersionDialog } from './publish-version-dialog'

// Also warns how many workflows reference this agent — they float to the latest
// published version and update immediately.
export function PublishAgentDialog({
  agentId,
  config,
  summarize: wantsSummary = true,
  publishing,
  error,
  onCancel,
  onConfirm,
}: {
  agentId: string
  config: AnyAgentConfig
  /**
   * Whether to ask for an AI summary of the change. False for a decision
   * agent: the summarizer's prompt is written around a system prompt, tools
   * and an output contract, so pointed at a question set it would describe
   * fields that aren't there — the server refuses, and asking anyway would put
   * an error in a dialog whose job is to publish.
   */
  summarize?: boolean
  publishing: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (input: {
    changeNote: string
    aiSummary: { short: string; long: string } | null
  }) => void
}) {
  const client = useWfClient()
  const summarize = useSummarizeAgentChanges()
  const [refCount, setRefCount] = useState<number | null>(null)

  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void client
      .countAgentReferences(agentId)
      .then((r) => setRefCount(r.workflows))
      .catch(() => setRefCount(0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <PublishVersionDialog
      summarize={
        wantsSummary
          ? () => summarize.mutateAsync({ agentId, config })
          : null
      }
      intro="Publishing makes this the live version. Add a note about what changed — we'll also summarize the changes with AI, and you can publish without waiting for it."
      warning={
        refCount != null && refCount > 0 ? (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>
                {refCount} workflow{refCount === 1 ? '' : 's'}
              </strong>{' '}
              reference this agent and will use the new version immediately.
            </span>
          </div>
        ) : null
      }
      publishing={publishing}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
