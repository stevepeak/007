import type { DecisionAgentConfig } from '../../engine'
import { useWfClient } from '../context'
import { useAgentVersions } from '../hooks'
import { useUndoStack, type CoalesceRule } from '../undo/use-undo-stack'

import { describeDecisionAgentChange } from './decision-agent-diff'
import { useAgentPublishLifecycle } from './use-agent-publish-lifecycle'

// The versioned half of a DECISION agent's editor, the sibling of
// `useAgentDraft`.
//
// A sibling rather than a branch inside that hook, because most of what that
// hook is doing has no counterpart here: there are no TipTap prompt editors to
// push text into imperatively, no compiled output schema riding alongside the
// config, and so none of the ref-and-shadow machinery that exists to keep those
// two in step with undo. Save and publish are kind-independent and come from
// `useAgentPublishLifecycle`; what is left — an undo stack and load-a-version —
// is small enough that one honest copy beats a hook with two modes.
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
  initialBaseVersionNumber,
  onPublished,
}: {
  agentId: string
  initialConfig: DecisionAgentConfig
  /**
   * The live version number this editor loaded (0 if never published). Sent
   * with every publish so one based on a version someone has since replaced is
   * refused instead of silently overwriting theirs.
   */
  initialBaseVersionNumber: number
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}) {
  const client = useWfClient()
  const versions = useAgentVersions(agentId)

  const history = useUndoStack<DecisionAgentConfig>({
    initial: initialConfig,
    describe: describeDecisionAgentChange,
    coalesce: coalesceDecisionEdit,
  })
  const config = history.state
  const lifecycle = useAgentPublishLifecycle({
    agentId,
    config,
    initialBaseVersionNumber,
    markSaved: history.markSaved,
    onPublished,
  })

  function patch(next: Partial<DecisionAgentConfig>) {
    history.record({ ...config, ...next })
  }

  /** Replace the whole config as ONE undoable edit — a labelled bulk change. */
  function replace(next: DecisionAgentConfig, label: string) {
    history.load({ state: next, label })
  }

  async function loadVersion(versionId: string) {
    const v = await client.getAgentVersion(versionId)
    lifecycle.setShowVersions(false)
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

  return {
    config,
    patch,
    replace,
    dirty: history.dirty,
    snapshots: history.entries,
    historyIndex: history.index,
    applySnapshot: history.applyIndex,
    loadVersion,
    versions: versions.data,
    ...lifecycle,
  }
}
