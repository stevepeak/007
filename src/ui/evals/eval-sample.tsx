import {
  Check,
  ChevronRight,
  FlaskConical,
  Goal,
  Microscope,
  Play,
  Plus,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  CheckTree,
  EvalCheck,
  EvalFixtures,
  ToolOption,
  WfEvalRowDTO,
  WfEvalTargetKind,
} from '../../server/protocol'
import { WfAutoForm } from '../autoform/wf-auto-form'
import { useWfComponents } from '../context'
import {
  useAgent,
  useAgents,
  useDeleteEvalRow,
  useEvalRuns,
  useEvalSet,
  useTools,
  useUpsertEvalRow,
} from '../hooks'
import { useOpenAsset, useWfNav } from '../nav'
import { ArchiveButton } from '../archive-button'
import { WfShell } from '../shell'
import { ToolIcon } from '../tool-icon'
import { RunConfigDialog } from './run-config-dialog'
import {
  describeCheck,
  EmptyState,
  formatTimestamp,
  PassRate,
  Score,
  Tabs,
} from './shared'
import { StepFlow, type Step } from './step-flow'

// The Sample view (route: evals/<setId>/samples/<sampleId>). A Sample IS a
// wf_eval_row: a name, a GIVEN (its initialCondition.promptVariables — the
// values the goal's agent is invoked with) and a set of TESTS (its checks tree,
// an AND/OR reduction of EvalChecks). The target agent is set on the Goal, not
// here. Edits persist to the row on blur / on action (rows are mutable; no
// version step).

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

  return (
    <WfShell
      className={className}
      scroll
      titleIcon={<Microscope className="size-5 shrink-0 text-rose-500" />}
      crumbs={[
        { home: true },
        {
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
                      aside: (
                        <span className="text-[11px] uppercase tracking-wide text-neutral-400">
                          Canned outputs
                        </span>
                      ),
                      content: (
                        <MockToolsPanel
                          targetId={set?.targetId ?? ''}
                          targetKind={set?.targetKind ?? 'agent'}
                          fixtures={draft.fixtures}
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
                        <span className="text-[11px] uppercase tracking-wide text-neutral-400">
                          {draft.checks.checks.length === 1
                            ? '1 test'
                            : `${draft.checks.checks.length} tests`}
                        </span>
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

// Per-sample tool fixtures: a pinned output a tool returns under `simulate`, so a
// run is deterministic and side-effect-free (e.g. a memory/search tool returns a
// fixed value instead of executing). Stored in row.fixtures keyed by toolId — one
// canned output per tool. The target agent is the goal's; only agent targets
// today, so workflow "Mock Nodes" is a placeholder until workflow targets ship.
function MockToolsPanel({
  targetId,
  targetKind,
  fixtures,
  onChange,
}: {
  targetId: string
  targetKind: WfEvalTargetKind
  fixtures: EvalFixtures
  onChange: (next: EvalFixtures) => void
}) {
  if (targetKind !== 'agent') {
    return (
      <p className="px-1 py-1 text-xs text-neutral-400">
        Node mocks arrive with workflow targets.
      </p>
    )
  }
  return (
    <AgentToolMocks
      targetId={targetId}
      fixtures={fixtures}
      onChange={onChange}
    />
  )
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function previewOutput(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function AgentToolMocks({
  targetId,
  fixtures,
  onChange,
}: {
  targetId: string
  fixtures: EvalFixtures
  onChange: (next: EvalFixtures) => void
}) {
  const detail = useAgent(targetId)
  const toolsQuery = useTools()

  // Which tool's output editor is open (a toolId; null = none).
  const [editing, setEditing] = useState<string | null>(null)

  const toolIds =
    detail.data?.currentVersion?.config.toolIds ??
    detail.data?.draft?.config.toolIds ??
    []
  const byId = useMemo(
    () => new Map((toolsQuery.data ?? []).map((t) => [t.id, t])),
    [toolsQuery.data],
  )
  const agentTools = useMemo(
    () =>
      toolIds
        .map((id) => byId.get(id))
        .filter((t): t is ToolOption => !!t && t.kind === 'ai-tool'),
    [toolIds, byId],
  )

  const mockedIds = Object.keys(fixtures)
  const available = agentTools.filter((t) => !mockedIds.includes(t.id))

  const save = (toolId: string, output: Record<string, unknown>) => {
    onChange({ ...fixtures, [toolId]: output })
    setEditing(null)
  }
  const remove = (toolId: string) => {
    const next = { ...fixtures }
    delete next[toolId]
    onChange(next)
    if (editing === toolId) setEditing(null)
  }

  if (!targetId) {
    return (
      <p className="px-1 py-1 text-xs text-neutral-400">
        This goal has no target agent yet — set one on the goal to mock its tools.
      </p>
    )
  }
  if (detail.isLoading || toolsQuery.isLoading) {
    return <p className="px-1 py-1 text-xs text-neutral-400">Loading tools…</p>
  }
  if (agentTools.length === 0) {
    return (
      <p className="px-1 py-1 text-xs text-neutral-400">
        The target agent has no tools to mock.
      </p>
    )
  }

  const editingTool = editing ? byId.get(editing) : undefined

  return (
    <div className="space-y-3">
      <p className="px-1 text-xs text-neutral-400">
        Pin a tool&apos;s output so this sample runs deterministically — under
        simulate the tool returns your canned value instead of executing.
      </p>

      {mockedIds.length > 0 ? (
        <div className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200">
          {mockedIds.map((toolId) => {
            const tool = byId.get(toolId)
            return (
              <div key={toolId} className="flex items-start gap-2 px-4 py-3">
                <ToolIcon icon={tool?.icon} className="mt-0.5 size-5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-neutral-800">
                      {tool?.name ?? toolId}
                    </span>
                    {!tool ? (
                      <span className="shrink-0 text-xs text-amber-600">
                        (not in agent)
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-400">
                    {previewOutput(fixtures[toolId])}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setEditing(toolId)}
                  className="text-xs font-medium text-neutral-500 hover:text-neutral-800"
                >
                  Edit
                </button>
                <button
                  type="button"
                  aria-label="Remove mock"
                  onClick={() => remove(toolId)}
                  className="text-neutral-300 transition hover:text-neutral-600"
                >
                  <X className="size-4" />
                </button>
              </div>
            )
          })}
        </div>
      ) : null}

      {editingTool ? (
        <div className="space-y-3 rounded-lg border border-neutral-200 p-4">
          <div className="flex items-center gap-2">
            <ToolIcon icon={editingTool.icon} className="size-5" />
            <span className="text-sm font-medium text-neutral-800">
              {editingTool.name}
            </span>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="ml-auto text-xs font-medium text-neutral-500 hover:text-neutral-800"
            >
              Cancel
            </button>
          </div>
          <WfAutoForm
            key={editingTool.id}
            schema={editingTool.outputSchema}
            defaultValues={asRecord(fixtures[editingTool.id])}
            submitLabel="Save mock"
            submitIcon={<Check className="size-4" />}
            emptyLabel="Output (JSON)"
            onSubmit={(output) => save(editingTool.id, output)}
          />
        </div>
      ) : (
        <ToolAddPicker tools={available} onPick={(toolId) => setEditing(toolId)} />
      )}
    </div>
  )
}

// The agent's tools not yet mocked. Picking one opens its output editor (dedupe
// by toolId enforces one mock per tool). Expands inline (in normal flow) rather
// than as an absolute popover, so it can't be clipped by the StepFlow card's
// `overflow-hidden`.
function ToolAddPicker({
  tools,
  onPick,
}: {
  tools: ToolOption[]
  onPick: (toolId: string) => void
}) {
  const [open, setOpen] = useState(false)

  if (tools.length === 0) {
    return (
      <p className="px-1 py-1 text-xs text-neutral-400">
        Every tool the agent uses is already mocked.
      </p>
    )
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
      >
        <Plus className="size-4" />
        Add mock
      </button>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 p-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-neutral-500">
          Pick a tool to mock
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs font-medium text-neutral-500 hover:text-neutral-800"
        >
          Cancel
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {tools.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              onPick(t.id)
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-neutral-50"
          >
            <ToolIcon icon={t.icon} className="size-5" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-neutral-800">
                {t.name}
              </span>
              {t.description ? (
                <span className="block truncate text-xs text-neutral-400">
                  {t.description}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
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
  const open = useOpenAsset()
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
              onClick={(e) =>
                open(`evals/${setId}/samples/${sampleId}/tests/${i}`, {
                  newTab: e.metaKey || e.ctrlKey,
                })
              }
              className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-neutral-50"
            >
              <FlaskConical className="mt-0.5 size-4 shrink-0 text-neutral-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-neutral-800">
                  {describeCheck(c)}
                </div>
                {c.description ? (
                  <div className="mt-0.5 truncate text-xs text-neutral-500">
                    {c.description}
                  </div>
                ) : null}
              </div>
              <code className="mt-0.5 shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500">
                {c.type}
              </code>
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

// Test runs that included this sample. A run spans a whole set (goal) by
// `setIds` — there is no per-sample run table — so these are the goal's runs,
// filtered from the global history. Clicking one opens the full run report.
function RunsForSample({ setId }: { setId: string }) {
  const open = useOpenAsset()
  const runsQuery = useEvalRuns()
  const runs = (runsQuery.data ?? []).filter((r) => r.setIds.includes(setId))

  if (runsQuery.isLoading) return <EmptyState message="Loading test runs…" />
  if (runs.length === 0) {
    return (
      <EmptyState message="No test runs yet. Run the goal to see results here." />
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span>When</span>
        <span className="text-right">Pass</span>
        <span className="w-24 text-right">Score</span>
      </div>
      {runs.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={(e) =>
            open(`evals/runs/${r.id}`, { newTab: e.metaKey || e.ctrlKey })
          }
          className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 px-4 py-3 text-left last:border-b-0 hover:bg-neutral-50"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-700">
              {formatTimestamp(r.createdAt)}
            </span>
            <span className="text-xs text-neutral-400">{r.status}</span>
          </div>
          <div className="text-right">
            <PassRate passed={r.passed} total={r.total} />
          </div>
          <div className="w-24 text-right">
            <Score value={r.score} />
          </div>
        </button>
      ))}
    </div>
  )
}
