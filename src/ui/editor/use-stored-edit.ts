import { useEffect, useRef } from 'react'

import type { WorkflowGraph } from '../../engine'

// Unsaved edits are persisted to localStorage so navigating away and back
// doesn't lose work. Keyed per workflow; cleared once the edit is saved.
const EDIT_STORAGE_PREFIX = 'wf-sdk:edit:'
export type StoredEdit = { graph: WorkflowGraph; name: string }

function readStoredEdit(workflowId: string): StoredEdit | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(EDIT_STORAGE_PREFIX + workflowId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredEdit>
    if (parsed && parsed.graph && typeof parsed.name === 'string') {
      return { graph: parsed.graph, name: parsed.name }
    }
    return null
  } catch {
    return null
  }
}

function writeStoredEdit(workflowId: string, edit: StoredEdit): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      EDIT_STORAGE_PREFIX + workflowId,
      JSON.stringify(edit),
    )
  } catch {
    // storage full / unavailable — best-effort only
  }
}

function clearStoredEdit(workflowId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(EDIT_STORAGE_PREFIX + workflowId)
  } catch {
    // ignore
  }
}

// Persists the in-flight edit to localStorage while dirty and restores it once,
// on mount, if a prior visit left one that differs from the loaded workflow.
export function useStoredEdit(
  workflowId: string,
  opts: {
    initialGraph: WorkflowGraph
    initialName: string
    graph: WorkflowGraph
    name: string
    dirty: boolean
    onRestore: (stored: StoredEdit) => void
  },
) {
  const { initialGraph, initialName, graph, name, dirty, onRestore } = opts

  // Restore an unsaved edit persisted from a previous visit (once, on mount).
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const stored = readStoredEdit(workflowId)
    if (!stored) return
    if (
      JSON.stringify(stored.graph) === JSON.stringify(initialGraph) &&
      stored.name === initialName
    ) {
      return
    }
    onRestore(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId])

  // Persist the current edit while dirty; clear it once saved (or reverted).
  useEffect(() => {
    if (dirty) writeStoredEdit(workflowId, { graph, name })
    else clearStoredEdit(workflowId)
  }, [dirty, graph, name, workflowId])
}
