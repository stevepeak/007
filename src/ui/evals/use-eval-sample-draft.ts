import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { agentOutputJsonSchema, type JsonSchema } from '../../engine'
import type {
  CheckTree,
  EvalCheck,
  EvalSampleInput,
  EvalTools,
  WfEvalRowDTO,
} from '../../server/protocol'
import { evalSampleLayer } from '../../server/protocol'
import { useAgents, useDeleteEvalRow, useEvalSet, useUpsertEvalRow } from '../hooks'
import { useUndoStack } from '../undo/use-undo-stack'
import { useUnsavedGuard } from '../undo/use-unsaved-guard'

import {
  coalesceSampleEdit,
  describeSampleChange,
} from './describe-sample-change'
import { useTargetHasTools } from './eval-sample-tools'

// The state behind the Sample view. Everything here is downstream of ONE fact:
// a sample is only meaningful against its goal's TARGET, and the target's own
// contract decides what the sample may say. Which input editor it gets, whether
// the Tools card exists at all, which tools a check may name, which output
// fields it may assert on — all of it is read off the target, not stored on the
// sample, so none of it can drift from the agent it is testing.
//
// Rows are MUTABLE — there is no version step. Edits land on a local undo stack
// and reach the server only on an explicit save, which is why `edit` takes a
// complete draft rather than a patch.
//
// This used to write the whole row on every change. That made Cmd+Z meaningless
// here (there was no local state to step back through), it meant a Sample's
// grading criteria moved under a running comparison, and it produced a firehose
// of unattributed writes. The cost is that a sample can now be dirty, which is
// why `save`, `dirty`, and the guard on tab close all come out of this hook.

/** The editable half of a sample row. */
export type Draft = {
  name: string
  description: string
  input: EvalSampleInput
  tools: EvalTools
  checks: CheckTree
}

function draftFromRow(row: WfEvalRowDTO): Draft {
  return {
    name: row.name,
    description: row.description ?? '',
    input: row.input,
    tools: row.tools,
    checks: row.checks,
  }
}

// The check "Add check" starts from. A tool assertion is the most common one to
// want — except against an agent that has no tools, where it is unsatisfiable by
// construction, so that target starts from an assertion about the answer.
const DEFAULT_CHECK: EvalCheck = { type: 'tool_called', toolId: '', called: true }
const DEFAULT_CHECK_NO_TOOLS: EvalCheck = {
  type: 'output_match',
  match: 'contains',
  value: '',
}

export type EvalSampleDraftOptions = {
  setId: string
  sampleId: string
  /** Expand this check on arrival — how a run report's `?check=<i>` link lands. */
  initialCheckIndex?: number | null
}

export function useEvalSampleDraft({
  setId,
  sampleId,
  initialCheckIndex,
}: EvalSampleDraftOptions) {
  const { data, isLoading } = useEvalSet(setId)
  const set = data?.set
  const row = useMemo(
    () => data?.rows.find((r) => r.id === sampleId),
    [data?.rows, sampleId],
  )
  const upsertRow = useUpsertEvalRow()
  const deleteRow = useDeleteEvalRow(setId)

  // The target's own input contract decides which input editor this sample gets.
  const agentsQuery = useAgents()
  const targetAgent = agentsQuery.data?.find((a) => a.id === set?.targetId)
  // …and whether it HAS tools decides whether the Tools card exists at all. An
  // agent with none behaves identically under all three modes, so the card would
  // be asking a question with no answer.
  const hasTools = useTargetHasTools(
    set?.targetId ?? '',
    set?.targetKind ?? 'agent',
  )

  // When the goal targets an agent, the agent's declared output contract lets us
  // offer its fields (with descriptions) as the "output path" in a check instead
  // of a raw free-form path. Only agents have a single known output schema;
  // workflows keep the free-form path.
  const outputSchema = useMemo<JsonSchema | null>(() => {
    if (set?.targetKind !== 'agent') return null
    const output = targetAgent?.output
    return output ? agentOutputJsonSchema(output) : null
  }, [set?.targetKind, targetAgent?.output])

  // The target agent's wired tools — the only tools a run could ever call, so a
  // check's tool pickers are scoped to them. Undefined for workflow targets
  // (tools are spread across nodes), where the picker keeps offering every host
  // tool.
  const allowToolIds = useMemo<string[] | undefined>(
    () => (set?.targetKind === 'agent' ? targetAgent?.toolIds : undefined),
    [set?.targetKind, targetAgent?.toolIds],
  )

  // The draft lives on an undo stack, seeded once per row id so a background
  // refetch can't clobber an in-progress edit.
  //
  // `reset` rather than `load`, because the stack is created before the row
  // arrives: loading would leave the seeded `null` underneath as a history
  // entry, and one Cmd+Z too many would blank the editor.
  const history = useUndoStack<Draft | null>({
    initial: null,
    describe: (a, b) =>
      a && b ? describeSampleChange(a, b) : 'Edited sample',
    coalesce: (a, b, label) =>
      a && b ? coalesceSampleEdit(a, b, label) : null,
    // Dormant until a row has loaded — an empty editor must not claim Cmd+Z
    // away from whatever else is on screen.
    enabled: row != null,
  })
  const draft = history.state
  const syncedIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (row && syncedIdRef.current !== row.id) {
      syncedIdRef.current = row.id
      history.reset(draftFromRow(row))
    }
  }, [row, history])

  // Which check row is expanded — the accordion state lives here so "Add check"
  // can open the row it just appended.
  const [openCheck, setOpenCheck] = useState<number | null>(
    initialCheckIndex ?? null,
  )

  // A deep link expands the check it names. This has to be an effect, not just
  // the initial state above: walking a run report's check rows means several
  // `?check=<i>` links landing on the SAME sample, which shares one tab and so
  // never remounts. Arriving with no `?check` leaves the accordion alone rather
  // than collapsing what the author was editing.
  const linkedCheckRef = useRef<number | null | undefined>(undefined)
  useEffect(() => {
    if (linkedCheckRef.current === initialCheckIndex) return
    linkedCheckRef.current = initialCheckIndex
    // eslint-disable-next-line react-hooks/set-state-in-effect -- apply a deep link once per `?check` value, guarded by a ref
    if (initialCheckIndex != null) setOpenCheck(initialCheckIndex)
  }, [initialCheckIndex])

  // Draft-then-save means closing the tab can now lose work. This is the other
  // half of that trade.
  useUnsavedGuard(history.dirty, `Sample: ${draft?.name || 'Untitled'}`)

  /** Record an edit locally. Nothing reaches the server until `save`. */
  const edit = useCallback(
    (next: Draft) => {
      if (!row) return
      history.record(next)
    },
    [row, history],
  )

  /**
   * Write the draft. Resolves once the row is stored, so callers that must not
   * act on a stale definition — running the sample, navigating away — can await
   * it rather than racing it.
   */
  const save = useCallback(async () => {
    if (!row || !draft) return
    await upsertRow.mutateAsync({
      id: row.id,
      setId,
      name: draft.name.trim() || 'Untitled sample',
      description: draft.description.trim() || null,
      input: draft.input,
      tools: draft.tools,
      checks: draft.checks,
    })
    history.markSaved()
  }, [row, draft, upsertRow, setId, history])

  /**
   * Save only if there is something to save.
   *
   * The guard that matters: what you see is what runs. Before the draft model
   * the two could not diverge; now they can, and an eval that silently grades
   * yesterday's definition is exactly the bug this whole project exists to
   * remove.
   */
  const saveIfDirty = useCallback(async () => {
    if (history.dirty) await save()
  }, [history.dirty, save])

  // Append a check and expand it. Lifted here because the draft and the
  // accordion state both live here; the trigger is the last row of the
  // checklist itself.
  const addCheck = useCallback(() => {
    if (!draft) return
    const checks = {
      ...draft.checks,
      checks: [
        ...draft.checks.checks,
        hasTools ? DEFAULT_CHECK : DEFAULT_CHECK_NO_TOOLS,
      ],
    }
    edit({ ...draft, checks })
    setOpenCheck(checks.checks.length - 1)
  }, [draft, hasTools, edit])

  // A sample authored before its goal's target changed input kind still holds
  // the old variant. Offer the swap rather than silently rewriting an author's
  // work — the old input's values are what they'd have to retype.
  const expectedKind =
    draft?.input.kind === 'trigger'
      ? 'trigger'
      : (targetAgent?.inputKind ?? 'task')

  return {
    isLoading,
    set,
    row,
    targetAgent,
    hasTools,
    outputSchema,
    allowToolIds,
    draft,
    edit,
    save,
    saveIfDirty,
    dirty: history.dirty,
    saving: upsertRow.isPending,
    saveError: upsertRow.error?.message ?? null,
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel,
    deleteRow,
    openCheck,
    setOpenCheck,
    addCheck,
    expectedKind,
    kindMismatch: !!draft && draft.input.kind !== expectedKind,
    /** The derived testing layer — never stored, so it can't drift. */
    layer: draft ? evalSampleLayer(draft.input, draft.tools) : 'io',
    stagedToolResults:
      draft?.input.kind === 'conversation'
        ? draft.input.turns.reduce((n, t) => n + (t.toolCalls?.length ?? 0), 0)
        : 0,
  }
}
