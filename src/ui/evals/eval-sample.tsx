import { Goal, Microscope, Play, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  CheckTree,
  EvalCheck,
  EvalFixtures,
  SeededMessage,
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
import { IdeaSpark } from '../idea-spark'
import { ConversationEditor } from './eval-sample-conversation'
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
  seededMessages: SeededMessage[]
  freezeTools: boolean
  fixtures: EvalFixtures
  checks: CheckTree
}

function draftFromRow(row: WfEvalRowDTO): Draft {
  return {
    name: row.name,
    description: row.description ?? '',
    promptVariables: { ...(row.initialCondition.promptVariables ?? {}) },
    seededMessages: row.initialCondition.seededMessages ?? [],
    freezeTools: row.initialCondition.freezeTools ?? false,
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
        // Synthesis mode — a seeded conversation + freeze flag. Omit empty
        // arrays so a plain sample's initialCondition stays clean.
        seededMessages:
          next.seededMessages.length > 0 ? next.seededMessages : undefined,
        freezeTools: next.freezeTools || undefined,
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
                      key: 'conversation',
                      title: 'Conversation',
                      aside: (
                        <span className="flex items-center gap-1.5">
                          <span className="text-[11px] uppercase tracking-wide text-neutral-400">
                            Synthesis mode
                          </span>
                          <IdeaSpark
                            title="Synthesis mode — grading the final response in isolation"
                            hint="How synthesis mode works, and what's still to come"
                          >
                            <p>
                              A seeded conversation + <strong>Freeze tools</strong>{' '}
                              runs the agent with <strong>no tools</strong>, so it
                              answers from the transcript above and you grade only
                              its final reply — cutting out RAG / tool-selection
                              nondeterminism.
                            </p>
                            <p className="font-medium text-neutral-700">
                              Use it as a lens, not a replacement
                            </p>
                            <p>
                              For a tool-calling agent the tool calls are often the
                              product, and fully seeding retrieval hides the most
                              common failure (a bad query, or nothing retrieved).
                              Layer three kinds of test:
                            </p>
                            <ul className="list-disc space-y-1 pl-5">
                              <li>
                                <strong>Trajectory</strong> — mock the tools, assert{' '}
                                <code>tool_called</code> /{' '}
                                <code>tool_args_match</code> on the query.
                              </li>
                              <li>
                                <strong>Synthesis</strong> (this step) — seed +
                                freeze, then judge the answer. The judge now also
                                sees the seeded tool <em>results</em>, so a rubric
                                can grade groundedness.
                              </li>
                              <li>
                                <strong>Integration</strong> — real tools against a
                                frozen corpus snapshot.
                              </li>
                            </ul>
                            <p className="font-medium text-neutral-700">
                              Authoring tip
                            </p>
                            <p>
                              End the transcript on a <strong>user turn</strong> or
                              an <strong>assistant turn that carries a tool
                              result</strong>. Ending on a plain assistant message
                              makes the model generate a second assistant turn.
                            </p>
                            <p className="font-medium text-neutral-700">
                              Not built yet
                            </p>
                            <ul className="list-disc space-y-1 pl-5">
                              <li>
                                Arg-keyed fixtures — a different query returns
                                different canned chunks (better for the trajectory
                                layer).
                              </li>
                              <li>
                                pass@k across the model × prompt matrix, so one
                                noisy judged run isn&apos;t the whole signal.
                              </li>
                              <li>
                                Split <em>faithfulness</em> vs.{' '}
                                <em>helpfulness</em> judges (now unblocked, since the
                                judge sees context).
                              </li>
                            </ul>
                          </IdeaSpark>
                        </span>
                      ),
                      content: (
                        <ConversationEditor
                          messages={draft.seededMessages}
                          freezeTools={draft.freezeTools}
                          onMessagesChange={(seededMessages) =>
                            persist({ ...draft, seededMessages })
                          }
                          onFreezeToolsChange={(freezeTools) =>
                            persist({ ...draft, freezeTools })
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
