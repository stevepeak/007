import { Goal, Microscope, Play, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { agentOutputJsonSchema, type JsonSchema } from '../../engine'
import type {
  CheckTree,
  EvalCheck,
  EvalSampleInput,
  EvalSampleLayer,
  EvalTools,
  WfEvalRowDTO,
} from '../../server/protocol'
import { evalSampleLayer } from '../../server/protocol'
import { ArchiveButton } from '../archive-button'
import { useWfComponents } from '../context'
import {
  useAgents,
  useDeleteEvalRow,
  useEvalSet,
  useUpsertEvalRow,
} from '../hooks'
import { useWfNav } from '../nav'
import { QueryState } from '../query-state'
import { WfShell } from '../shell'
import { sectionCrumb } from '../wf-crumbs'

import { RunsForSample, ChecksList } from './eval-sample-checks'
import { emptyInputFor, SampleInputEditor } from './eval-sample-input'
import { SampleToolsEditor, useTargetHasTools } from './eval-sample-tools'
import { RunConfigDialog } from './run-config-dialog'
import { EmptyState, Tabs, useTargetAgentCrumb } from './shared'
import { StepFlow, type Step } from './step-flow'

// The Sample view (route: evals/<setId>/samples/<sampleId>). A Sample IS a
// wf_eval_row, and it answers three questions in order:
//
//   1. INPUT  — what is the target invoked with? The editor is chosen by the
//               TARGET's own contract (task variables / a conversation thread /
//               a workflow's trigger payload), so there is exactly one input
//               source per sample instead of several competing ones.
//   2. TOOLS  — how do its tools behave? One tri-state: mocked, none, or live.
//   3. CHECKS — what has to be true of the run? Each check is a collapsible row
//               authored in place (there is no separate Check page), and gated
//               by the tools setting, so a trajectory check can't be authored
//               where no tool step will exist.
//
// Which TESTING LAYER that adds up to (synthesis, trajectory, integration) is
// derived and shown in the header — never stored, so it can't drift from the
// settings it names. Edits persist to the row on blur / on action (rows are
// mutable; no version step).

// The check "Add check" starts from. A tool assertion is the most common one to
// want — except against an agent that has no tools, where it is unsatisfiable by
// construction, so that target starts from an assertion about the answer.
const DEFAULT_CHECK: EvalCheck = { type: 'tool_called', toolId: '', called: true }
const DEFAULT_CHECK_NO_TOOLS: EvalCheck = {
  type: 'output_match',
  match: 'contains',
  value: '',
}

type SampleTab = 'config' | 'runs'

export type EvalSampleProps = {
  setId: string
  sampleId: string
  /**
   * Open with this check already expanded — how a run report's per-check link
   * (`?check=<i>`) hands an investigation over, instead of dropping you on the
   * sample and making you find the check in it again.
   */
  initialCheckIndex?: number | null
  className?: string
}

type Draft = {
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

// The header badge for the derived testing layer. `io` gets no badge — a plain
// input → output test is the baseline, not a mode worth naming.
const LAYERS: Record<
  Exclude<EvalSampleLayer, 'io'>,
  { label: string; className: string; title: string }
> = {
  synthesis: {
    label: 'Synthesis',
    className: 'bg-amber-100 text-amber-700',
    title:
      'A staged conversation with no tools — grades the final response in isolation.',
  },
  trajectory: {
    label: 'Trajectory',
    className: 'bg-violet-100 text-violet-700',
    title:
      'Mocked tools — grades which tools the agent reached for, and with what.',
  },
  integration: {
    label: 'Integration',
    className: 'bg-sky-100 text-sky-700',
    title: 'Live read tools — grades the agent against real retrieval.',
  },
}

export function EvalSample({
  setId,
  sampleId,
  initialCheckIndex,
  className,
}: EvalSampleProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [tab, setTab] = useState<SampleTab>('config')
  const [runOpen, setRunOpen] = useState(false)
  // Which check row is expanded — the accordion state lives here so "Add check"
  // can open the row it just appended.
  const [openCheck, setOpenCheck] = useState<number | null>(
    initialCheckIndex ?? null,
  )
  // Whether the "add mock" tool picker is open — lifted here so its trigger can
  // live in the Tools step's header (far right) while the picker renders in the
  // step body.
  const [addMockOpen, setAddMockOpen] = useState(false)

  const { data, isLoading } = useEvalSet(setId)
  const set = data?.set
  const row = useMemo(
    () => data?.rows.find((r) => r.id === sampleId),
    [data?.rows, sampleId],
  )
  const targetAgentCrumb = useTargetAgentCrumb(set?.targetId, set?.targetVersion)
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

  // Local draft, synced once per row id so background refetches don't clobber an
  // in-progress edit. Every mutation persists the whole row.
  const [draft, setDraft] = useState<Draft | null>(null)
  const syncedIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (row && syncedIdRef.current !== row.id) {
      setDraft(draftFromRow(row))
      syncedIdRef.current = row.id
    }
  }, [row])

  // A deep link expands the check it names. This has to be an effect, not just
  // the initial state above: walking a run report's check rows means several
  // `?check=<i>` links landing on the SAME sample, which shares one tab and so
  // never remounts. Arriving with no `?check` leaves the accordion alone rather
  // than collapsing what the author was editing.
  const linkedCheckRef = useRef<number | null | undefined>(undefined)
  useEffect(() => {
    if (linkedCheckRef.current === initialCheckIndex) return
    linkedCheckRef.current = initialCheckIndex
    if (initialCheckIndex != null) setOpenCheck(initialCheckIndex)
  }, [initialCheckIndex])

  const persist = (next: Draft) => {
    if (!row) return
    setDraft(next)
    upsertRow.mutate({
      id: row.id,
      setId,
      name: next.name.trim() || 'Untitled sample',
      description: next.description.trim() || null,
      input: next.input,
      tools: next.tools,
      checks: next.checks,
    })
  }

  // Append a check and expand it. Lifted here because the draft and the
  // accordion state both live here; the trigger is the last row of the
  // checklist itself.
  const addCheck = () => {
    if (!draft) return
    const checks = {
      ...draft.checks,
      checks: [
        ...draft.checks.checks,
        hasTools ? DEFAULT_CHECK : DEFAULT_CHECK_NO_TOOLS,
      ],
    }
    persist({ ...draft, checks })
    setOpenCheck(checks.checks.length - 1)
  }

  // A sample authored before its goal's target changed input kind still holds
  // the old variant. Offer the swap rather than silently rewriting an author's
  // work — the old input's values are what they'd have to retype.
  const expectedKind =
    draft?.input.kind === 'trigger'
      ? 'trigger'
      : (targetAgent?.inputKind ?? 'task')
  const kindMismatch = !!draft && draft.input.kind !== expectedKind

  const layer = draft ? evalSampleLayer(draft.input, draft.tools) : 'io'
  const badge = layer === 'io' ? null : LAYERS[layer]
  const stagedToolResults =
    draft?.input.kind === 'conversation'
      ? draft.input.turns.reduce((n, t) => n + (t.toolCalls?.length ?? 0), 0)
      : 0

  return (
    <WfShell
      className={className}
      scroll
      titleIcon={<Microscope className="size-5 shrink-0 text-rose-500" />}
      assetLabel="Sample"
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
            {badge ? (
              <span
                title={badge.title}
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${badge.className}`}
              >
                {badge.label}
              </span>
            ) : null}
            <ArchiveButton
              description={
                <>
                  Archive <strong>{draft.name || 'this sample'}</strong>? It’ll
                  be removed from the goal, along with its checks.
                </>
              }
              onConfirm={() => {
                deleteRow.mutate(row.id)
                navigate(`evals/${setId}`)
              }}
            />
            <Button size="sm" variant="outline" onClick={() => setRunOpen(true)}>
              <Play className="size-4" />
              Run Sample
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <QueryState
          // `draft` is local state seeded from `row`, so the sample is only
          // really ready when both have landed — one gate, not two.
          query={{
            isLoading,
            error: null,
            data: row && draft ? { row, draft } : undefined,
          }}
          loading={<EmptyState message="Loading sample…" />}
          empty={
            <EmptyState message="This sample doesn't exist, or was archived / removed." />
          }
        >
          {({ draft }) => (
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
                        key: 'input',
                        title: INPUT_TITLES[draft.input.kind],
                        content: (
                          <div className="space-y-3">
                            {kindMismatch ? (
                              <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                                <p className="text-[11px] text-amber-700">
                                  This sample holds a{' '}
                                  <strong>{draft.input.kind}</strong> input, but{' '}
                                  {targetAgent?.name ?? 'the target agent'} now
                                  takes a <strong>{expectedKind}</strong> one — the
                                  run will ignore what&apos;s below.
                                </p>
                                <button
                                  type="button"
                                  onClick={() =>
                                    persist({
                                      ...draft,
                                      input: emptyInputFor(
                                        expectedKind === 'conversation'
                                          ? 'conversation'
                                          : 'task',
                                      ),
                                    })
                                  }
                                  className="ml-auto shrink-0 text-[11px] font-medium text-amber-800 underline"
                                >
                                  Switch to {expectedKind}
                                </button>
                              </div>
                            ) : null}
                            <SampleInputEditor
                              targetId={set?.targetId ?? ''}
                              value={draft.input}
                              onChange={(input) => persist({ ...draft, input })}
                            />
                          </div>
                        ),
                      },
                      // Only when the target actually has tools. `null` = still
                      // resolving the agent, so nothing renders yet rather than a
                      // card that flashes in and back out.
                      ...(hasTools
                        ? [
                            {
                              key: 'tools',
                              title:
                                set?.targetKind === 'workflow' ? 'Nodes' : 'Tools',
                              aside:
                                draft.tools.mode === 'mocked' &&
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
                                <SampleToolsEditor
                                  targetId={set?.targetId ?? ''}
                                  targetKind={set?.targetKind ?? 'agent'}
                                  value={draft.tools}
                                  onChange={(tools) =>
                                    persist({ ...draft, tools })
                                  }
                                  addOpen={addMockOpen}
                                  onAddOpenChange={setAddMockOpen}
                                  stagedToolResults={stagedToolResults}
                                />
                              ),
                            },
                          ]
                        : []),
                      {
                        key: 'checks',
                        title: 'Checks',
                        content: (
                          <ChecksList
                            checks={draft.checks}
                            tools={draft.tools}
                            targetKind={set?.targetKind}
                            hasTools={hasTools}
                            outputSchema={outputSchema}
                            allowToolIds={allowToolIds}
                            openIndex={openCheck}
                            onOpenChange={setOpenCheck}
                            onChange={(checks) => persist({ ...draft, checks })}
                            onAdd={addCheck}
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
        </QueryState>
      </div>
    </WfShell>
  )
}

// The Input card names the shape it is actually editing — which is also what
// says, without a second label, what kind of agent this goal targets.
const INPUT_TITLES: Record<EvalSampleInput['kind'], string> = {
  task: 'Input',
  conversation: 'Conversation',
  trigger: 'Trigger payload',
}
