import { useEffect, useState } from 'react'

import type { DecisionAgentConfig } from '../../engine'
import { useWfClient } from '../context'
import {
  useAgentVersions,
  usePublishAgent,
  useSaveAgentDraft,
} from '../hooks'
import { useUndoStack, type CoalesceRule } from '../undo/use-undo-stack'

import { describeDecisionAgentChange } from './decision-agent-diff'

// The versioned half of a DECISION agent's editor, the sibling of
// `useAgentDraft`.
//
// A sibling rather than a branch inside that hook, because most of what that
// hook is doing has no counterpart here: there are no TipTap prompt editors to
// push text into imperatively, no compiled output schema riding alongside the
// config, and so none of the ref-and-shadow machinery that exists to keep those
// two in step with undo. What is left is the part both genuinely share — an
// undo stack, save, publish, load-a-version — and that part is small enough
// that one honest copy beats a hook with two modes.
//
// The entity METADATA half is not duplicated: `useAgentMeta` knows nothing
// about a config and both editors use it as-is.

/**
 * A run of keystrokes in one field is ONE edit. Same 600ms rule and same
 * reasoning as the generation editor: without it, typing a question prompt
 * would push one undo entry per character and evict the stack.
 *
 * Discrete picks — a model, a question type, an op, a verdict — get no rule and
 * each stands as its own edit.
 */
function coalesceDecisionEdit(
  _prev: DecisionAgentConfig,
  _next: DecisionAgentConfig,
  label: string,
): CoalesceRule {
  return label.startsWith('Edited') ? { key: label, windowMs: 600 } : null
}

export function useDecisionAgentDraft({
  agentId,
  initialConfig,
  onPublished,
}: {
  agentId: string
  initialConfig: DecisionAgentConfig
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}) {
  const client = useWfClient()
  const saveDraft = useSaveAgentDraft()
  const publish = usePublishAgent()
  const versions = useAgentVersions(agentId)

  const [showPublish, setShowPublish] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [justPublished, setJustPublished] = useState<number | null>(null)

  const history = useUndoStack<DecisionAgentConfig>({
    initial: initialConfig,
    describe: describeDecisionAgentChange,
    coalesce: coalesceDecisionEdit,
  })
  const config = history.state

  function patch(next: Partial<DecisionAgentConfig>) {
    history.record({ ...config, ...next })
  }

  /** Replace the whole config as ONE undoable edit — a labelled bulk change. */
  function replace(next: DecisionAgentConfig, label: string) {
    history.load({ state: next, label })
  }

  async function loadVersion(versionId: string) {
    const v = await client.getAgentVersion(versionId)
    setShowVersions(false)
    // Kind-guarded: a version id is all this holds, and reading a generation
    // config into a question list would render an editor over fields that
    // aren't there. It cannot happen through the UI — versions belong to one
    // agent and an agent has one kind — so this is a backstop, not a path.
    if (!v || v.kind !== 'decision') return
    history.load({
      state: v.config as DecisionAgentConfig,
      label: `Loaded v${v.versionNumber}`,
    })
  }

  function onSaveDraft() {
    saveDraft.mutate({ agentId, config }, { onSuccess: history.markSaved })
  }

  function onPublish({ changeNote }: { changeNote: string }) {
    publish.mutate(
      { agentId, config, changeNote: changeNote.trim() || undefined },
      {
        onSuccess: (result) => {
          history.markSaved()
          setShowPublish(false)
          setJustPublished(result.versionNumber)
          onPublished?.(result)
        },
      },
    )
  }

  useEffect(() => {
    if (justPublished == null) return
    const timer = setTimeout(() => setJustPublished(null), 4000)
    return () => clearTimeout(timer)
  }, [justPublished])

  return {
    config,
    patch,
    replace,
    dirty: history.dirty,
    snapshots: history.entries,
    historyIndex: history.index,
    applySnapshot: history.applyIndex,
    showHistory,
    setShowHistory,
    saveError: saveDraft.error?.message ?? publish.error?.message ?? null,
    publishError: publish.error?.message ?? null,
    saving: saveDraft.isPending,
    publishing: publish.isPending,
    justPublished,
    onSaveDraft,
    onPublish,
    loadVersion,
    versions: versions.data,
    showPublish,
    setShowPublish,
    showVersions,
    setShowVersions,
  }
}
