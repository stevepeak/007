import { FlaskConical, Goal, Microscope, Play } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { agentOutputJsonSchema, type JsonSchema } from '../../engine'
import type { EvalCheck } from '../../server/protocol'
import { ArchiveButton } from '../archive-button'
import { useWfComponents } from '../context'
import {
  useAgents,
  useEvalSet,
  useSuggestedCheckName,
  useUpsertEvalRow,
} from '../hooks'
import { useWfNav } from '../nav'
import { WfShell } from '../shell'
import { sectionCrumb } from '../wf-crumbs'
import { CheckNameHint } from './check-name-hint'
import {
  describeCheck,
  exampleCheckName,
  heuristicCheckName,
  isUnnamed,
} from './check-naming'
import {
  ConfigForm,
  defaultCheck,
  familyOf,
  type CheckFamily,
  withMeta,
} from './eval-check-config'
import { RunConfigDialog } from './run-config-dialog'
import { EmptyState, useTargetAgentCrumb } from './shared'

// The single-Check view
// (route: evals/<setId>/samples/<sampleId>/checks/<checkIndex>). A "Check" is
// one EvalCheck inside the sample row's `checks` tree, addressed by its index.
// The Configuration flow picks the family (binary vs scored) and its type, then
// the type-specific fields. Every edit persists the whole row (rows are
// mutable).

// The Check title lives in the shell header, so the naming chips reach it by
// id rather than by threading a ref up through the crumb contract.
const TITLE_INPUT_ID = 'wf-check-title'

export type EvalCheckPageProps = {
  setId: string
  sampleId: string
  /** The check's index within the sample row's checks tree (as a string). */
  checkId: string
  className?: string
}

export function EvalCheckPage({
  setId,
  sampleId,
  checkId,
  className,
}: EvalCheckPageProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [runOpen, setRunOpen] = useState(false)

  const index = Number(checkId)
  const { data, isLoading } = useEvalSet(setId)
  const set = data?.set
  const row = useMemo(
    () => data?.rows.find((r) => r.id === sampleId),
    [data?.rows, sampleId],
  )
  const stored =
    row && Number.isInteger(index) ? row.checks.checks[index] : undefined
  const upsertRow = useUpsertEvalRow()
  const targetAgentCrumb = useTargetAgentCrumb(set?.targetId, set?.targetVersion)

  // When the goal targets an agent, the agent's declared output contract lets us
  // offer its fields (with descriptions) as the "output path" instead of a raw
  // free-form path. Only agents have a single known output schema; workflows keep
  // the free-form path.
  const agentsQuery = useAgents()
  const outputSchema = useMemo<JsonSchema | null>(() => {
    if (set?.targetKind !== 'agent') return null
    const output = agentsQuery.data?.find((a) => a.id === set.targetId)?.output
    return output ? agentOutputJsonSchema(output) : null
  }, [set?.targetKind, set?.targetId, agentsQuery.data])

  // The target agent's wired tools — the only tools a run could ever call, so the
  // tool pickers are scoped to them. Undefined for workflow targets (tools are
  // spread across nodes), where the picker keeps offering every host tool.
  const allowToolIds = useMemo<string[] | undefined>(() => {
    if (set?.targetKind !== 'agent') return undefined
    return agentsQuery.data?.find((a) => a.id === set.targetId)?.toolIds
  }, [set?.targetKind, set?.targetId, agentsQuery.data])

  // Local draft of this one check, synced per (row, index). Title/description
  // mirror the draft's label/description as their own inputs so typing stays
  // smooth; they commit on blur.
  const [draft, setDraft] = useState<EvalCheck | null>(null)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const syncKey = useRef<string | null>(null)
  useEffect(() => {
    const key = row ? `${row.id}:${index}` : null
    if (stored && key && syncKey.current !== key) {
      setDraft(stored)
      setTitle(stored.label ?? '')
      setDesc(stored.description ?? '')
      syncKey.current = key
    }
  }, [stored, row, index])

  const persist = (next: EvalCheck) => {
    if (!row) return
    setDraft(next)
    const checks = [...row.checks.checks]
    checks[index] = next
    upsertRow.mutate({
      id: row.id,
      setId,
      name: row.name,
      input: row.input,
      tools: row.tools,
      checks: { ...row.checks, checks },
    })
  }

  // Commit the user-authored title/description onto the check.
  const commitMeta = (patch: { label?: string; description?: string }) => {
    if (!draft) return
    persist({ ...draft, ...patch } as EvalCheck)
  }

  // ── Naming ────────────────────────────────────────────────────────────────
  // A deterministic Check can name itself off its own fields; a judge's
  // assertion is prose, so its name comes from the model (never blocking, and
  // only once the rubric is worth naming). What's left is an example, varied by
  // position so a sample full of unnamed Checks shows the range of the
  // convention rather than the same name repeated.
  const derivedName = draft ? heuristicCheckName(draft) : null
  const judgeRubric =
    draft?.type === 'llm_judge' && !derivedName ? draft.rubric : null
  const suggestQuery = useSuggestedCheckName(judgeRubric)
  const suggestion = derivedName ?? suggestQuery.data?.name ?? null
  // What the (empty) title field shows. A real suggestion when we have one —
  // Tab accepts it — and otherwise a well-formed example, which teaches the
  // shape even though it's not this Check's name.
  const titlePlaceholder = suggestion ?? exampleCheckName(index)

  const acceptName = (name: string) => {
    setTitle(name)
    commitMeta({ label: name })
  }

  // Seed the title with a verb and put the cursor after it, so the chip is a
  // head start on typing rather than a name in itself.
  const startWithVerb = (verb: string) => {
    const seeded = `${verb} `
    setTitle(seeded)
    const input = document.getElementById(TITLE_INPUT_ID)
    if (input instanceof HTMLInputElement) {
      input.focus()
      requestAnimationFrame(() =>
        input.setSelectionRange(seeded.length, seeded.length),
      )
    }
  }

  const removeCheck = () => {
    if (!row) return
    const checks = row.checks.checks.filter((_, i) => i !== index)
    upsertRow.mutate({
      id: row.id,
      setId,
      name: row.name,
      input: row.input,
      tools: row.tools,
      checks: { ...row.checks, checks },
    })
    navigate(`evals/${setId}/samples/${sampleId}`)
  }

  const setFamily = (family: CheckFamily) => {
    if (family === familyOf(draft ?? defaultCheck('tool_called'))) return
    persist(
      withMeta(
        defaultCheck(family === 'scored' ? 'llm_judge' : 'tool_called'),
        draft,
      ),
    )
  }

  return (
    <WfShell
      className={className}
      scroll
      titleIcon={<FlaskConical className="size-5 shrink-0 text-rose-500" />}
      assetLabel="Check"
      crumbs={[
        sectionCrumb('evals'),
        {
          assetLabel: 'Goal',
          label: set?.name ?? 'Goal',
          to: `evals/${setId}`,
          icon: Goal,
          iconClassName: 'text-rose-500',
        },
        ...(targetAgentCrumb ? [targetAgentCrumb] : []),
        {
          separator: targetAgentCrumb ? 'using' : undefined,
          assetLabel: 'Sample',
          label: row?.name ?? 'Sample',
          to: `evals/${setId}/samples/${sampleId}`,
          icon: Microscope,
          iconClassName: 'text-rose-500',
        },
        row && draft
          ? {
              editable: {
                value: title,
                onChange: setTitle,
                onCommit: () => {
                  if ((title.trim() || undefined) !== draft.label)
                    commitMeta({ label: title.trim() || undefined })
                },
                ariaLabel: 'Check name',
                placeholder: titlePlaceholder,
                inputId: TITLE_INPUT_ID,
                onAcceptPlaceholder: acceptName,
              },
            }
          : { label: 'Check' },
      ]}
      descriptionEditable={
        row && draft
          ? {
              value: desc,
              onChange: setDesc,
              onCommit: () => {
                if ((desc.trim() || undefined) !== draft.description)
                  commitMeta({ description: desc.trim() || undefined })
              },
              ariaLabel: 'Check description',
            }
          : undefined
      }
      actions={
        row && draft ? (
          <>
            <ArchiveButton
              title="Delete check"
              confirmLabel="Hold to delete"
              description={
                <>
                  Delete <strong>{describeCheck(draft)}</strong>? It’ll be
                  removed from this sample&apos;s checks.
                </>
              }
              onConfirm={removeCheck}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRunOpen(true)}
            >
              <Play className="size-4" />
              Run Check
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        {isLoading && !row ? (
          <EmptyState message="Loading check…" />
        ) : !row || !draft ? (
          <EmptyState message="This check doesn't exist, or was removed." />
        ) : (
          <>
            <RunConfigDialog
              open={runOpen}
              onClose={() => setRunOpen(false)}
              scope="check"
              targetName={set?.name || 'goal'}
              setIds={[setId]}
            />

            {isUnnamed(draft) && (
              <CheckNameHint
                suggestion={suggestion}
                isSuggesting={suggestQuery.isFetching}
                onPickVerb={startWithVerb}
                onAccept={acceptName}
              />
            )}

            <ConfigForm
              draft={draft}
              persist={persist}
              setFamily={setFamily}
              targetKind={set?.targetKind}
              outputSchema={outputSchema}
              allowToolIds={allowToolIds}
            />
          </>
        )}
      </div>
    </WfShell>
  )
}
