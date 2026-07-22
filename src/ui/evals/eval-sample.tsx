import { Goal, Microscope, Play, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  CheckTree,
  EvalCheck,
  EvalFixtures,
  WfEvalRowDTO,
} from '../../server/protocol'
import { useWfComponents } from '../context'
import {
  useDeleteEvalRow,
  useEvalSet,
  useUpsertEvalRow,
} from '../hooks'
import { useWfNav } from '../nav'
import { ArchiveButton } from '../archive-button'
import { WfShell } from '../shell'
import { sectionCrumb } from '../wf-crumbs'
import { GivenEditor } from './eval-sample-given'
import { MockToolsPanel } from './eval-sample-mocks'
import { RunsForSample, TestsList } from './eval-sample-tests'
import { RunConfigDialog } from './run-config-dialog'
import { EmptyState, Tabs } from './shared'
import { StepFlow, type Step } from './step-flow'

// The Sample view (route: evals/<setId>/samples/<sampleId>). A Sample IS a
// wf_eval_row: a name, a GIVEN (its initialCondition.promptVariables — the
// values the goal's agent is invoked with) and a set of TESTS (its checks tree,
// an AND/OR reduction of EvalChecks). The target agent is set on the Goal, not
// here. Edits persist to the row on blur / on action (rows are mutable; no
// version step). The three configuration steps (Given, Mocks, Tests) each live
// in their own module (eval-sample-{given,mocks,tests}.tsx).

const DEFAULT_CHECK: EvalCheck = { type: 'tool_called', toolId: '', called: true }

type SampleTab = 'config' | 'runs'

export type EvalSampleProps = {
  setId: string
  sampleId: string
  className?: string
}

type Draft = {
  name: string
  description: string
  promptVariables: Record<string, string>
  fixtures: EvalFixtures
  checks: CheckTree
}

function draftFromRow(row: WfEvalRowDTO): Draft {
  return {
    name: row.name,
    description: row.description ?? '',
    promptVariables: { ...(row.initialCondition.promptVariables ?? {}) },
    fixtures: { ...row.fixtures },
    checks: row.checks,
  }
}

export function EvalSample({ setId, sampleId, className }: EvalSampleProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [tab, setTab] = useState<SampleTab>('config')
  const [runOpen, setRunOpen] = useState(false)
  // Whether the "add mock" tool picker is open — lifted here so its trigger can
  // live in the Mocks step's header (far right) while the picker renders in the
  // step body.
  const [addMockOpen, setAddMockOpen] = useState(false)

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
      description: next.description.trim() || null,
      initialCondition: {
        triggerInput: row.initialCondition.triggerInput,
        promptVariables: next.promptVariables,
      },
      fixtures: next.fixtures,
      checks: next.checks,
    })
  }

  // Append a test and open it. Lifted here so its trigger can live in the Tests
  // step's header (far right).
  const addTest = () => {
    if (!draft) return
    const checks = {
      ...draft.checks,
      checks: [...draft.checks.checks, DEFAULT_CHECK],
    }
    persist({ ...draft, checks })
    navigate(
      `evals/${setId}/samples/${sampleId}/tests/${checks.checks.length - 1}`,
    )
  }

  return (
    <WfShell
      className={className}
      scroll
      titleIcon={<Microscope className="size-5 shrink-0 text-rose-500" />}
      assetLabel="Sample"
      crumbs={[
        { home: true },
        sectionCrumb('evals'),
        {
          assetLabel: 'Goal',
          label: set?.name ?? 'Goal',
          to: `evals/${setId}`,
          icon: Goal,
          iconClassName: 'text-rose-500',
        },
        row && draft
          ? {
              editable: {
                value: draft.name,
                onChange: (name) => setDraft({ ...draft, name }),
                onCommit: () => {
                  if (draft.name !== row.name) persist(draft)
                },
                ariaLabel: 'Sample name',
              },
            }
          : { label: 'Sample' },
      ]}
      descriptionEditable={
        row && draft
          ? {
              value: draft.description,
              onChange: (description) => setDraft({ ...draft, description }),
              onCommit: () => {
                if (draft.description !== (row.description ?? '')) persist(draft)
              },
              ariaLabel: 'Sample description',
            }
          : undefined
      }
      actions={
        row && draft ? (
          <>
            <ArchiveButton
              description={
                <>
                  Archive <strong>{draft.name || 'this sample'}</strong>? It’ll
                  be removed from the goal, along with its tests.
                </>
              }
              onConfirm={() => {
                deleteRow.mutate(row.id)
                navigate(`evals/${setId}`)
              }}
            />
            <Button size="sm" variant="outline" onClick={() => setRunOpen(true)}>
              <Play className="size-4" />
              Run Tests
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        {isLoading && !row ? (
          <EmptyState message="Loading sample…" />
        ) : !row || !draft ? (
          <EmptyState message="This sample doesn't exist, or was archived / removed." />
        ) : (
          <>
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
                { key: 'config', label: 'Configuration' },
                { key: 'runs', label: 'Test runs' },
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
                    {
                      key: 'mocks',
                      title:
                        set?.targetKind === 'workflow'
                          ? 'Mocked Nodes'
                          : 'Mocked Tools',
                      aside:
                        (set?.targetKind ?? 'agent') === 'agent' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setAddMockOpen((o) => !o)}
                          >
                            <Plus className="size-4" />
                            Add mock
                          </Button>
                        ) : undefined,
                      content: (
                        <MockToolsPanel
                          targetId={set?.targetId ?? ''}
                          targetKind={set?.targetKind ?? 'agent'}
                          fixtures={draft.fixtures}
                          addOpen={addMockOpen}
                          onAddOpenChange={setAddMockOpen}
                          onChange={(fixtures) =>
                            persist({ ...draft, fixtures })
                          }
                        />
                      ),
                    },
                    {
                      key: 'tests',
                      title: 'Tests',
                      aside: (
                        <Button size="sm" variant="ghost" onClick={addTest}>
                          <Plus className="size-4" />
                          Add test
                        </Button>
                      ),
                      content: (
                        <TestsList
                          setId={setId}
                          sampleId={sampleId}
                          checks={draft.checks}
                          onChange={(checks) => persist({ ...draft, checks })}
                        />
                      ),
                    },
                  ] satisfies Step[]
                }
              />
            ) : (
              <RunsForSample setId={setId} />
            )}
          </>
        )}
      </div>
    </WfShell>
  )
}
