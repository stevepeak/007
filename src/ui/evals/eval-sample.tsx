import {
  Bot,
  ChevronRight,
  FlaskConical,
  Play,
  Plus,
  Save,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { useWfComponents } from '../context'
import { useWfNav } from '../nav'
import { ArchiveButton } from '../archive-button'
import { WfShell } from '../shell'
import { sectionCrumb } from '../wf-crumbs'
import { getMockRunHistory } from './mock-data'
import {
  archiveSample,
  createTest,
  currentSampleVersion,
  currentTestVersion,
  getGoal,
  getSample,
  listTests,
  saveSample,
  useEvalsRevision,
  type Given,
  type Sample,
  type SampleConfig,
  type Test,
} from './mock-store'
import { RunConfigDialog } from './run-config-dialog'
import {
  EmptyState,
  FamilyTag,
  Score,
  Tabs,
  TestRunsTable,
  VersionsList,
} from './shared'
import { PickerCards, StepFlow, type Step } from './step-flow'
import { TodoSpark } from './todo-spark'

// The Sample view (route: evals/<setId>/samples/<sampleId>). Name + description
// are edited inline in the header; the Configuration tab is a left-to-right flow
// of step cards (Target → Given → Mocks → Test). Save mints a new immutable
// sample VERSION (no publish step). Tests are separate versioned entities parented
// here (editing a test never bumps the sample). Tabs: Configuration | Test runs |
// Versions.

type SampleTab = 'config' | 'runs' | 'versions'

export type EvalSampleProps = {
  setId: string
  sampleId: string
  className?: string
}

export function EvalSample({ setId, sampleId, className }: EvalSampleProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [tab, setTab] = useState<SampleTab>('config')
  const [runOpen, setRunOpen] = useState(false)

  useEvalsRevision()
  const goal = getGoal(setId)
  const sample = getSample(sampleId)
  const baseline = sample ? currentSampleVersion(sample).config : null

  const [form, setForm] = useState<SampleConfig | null>(baseline)
  const runs = getMockRunHistory(sampleId, sample?.lastResult?.score != null)

  const dirty = useMemo(
    () =>
      form != null &&
      baseline != null &&
      JSON.stringify(form) !== JSON.stringify(baseline),
    [form, baseline],
  )

  return (
    <WfShell
      className={className}
      scroll
      crumbs={[
        { home: true },
        sectionCrumb('evals'),
        { label: goal?.name ?? 'Goal', to: `evals/${setId}` },
        { label: form?.name || 'Sample' },
      ]}
    >
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        {!sample || !form ? (
          <EmptyState message="This sample doesn't exist, or was archived / removed." />
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <input
                  value={form.name}
                  maxLength={40}
                  placeholder="Untitled sample"
                  aria-label="Sample name"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full truncate rounded bg-transparent text-lg font-semibold text-neutral-900 outline-none placeholder:text-neutral-300 focus:bg-neutral-50"
                />
                <textarea
                  value={form.summary}
                  rows={1}
                  placeholder="Add a description…"
                  aria-label="Sample description"
                  onChange={(e) => setForm({ ...form, summary: e.target.value })}
                  className="w-full resize-none rounded bg-transparent text-sm text-neutral-600 outline-none placeholder:text-neutral-300 focus:bg-neutral-50"
                />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  disabled={!dirty}
                  onClick={() => saveSample(sampleId, form)}
                >
                  <Save className="size-4" />
                  Save
                </Button>
                <ArchiveButton
                  description={
                    <>
                      Archive <strong>{form.name || 'this sample'}</strong>? It’ll
                      be removed from the goal, along with its tests.
                    </>
                  }
                  onConfirm={() => {
                    archiveSample(sampleId)
                    navigate(`evals/${setId}`)
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRunOpen(true)}
                >
                  <Play className="size-4" />
                  Run sample
                </Button>
              </div>
            </div>

            <RunConfigDialog
              open={runOpen}
              onClose={() => setRunOpen(false)}
              scope="sample"
              targetName={form.name || 'Untitled sample'}
            />

            <Tabs
              active={tab}
              onChange={(k) => setTab(k as SampleTab)}
              tabs={[
                { key: 'config', label: 'Configuration' },
                { key: 'runs', label: 'Test runs', count: runs.length },
                {
                  key: 'versions',
                  label: 'Versions',
                  count: sample.versions.length,
                },
              ]}
            />

            {tab === 'config' ? (
              <ConfigTab
                setId={setId}
                sampleId={sampleId}
                sample={sample}
                form={form}
                setForm={setForm}
              />
            ) : tab === 'runs' ? (
              <TestRunsTable rows={runs} />
            ) : (
              <VersionsList versions={sample.versions} />
            )}
          </>
        )}
      </div>
    </WfShell>
  )
}

function ConfigTab({
  setId,
  sampleId,
  sample,
  form,
  setForm,
}: {
  setId: string
  sampleId: string
  sample: Sample
  form: SampleConfig
  setForm: (next: SampleConfig) => void
}) {
  const patch = (p: Partial<SampleConfig>) => setForm({ ...form, ...p })
  const tests = listTests(sample.id)

  const steps: Step[] = [
    {
      key: 'mocks',
      title: 'Mocks',
      aside: (
        <>
          <TodoSpark title="Mock node & tool outputs">
            <p>
              A <strong>Mocks</strong> section to stub the canned outputs of
              specific nodes/tools for this sample&apos;s run — e.g.{' '}
              <code>search_kb</code> → fixed docs, <code>send_email</code> →
              no-op.
            </p>
            <p>
              Under <code>simulate</code>, read tools return their mock
              (deterministic) and write tools stay safe. This is the row-level
              &ldquo;fixtures&rdquo; from the plan.
            </p>
          </TodoSpark>
          <span className="text-[11px] uppercase tracking-wide text-neutral-400">
            Planned
          </span>
        </>
      ),
      content: <MocksPanel />,
    },
    {
      key: 'given',
      title: 'Given',
      aside: (
        <>
          <TodoSpark title="Dynamic Given from the target's parameters">
            <p>
              The <strong>Given</strong> fields should be generated from the
              selected target&apos;s input parameters — its trigger{' '}
              <code>inputSchema</code> and prompt variables — so you fill in real
              expected inputs instead of typing arbitrary keys.
            </p>
          </TodoSpark>
          <span className="text-[11px] uppercase tracking-wide text-neutral-400">
            Initial state
          </span>
        </>
      ),
      content: (
        <GivenEditor given={form.given} onChange={(given) => patch({ given })} />
      ),
    },
    {
      key: 'test',
      title: 'Tests',
      content: <TestsList setId={setId} sampleId={sampleId} tests={tests} />,
    },
  ]

  return (
    <div className="space-y-3">
      <TargetStep form={form} patch={patch} />
      <StepFlow steps={steps} />
    </div>
  )
}

function TargetStep({
  form,
  patch,
}: {
  form: SampleConfig
  patch: (p: Partial<SampleConfig>) => void
}) {
  const { Input, Label } = useWfComponents()
  return (
    <PickerCards
      value={form.kind}
      collapsedByDefault={!!form.targetName}
      onSelect={(kind) => patch({ kind })}
      options={[
        {
          value: 'agent',
          icon: Bot,
          label: 'Agent',
          desc: 'A single agent with a prompt and tools.',
          accent: 'violet',
          detail: form.targetName || 'Unnamed agent',
          setting: (
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                <Label>Which agent</Label>
                <TodoSpark title="Target picker — choose an agent or workflow">
                  <p>
                    Instead of a free-text field, <strong>Target</strong> should
                    be a dropdown listing your agents and workflows — each shown
                    with its icon and name.
                  </p>
                  <p>
                    Selecting one wires the sample to that agent/workflow
                    (float-to-latest), and drives both the dynamic Given fields
                    and the available Mocks.
                  </p>
                </TodoSpark>
              </div>
              <Input
                value={form.targetName}
                placeholder="Agent name"
                onChange={(e) =>
                  patch({ targetName: e.target.value, kind: 'agent' })
                }
              />
            </div>
          ),
        },
        {
          value: 'workflow',
          icon: WorkflowIcon,
          label: 'Workflow',
          desc: 'A multi-step graph of agents and nodes.',
          accent: 'indigo',
          disabled: true,
          badge: 'Coming soon',
        },
      ]}
    />
  )
}

function MocksPanel() {
  return (
    <p className="text-xs text-neutral-400">
      Mock tool / node outputs so runs are deterministic and safe.
    </p>
  )
}

function GivenEditor({
  given,
  onChange,
}: {
  given: Given[]
  onChange: (given: Given[]) => void
}) {
  const { Input, Button } = useWfComponents()
  const update = (id: string, p: Partial<Given>) =>
    onChange(given.map((g) => (g.id === id ? { ...g, ...p } : g)))
  const remove = (id: string) => onChange(given.filter((g) => g.id !== id))
  const add = () =>
    onChange([
      ...given,
      { id: `gv_${crypto.randomUUID().slice(0, 8)}`, label: '', value: '' },
    ])

  return (
    <div className="space-y-2">
      {given.length === 0 ? (
        <p className="px-1 py-1 text-xs text-neutral-400">
          No initial state yet.
        </p>
      ) : (
        given.map((g) => (
          <div key={g.id} className="flex items-center gap-2">
            <Input
              value={g.label}
              placeholder="field"
              onChange={(e) => update(g.id, { label: e.target.value })}
              className="h-8 w-32 font-mono text-xs"
            />
            <Input
              value={g.value}
              placeholder="value"
              onChange={(e) => update(g.id, { value: e.target.value })}
              className="h-8 flex-1 font-mono text-xs"
            />
            <button
              type="button"
              aria-label="Remove"
              onClick={() => remove(g.id)}
              className="text-neutral-300 transition hover:text-neutral-600"
            >
              <X className="size-4" />
            </button>
          </div>
        ))
      )}
      <Button size="sm" variant="ghost" onClick={add}>
        <Plus className="size-4" />
        Add field
      </Button>
    </div>
  )
}

function TestsList({
  setId,
  sampleId,
  tests,
}: {
  setId: string
  sampleId: string
  tests: Test[]
}) {
  const { navigate } = useWfNav()
  const { Button } = useWfComponents()
  return (
    <div className="space-y-2">
      {tests.length === 0 ? (
        <p className="px-1 py-1 text-xs text-neutral-400">
          No tests yet. Add one to assert an outcome.
        </p>
      ) : (
        <div className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200">
          {tests.map((t) => {
            const cfg = currentTestVersion(t).config
            return (
              <button
                key={t.id}
                type="button"
                onClick={() =>
                  navigate(`evals/${setId}/samples/${sampleId}/tests/${t.id}`)
                }
                className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-neutral-50"
              >
                <FlaskConical className="mt-0.5 size-4 shrink-0 text-neutral-400" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-neutral-800">
                    {cfg.label}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <FamilyTag scored={cfg.family === 'scored'} />
                    <code className="font-mono text-[11px] text-neutral-400">
                      {cfg.type}
                    </code>
                    {cfg.family === 'scored' && t.lastVerdict?.score != null ? (
                      <span className="text-xs text-neutral-500">
                        score <Score value={t.lastVerdict.score} />
                      </span>
                    ) : null}
                  </div>
                </div>
                <ChevronRight className="mt-0.5 size-4 shrink-0 text-neutral-300" />
              </button>
            )
          })}
        </div>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() =>
          navigate(
            `evals/${setId}/samples/${sampleId}/tests/${createTest(sampleId)}`,
          )
        }
      >
        <Plus className="size-4" />
        Add test
      </Button>
    </div>
  )
}
