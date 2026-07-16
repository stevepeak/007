import { ChevronRight, FlaskConical, Play, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  CheckTree,
  EvalCheck,
  WfEvalRowDTO,
} from '../../server/protocol'
import { useWfComponents } from '../context'
import {
  useAgents,
  useDeleteEvalRow,
  useEvalSet,
  useUpsertEvalRow,
} from '../hooks'
import { useWfNav } from '../nav'
import { ArchiveButton } from '../archive-button'
import { WfShell } from '../shell'
import { sectionCrumb } from '../wf-crumbs'
import { RunConfigDialog } from './run-config-dialog'
import { describeCheck, EmptyState, FamilyTag, Tabs } from './shared'
import { StepFlow, type Step } from './step-flow'

// The Sample view (route: evals/<setId>/samples/<sampleId>). A Sample IS a
// wf_eval_row: a name, a GIVEN (its initialCondition.promptVariables — the
// values the goal's agent is invoked with) and a set of TESTS (its checks tree,
// an AND/OR reduction of EvalChecks). The target agent is set on the Goal, not
// here. Edits persist to the row on blur / on action (rows are mutable; no
// version step).

const DEFAULT_CHECK: EvalCheck = { type: 'tool_called', toolId: '', called: true }

type SampleTab = 'config' | 'tests'

export type EvalSampleProps = {
  setId: string
  sampleId: string
  className?: string
}

type Draft = {
  name: string
  promptVariables: Record<string, string>
  checks: CheckTree
}

function draftFromRow(row: WfEvalRowDTO): Draft {
  return {
    name: row.name,
    promptVariables: { ...(row.initialCondition.promptVariables ?? {}) },
    checks: row.checks,
  }
}

export function EvalSample({ setId, sampleId, className }: EvalSampleProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [tab, setTab] = useState<SampleTab>('config')
  const [runOpen, setRunOpen] = useState(false)

  const { data, isLoading } = useEvalSet(setId)
  const set = data?.set
  const row = useMemo(
    () => data?.rows.find((r) => r.id === sampleId),
    [data?.rows, sampleId],
  )
  const upsertRow = useUpsertEvalRow()
  const deleteRow = useDeleteEvalRow(setId)

  // Local draft, synced once per row id so background refetches don't clobber an
  // in-progress edit. Every mutation persists the whole row.
  const [draft, setDraft] = useState<Draft | null>(null)
  const syncedId = useRef<string | null>(null)
  useEffect(() => {
    if (row && syncedId.current !== row.id) {
      setDraft(draftFromRow(row))
      syncedId.current = row.id
    }
  }, [row])

  const persist = (next: Draft) => {
    if (!row) return
    setDraft(next)
    upsertRow.mutate({
      id: row.id,
      setId,
      name: next.name.trim() || 'Untitled sample',
      initialCondition: {
        triggerInput: row.initialCondition.triggerInput,
        promptVariables: next.promptVariables,
      },
      fixtures: row.fixtures,
      checks: next.checks,
    })
  }

  return (
    <WfShell
      className={className}
      scroll
      crumbs={[
        { home: true },
        sectionCrumb('evals'),
        { label: set?.name ?? 'Goal', to: `evals/${setId}` },
        { label: draft?.name || 'Sample' },
      ]}
    >
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        {isLoading && !row ? (
          <EmptyState message="Loading sample…" />
        ) : !row || !draft ? (
          <EmptyState message="This sample doesn't exist, or was archived / removed." />
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <input
                  value={draft.name}
                  maxLength={80}
                  placeholder="Untitled sample"
                  aria-label="Sample name"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  onBlur={() => {
                    if (draft.name !== row.name) persist(draft)
                  }}
                  className="w-full truncate rounded bg-transparent text-lg font-semibold text-neutral-900 outline-none placeholder:text-neutral-300 focus:bg-neutral-50"
                />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ArchiveButton
                  description={
                    <>
                      Archive <strong>{draft.name || 'this sample'}</strong>?
                      It’ll be removed from the goal, along with its tests.
                    </>
                  }
                  onConfirm={() => {
                    deleteRow.mutate(row.id)
                    navigate(`evals/${setId}`)
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRunOpen(true)}
                >
                  <Play className="size-4" />
                  Run goal
                </Button>
              </div>
            </div>

            <RunConfigDialog
              open={runOpen}
              onClose={() => setRunOpen(false)}
              scope="sample"
              targetName={set?.name || draft.name || 'goal'}
              setIds={[setId]}
            />

            <Tabs
              active={tab}
              onChange={(k) => setTab(k as SampleTab)}
              tabs={[
                { key: 'config', label: 'Given' },
                {
                  key: 'tests',
                  label: 'Tests',
                  count: draft.checks.checks.length,
                },
              ]}
            />

            {tab === 'config' ? (
              <StepFlow
                steps={
                  [
                    {
                      key: 'given',
                      title: 'Given',
                      aside: (
                        <span className="text-[11px] uppercase tracking-wide text-neutral-400">
                          Initial state
                        </span>
                      ),
                      content: (
                        <GivenEditor
                          targetId={set?.targetId ?? ''}
                          value={draft.promptVariables}
                          onChange={(promptVariables) =>
                            persist({ ...draft, promptVariables })
                          }
                        />
                      ),
                    },
                  ] satisfies Step[]
                }
              />
            ) : (
              <TestsList
                setId={setId}
                sampleId={sampleId}
                checks={draft.checks}
                onChange={(checks) => persist({ ...draft, checks })}
              />
            )}
          </>
        )}
      </div>
    </WfShell>
  )
}

// The "Given" is the initial state a sample runs from — the values the goal's
// agent is invoked with. When the target agent declares input variables (the
// `${vars}` its published prompt requires), we render one value field per
// variable. Absent a schema, it falls back to a free-form key/value editor. Both
// map to initialCondition.promptVariables.
function GivenEditor({
  targetId,
  value,
  onChange,
}: {
  targetId: string
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}) {
  const { Input, Button } = useWfComponents()
  const agentsQuery = useAgents()
  const agent = agentsQuery.data?.find((a) => a.id === targetId)
  const fields = agent?.inputVariables ?? []

  // Local mirror so typing is smooth; commit up on blur.
  const [local, setLocal] = useState(value)
  const syncedRef = useRef(JSON.stringify(value))
  useEffect(() => {
    const key = JSON.stringify(value)
    if (key !== syncedRef.current) {
      setLocal(value)
      syncedRef.current = key
    }
  }, [value])

  const commit = () => {
    const key = JSON.stringify(local)
    if (key !== syncedRef.current) {
      syncedRef.current = key
      onChange(local)
    }
  }

  // Schema-driven: one value input per declared variable.
  if (fields.length > 0) {
    return (
      <div className="space-y-2">
        <p className="px-1 text-xs text-neutral-400">
          Inputs required by{' '}
          <span className="font-medium text-neutral-500">
            {agent?.name ?? 'the target agent'}
          </span>{' '}
          — fill in the values this sample runs from.
        </p>
        {fields.map((f) => (
          <div key={f} className="flex items-center gap-2">
            <span
              title={f}
              className="w-40 shrink-0 truncate rounded bg-neutral-100 px-2 py-1.5 font-mono text-xs text-neutral-600"
            >
              {f}
            </span>
            <Input
              value={local[f] ?? ''}
              placeholder="value"
              onChange={(e) => setLocal({ ...local, [f]: e.target.value })}
              onBlur={commit}
              className="h-8 flex-1 font-mono text-xs"
            />
          </div>
        ))}
      </div>
    )
  }

  // Fallback: no target, or the agent has no declared inputs — free-form pairs.
  const entries = Object.entries(local)
  const setKey = (oldKey: string, newKey: string) => {
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(local)) next[k === oldKey ? newKey : k] = v
    setLocal(next)
  }
  const remove = (k: string) => {
    const next = { ...local }
    delete next[k]
    setLocal(next)
    syncedRef.current = JSON.stringify(next)
    onChange(next)
  }
  return (
    <div className="space-y-2">
      <p className="px-1 py-1 text-xs text-neutral-400">
        {targetId
          ? 'The target agent has no declared input variables — add initial state manually.'
          : 'This goal has no target agent yet — set one on the goal, or add state manually.'}
      </p>
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={k}
            placeholder="field"
            onChange={(e) => setKey(k, e.target.value)}
            onBlur={commit}
            className="h-8 w-40 font-mono text-xs"
          />
          <Input
            value={v}
            placeholder="value"
            onChange={(e) => setLocal({ ...local, [k]: e.target.value })}
            onBlur={commit}
            className="h-8 flex-1 font-mono text-xs"
          />
          <button
            type="button"
            aria-label="Remove"
            onClick={() => remove(k)}
            className="text-neutral-300 transition hover:text-neutral-600"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setLocal({ ...local, '': '' })}
      >
        <Plus className="size-4" />
        Add field
      </Button>
    </div>
  )
}

function TestsList({
  setId,
  sampleId,
  checks,
  onChange,
}: {
  setId: string
  sampleId: string
  checks: CheckTree
  onChange: (next: CheckTree) => void
}) {
  const { navigate } = useWfNav()
  const { Button } = useWfComponents()

  const addTest = () => {
    const next = { ...checks, checks: [...checks.checks, DEFAULT_CHECK] }
    onChange(next)
    navigate(
      `evals/${setId}/samples/${sampleId}/tests/${next.checks.length - 1}`,
    )
  }

  return (
    <div className="space-y-3">
      {checks.checks.length > 1 ? (
        <div className="flex items-center gap-2 px-1 text-xs text-neutral-500">
          <span>Passes when</span>
          <select
            value={checks.op}
            onChange={(e) =>
              onChange({ ...checks, op: e.target.value as 'and' | 'or' })
            }
            className="h-7 rounded-md border border-neutral-300 bg-transparent px-1.5 text-xs outline-none focus:border-neutral-500"
          >
            <option value="and">all</option>
            <option value="or">any</option>
          </select>
          <span>of these tests pass.</span>
        </div>
      ) : null}

      {checks.checks.length === 0 ? (
        <p className="px-1 py-1 text-xs text-neutral-400">
          No tests yet. Add one to assert an outcome.
        </p>
      ) : (
        <div className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200">
          {checks.checks.map((c, i) => (
            <button
              key={i}
              type="button"
              onClick={() =>
                navigate(`evals/${setId}/samples/${sampleId}/tests/${i}`)
              }
              className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-neutral-50"
            >
              <FlaskConical className="mt-0.5 size-4 shrink-0 text-neutral-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-neutral-800">
                  {describeCheck(c)}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <FamilyTag scored={c.type === 'llm_judge'} />
                  <code className="font-mono text-[11px] text-neutral-400">
                    {c.type}
                  </code>
                </div>
              </div>
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-neutral-300" />
            </button>
          ))}
        </div>
      )}
      <Button size="sm" variant="ghost" onClick={addTest}>
        <Plus className="size-4" />
        Add test
      </Button>
    </div>
  )
}
