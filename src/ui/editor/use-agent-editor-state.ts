import { useCallback, useEffect, useRef, useState } from 'react'

import {
  zodSourceFromJsonSchema,
  type AgentConfig,
  type AgentOutput,
} from '../../engine'
import { useWfClient } from '../context'
import {
  useAgentVersions,
  usePublishAgent,
  useSaveAgentDraft,
  useUpdateAgentMeta,
} from '../hooks'
import { useUndoStack, type CoalesceRule } from '../undo/use-undo-stack'

import { describeAgentChange } from './agent-config-diff'

// The agent editor's state, split the way the DATA is split rather than the way
// the screen is.
//
// An agent has two halves with different lifecycles, and conflating them is the
// bug this file exists to prevent: entity METADATA (name, description, icon,
// color) is unversioned and saves the moment you change it, while the CONFIG is
// versioned — edited as a draft, saved explicitly, published deliberately. They
// share a page and nothing else, so they get a hook each.

/**
 * Name, description, icon, and colour — the unversioned half.
 *
 * Each field keeps a `saved*` shadow so a blur with no real change doesn't fire
 * a mutation, and so an emptied name can be restored rather than persisted.
 * Icon and colour have no such shadow because they're picked, not typed: there
 * is no in-progress value to reconcile.
 */
export function useAgentMeta({
  agentId,
  initialName,
  initialDescription,
  initialIcon,
  initialColor,
}: {
  agentId: string
  initialName: string
  initialDescription: string
  initialIcon: string
  initialColor: string
}) {
  const updateMeta = useUpdateAgentMeta()
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [icon, setIcon] = useState(initialIcon)
  const [color, setColor] = useState(initialColor)
  const [savedName, setSavedName] = useState(initialName)
  const [savedDescription, setSavedDescription] = useState(initialDescription)

  function commitRename() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === savedName) {
      setName(savedName)
      return
    }
    setName(trimmed)
    setSavedName(trimmed)
    updateMeta.mutate({ agentId, name: trimmed })
  }

  // Description is entity metadata (not versioned) — commit on blur, like the
  // name. Empty is allowed, so no restore-on-empty guard.
  function commitDescription() {
    const trimmed = description.trim()
    if (trimmed === savedDescription) {
      setDescription(savedDescription)
      return
    }
    setDescription(trimmed)
    setSavedDescription(trimmed)
    updateMeta.mutate({ agentId, description: trimmed })
  }

  // Appearance saves immediately (it's entity metadata, not versioned) — the
  // header's `AppearancePicker` calls straight into these.
  function selectIcon(next: string) {
    setIcon(next)
    updateMeta.mutate({ agentId, icon: next })
  }
  function selectColor(next: string) {
    setColor(next)
    updateMeta.mutate({ agentId, color: next })
  }

  return {
    name,
    setName,
    description,
    setDescription,
    icon,
    color,
    commitRename,
    commitDescription,
    selectIcon,
    selectColor,
  }
}

// A run of keystrokes in one field is ONE edit to a reader, and without saying
// so a 50-character prompt tweak would push 50 entries and evict the whole
// stack. `describeAgentChange` names the field it touched, so the label is a
// good enough identity for "still typing in the same place"; 600ms of quiet
// starts a new entry, which is where undo should land.
//
// Discrete picks (a model, a tool) get no rule — each is its own edit.
function coalesceConfigEdit(
  prev: AgentDraftState,
  next: AgentDraftState,
  label: string,
): CoalesceRule {
  // Schema typing gets its own key rather than the label's. Most keystrokes
  // leave the source uncompilable, so the config doesn't move and the label
  // flips between "Edited agent" and "Edited expected output" mid-word — two
  // keys, so nothing would ever merge and one schema would fill the stack.
  if (prev.zodSource !== next.zodSource) {
    return { key: 'output-schema-source', windowMs: 600 }
  }
  return label.startsWith('Edited') ? { key: label, windowMs: 600 } : null
}

// What one undo step restores. The config is the thing being edited; `zodSource`
// rides along because it CANNOT be derived back out of it — the config stores
// the compiled JSON Schema, and source that doesn't parse yet compiles to
// nothing at all. Leaving it out would let undo move the schema while the editor
// kept showing the text that produced the old one.
type AgentDraftState = { config: AgentConfig; zodSource: string }

// The source text a config round-trips back to. Only a structured output has
// one; the other shapes have no schema to reconstruct from.
function initialZodSource(config: AgentConfig): string {
  return config.output.kind === 'object'
    ? zodSourceFromJsonSchema(config.output.schema)
    : ''
}

/**
 * The versioned half: the draft `AgentConfig`, what it takes to save or publish
 * it, and the two ways an author can travel backwards through it — loading an
 * older published version, or restoring the config a playground run was
 * recorded against.
 *
 * Both dialog toggles live here rather than with the component's other UI state
 * because neither is closed by the button that opened it: publishing closes the
 * publish dialog on success, and picking a version closes the versions menu.
 * Owning the toggle next to the mutation that closes it is what keeps a failed
 * publish from silently dismissing its own dialog.
 *
 * Travelling backwards is `useUndoStack`'s job now. Loading a version and
 * restoring a playground run both land ON the stack rather than replacing what
 * you had, so Cmd+Z is the way back from either — which is why the one-slot
 * "parked edits" mechanism this hook used to carry is gone.
 */
export function useAgentDraft({
  agentId,
  initialConfig,
  onPublished,
}: {
  agentId: string
  initialConfig: AgentConfig
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}) {
  const client = useWfClient()
  const saveDraft = useSaveAgentDraft()
  const publish = usePublishAgent()
  const versions = useAgentVersions(agentId)

  const [showPublish, setShowPublish] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  // Transient "Published" confirmation shown in place of navigating away.
  const [justPublished, setJustPublished] = useState<number | null>(null)

  // Every other control is driven by `config`, but both prompt bodies are TipTap
  // documents seeded once from `initialBody` — so a restore has to push the new
  // text into them imperatively or the editors would keep showing the old text
  // while `config` held the restored one.
  const promptBodyRef = useRef<((body: string) => void) | null>(null)
  const registerSetBody = useCallback((set: (body: string) => void) => {
    promptBodyRef.current = set
  }, [])
  const userPromptBodyRef = useRef<((body: string) => void) | null>(null)
  const registerSetUserPrompt = useCallback((set: (body: string) => void) => {
    userPromptBodyRef.current = set
  }, [])

  // What the TipTap editors were last told to show. Undoing a MODEL change must
  // not push text into a prompt that didn't move — `setContent` resets the
  // caret, so an unconditional push would jump the cursor to the end of the
  // document on every unrelated undo.
  const shownPromptRef = useRef(initialConfig.prompt)
  const shownUserPromptRef = useRef(initialConfig.userPrompt)

  const history = useUndoStack<AgentDraftState>({
    initial: { config: initialConfig, zodSource: initialZodSource(initialConfig) },
    describe: (prev, next) => describeAgentChange(prev.config, next.config),
    coalesce: coalesceConfigEdit,
    onApply: ({ config: next }) => {
      if (next.prompt !== shownPromptRef.current) {
        shownPromptRef.current = next.prompt
        promptBodyRef.current?.(next.prompt)
      }
      if (next.userPrompt !== shownUserPromptRef.current) {
        shownUserPromptRef.current = next.userPrompt
        userPromptBodyRef.current?.(next.userPrompt)
      }
    },
  })

  const { config, zodSource } = history.state

  function patch(next: Partial<AgentConfig>) {
    // The editors are the source of these two, so record what they already show
    // rather than pushing it back at them.
    if (next.prompt !== undefined) shownPromptRef.current = next.prompt
    if (next.userPrompt !== undefined) shownUserPromptRef.current = next.userPrompt
    history.record({ ...history.state, config: { ...config, ...next } })
  }

  // Source keystrokes ride the same stack as the schema they compile to, so one
  // undo moves both — and both land in ONE record. Recording the text and then
  // the schema separately meant the second call spread a `history.state` read
  // during the same render, i.e. the value from BEFORE the keystroke, putting
  // the old source back every time the author typed. They coalesce as typing,
  // not as a config field change.
  function editZodSource({
    source,
    output,
  }: {
    source: string
    output?: AgentOutput
  }) {
    history.record({
      config: output ? { ...config, output } : config,
      zodSource: source,
    })
  }

  /** Take a playground run's frozen config — as an undoable entry, not a jump. */
  function restoreConfig(next: AgentConfig) {
    history.load({
      state: { config: next, zodSource: initialZodSource(next) },
      label: 'Restored run configuration',
    })
  }

  function onSaveDraft() {
    saveDraft.mutate({ agentId, config }, { onSuccess: history.markSaved })
  }

  // Load a published version back into the editor as an unsaved edit. Nothing is
  // published and the live version doesn't move — the author reviews it and, if
  // they want it back, publishes it as a NEW version on top. History is never
  // rewritten, and the load lands on the undo stack so Cmd+Z brings back the
  // edits it replaced.
  async function loadVersion(versionId: string) {
    const v = await client.getAgentVersion(versionId)
    setShowVersions(false)
    if (!v) return
    history.load({
      state: { config: v.config, zodSource: initialZodSource(v.config) },
      label: `Loaded v${v.versionNumber}`,
    })
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
      },
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

  // Auto-dismiss the "Published" confirmation after a few seconds.
  useEffect(() => {
    if (justPublished == null) return
    const timer = setTimeout(() => setJustPublished(null), 4000)
    return () => clearTimeout(timer)
  }, [justPublished])

  return {
    config,
    patch,
    zodSource,
    editZodSource,
    dirty: history.dirty,
    // The change log for this editing session, newest last.
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
    restoreConfig,
    registerSetBody,
    registerSetUserPrompt,
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
