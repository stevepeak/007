import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentConfig } from '../../engine'
import { useWfClient } from '../context'
import {
  useAgentVersions,
  usePublishAgent,
  useSaveAgentDraft,
  useUpdateAgentMeta,
} from '../hooks'

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

  const [config, setConfig] = useState<AgentConfig>(initialConfig)
  const [savedConfig, setSavedConfig] = useState<AgentConfig>(initialConfig)
  const [showPublish, setShowPublish] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  // Transient "Published" confirmation shown in place of navigating away.
  const [justPublished, setJustPublished] = useState<number | null>(null)
  // Set when you load an older configuration back out of a playground run: the
  // edits you had at that moment, parked so the restore is a toggle and not a
  // one-way door. Cleared only by taking them back, which is why restoring a
  // second run doesn't overwrite them — they're still the newest thing you wrote.
  const [latestEdits, setLatestEdits] = useState<AgentConfig | null>(null)

  function patch(next: Partial<AgentConfig>) {
    setConfig((c) => ({ ...c, ...next }))
  }

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

  function loadConfig(next: AgentConfig) {
    setConfig(next)
    promptBodyRef.current?.(next.prompt)
    userPromptBodyRef.current?.(next.userPrompt)
  }

  /** Take a playground run's frozen config, parking the current edits. */
  function restoreConfig(next: AgentConfig) {
    setLatestEdits((parked) => parked ?? config)
    loadConfig(next)
  }

  /** Go back to the edits parked by the first restore. */
  function returnToLatestEdits() {
    if (!latestEdits) return
    loadConfig(latestEdits)
    setLatestEdits(null)
  }

  function onSaveDraft() {
    saveDraft.mutate(
      { agentId, config },
      { onSuccess: () => setSavedConfig(config) },
    )
  }

  // Load a published version back into the editor as an unsaved edit. Nothing is
  // published and the live version doesn't move — the author reviews it and, if
  // they want it back, publishes it as a NEW version on top. History is never
  // rewritten. (The workflow editor parks this in its undo stack; the agent
  // editor has none, so the dirty check is what makes it recoverable.)
  async function loadVersion(versionId: string) {
    const v = await client.getAgentVersion(versionId)
    setShowVersions(false)
    if (!v) return
    setConfig(v.config)
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
          setSavedConfig(config)
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
    dirty: JSON.stringify(config) !== JSON.stringify(savedConfig),
    saveError: saveDraft.error?.message ?? publish.error?.message ?? null,
    publishError: publish.error?.message ?? null,
    saving: saveDraft.isPending,
    publishing: publish.isPending,
    justPublished,
    latestEdits,
    restoreConfig,
    returnToLatestEdits,
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
