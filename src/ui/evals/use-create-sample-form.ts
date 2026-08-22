import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentNode } from '../../engine'
import type { WfRunStepDTO } from '../../server/protocol'
import {
  useAgents,
  useCreateEvalSet,
  useEvalSets,
  useUpsertEvalRow,
} from '../hooks'
import { useOpenAsset } from '../nav'

import { deriveTitle, seedGiven } from './create-sample-seed'

/** Sentinel goal id meaning "create a new goal named below". */
export const NEW_GOAL = '__new__'

// The "Create Sample" form. Two things here are less obvious than they look:
//
//   • The goal choice starts as `null` meaning AUTO — follow the first existing
//     goal. Defaulting to a concrete id at mount would mean goals that load in
//     after the dialog opens either get ignored or silently replace what the
//     author already picked; `null` lets late data change the default and a
//     real pick pin it.
//   • The form resets on the open→true EDGE, not on every render where `open`
//     is true. A background refetch of goals or agents while the dialog is up
//     must not clobber what the author has typed into it.

export type CreateSampleFormOptions = {
  agentNode: AgentNode
  step: WfRunStepDTO
  steps: WfRunStepDTO[]
}

export function useCreateSampleForm({
  agentNode,
  step,
  steps,
}: CreateSampleFormOptions) {
  const openAsset = useOpenAsset()

  const agentId = agentNode.config.agentId
  const agentsQuery = useAgents()
  const agent = agentsQuery.data?.find((a) => a.id === agentId)
  const agentName = agent?.name ?? 'this agent'
  const inputVariables = useMemo(
    () => agent?.inputVariables ?? [],
    [agent?.inputVariables],
  )

  // Goals that already test this agent — the sample lands under one of them, or a
  // brand-new goal the author names here.
  const setsQuery = useEvalSets()
  const goals = useMemo(
    () =>
      (setsQuery.data ?? []).filter(
        (s) => s.targetKind === 'agent' && s.targetId === agentId,
      ),
    [setsQuery.data, agentId],
  )

  // The sample's input, reconstructed from what this node actually ran with.
  const given = useMemo(
    () => seedGiven(agentNode, step, steps, inputVariables),
    [agentNode, step, steps, inputVariables],
  )

  const createSet = useCreateEvalSet()
  const upsertRow = useUpsertEvalRow()

  const [open, setOpen] = useState(false)
  const [goalChoice, setGoalChoice] = useState<string | null>(null)
  const [newGoalName, setNewGoalName] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true
      // Guarded by `wasOpenRef`, so this seeds once per opening, not per render.
      setGoalChoice(null)
      setNewGoalName(`${agentName} goal`)
      setTitle(deriveTitle(agentName, given, step))
      setError(null)
    } else if (!open) {
      wasOpenRef.current = false
    }
  }, [open, agentName, given, step])

  const effectiveGoal = goalChoice ?? goals[0]?.id ?? NEW_GOAL
  const creatingNewGoal = effectiveGoal === NEW_GOAL
  const pending = createSet.isPending || upsertRow.isPending
  const canSubmit = !pending && (!creatingNewGoal || !!newGoalName.trim())

  const submit = useCallback(async () => {
    if (!canSubmit) return
    setError(null)
    try {
      let setId = effectiveGoal
      if (creatingNewGoal) {
        const res = await createSet.mutateAsync({
          name: newGoalName.trim(),
          targetKind: 'agent',
          targetId: agentId,
          targetVersion: agentNode.config.version ?? null,
          triggerKind: 'manual',
        })
        setId = res.setId
      }
      const { rowId } = await upsertRow.mutateAsync({
        setId,
        name: title.trim() || 'Untitled sample',
        input: given,
        // Mocked with nothing mocked: the sample replays the call with its tools
        // stubbed out, which is the safe default. The author picks Live or None
        // on the sample itself.
        tools: { mode: 'mocked', fixtures: {} },
        checks: { op: 'and', checks: [] },
      })
      setOpen(false)
      // Open the fresh sample in its own tab so the run stays put behind it.
      openAsset(`evals/${setId}/samples/${rowId}`, { newTab: true })
    } catch {
      setError("Couldn't create the sample. Try again.")
    }
  }, [
    canSubmit,
    effectiveGoal,
    creatingNewGoal,
    createSet,
    newGoalName,
    agentId,
    agentNode.config.version,
    upsertRow,
    title,
    given,
    openAsset,
  ])

  return {
    agentName,
    goals,
    /** The reconstructed Given, as `[name, value]` pairs for the preview. */
    givenEntries: Object.entries(given.variables),
    open,
    setOpen,
    effectiveGoal,
    setGoalChoice,
    creatingNewGoal,
    newGoalName,
    setNewGoalName,
    title,
    setTitle,
    error,
    pending,
    canSubmit,
    submit,
  }
}
