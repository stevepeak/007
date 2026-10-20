import { useEffect, useRef, useState } from 'react'

import type { AnyAgentConfig } from '../../engine'
import { usePublishAgent, useSaveAgentDraft } from '../hooks'

/**
 * Save, publish, and the dialog toggles around them — the part of an agent
 * draft that does not depend on which kind of config it holds. Both
 * `useAgentDraft` and `useDecisionAgentDraft` spread this into their return.
 *
 * The toggles live here rather than with a component's other UI state because
 * none is closed by the button that opened it: publishing closes the publish
 * dialog on success, and picking a version closes the versions menu. Owning the
 * toggle next to the mutation that closes it is what keeps a failed publish
 * from silently dismissing its own dialog.
 */
export function useAgentPublishLifecycle({
  agentId,
  config,
  initialBaseVersionNumber,
  markSaved,
  onPublished,
}: {
  agentId: string
  config: AnyAgentConfig
  /**
   * The live version number this editor loaded (0 if never published). Sent
   * with every publish so one based on a version someone has since replaced is
   * refused instead of silently overwriting theirs.
   */
  initialBaseVersionNumber: number
  /** Called after a successful save or publish — the undo stack's clean point. */
  markSaved: () => void
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}) {
  const saveDraft = useSaveAgentDraft()
  const publish = usePublishAgent()
  // Advanced only by this editor's own publishes: a refetch that shows someone
  // else's newer version must not quietly become the base.
  const baseVersionRef = useRef(initialBaseVersionNumber)

  const [showPublish, setShowPublish] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  // Transient "Published" confirmation shown in place of navigating away.
  const [justPublished, setJustPublished] = useState<number | null>(null)

  function onSaveDraft() {
    saveDraft.mutate({ agentId, config }, { onSuccess: markSaved })
  }

  function onPublish({
    changeNote,
    aiSummary,
  }: {
    changeNote: string
    aiSummary: { short: string; long: string } | null
  }) {
    publish.mutate(
      {
        agentId,
        config,
        changeNote: changeNote.trim() || undefined,
        aiSummary: aiSummary ?? undefined,
        baseVersionNumber: baseVersionRef.current,
      },
      {
        onSuccess: (result) => {
          baseVersionRef.current = result.versionNumber
          markSaved()
          setShowPublish(false)
          setJustPublished(result.versionNumber)
          onPublished?.(result)
        },
      },
    )
  }

  // Auto-dismiss the "Published" confirmation after a few seconds.
  useEffect(() => {
    if (justPublished == null) return
    const timer = setTimeout(() => setJustPublished(null), 4000)
    return () => clearTimeout(timer)
  }, [justPublished])

  return {
    saveError: saveDraft.error?.message ?? publish.error?.message ?? null,
    publishError: publish.error?.message ?? null,
    saving: saveDraft.isPending,
    publishing: publish.isPending,
    justPublished,
    onSaveDraft,
    onPublish,
    showPublish,
    setShowPublish,
    showVersions,
    setShowVersions,
    showHistory,
    setShowHistory,
  }
}
