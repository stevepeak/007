import { Binary, Gauge, Play, Save } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useWfComponents } from '../context'
import { useWfNav } from '../nav'
import { ArchiveButton } from '../archive-button'
import { WfShell } from '../shell'
import { sectionCrumb } from '../wf-crumbs'
import { ModelSelect } from '../editor/model-select'
import { getMockRunHistory } from './mock-data'
import {
  archiveTest,
  currentSampleVersion,
  currentTestVersion,
  getGoal,
  getSample,
  getTest,
  saveTest,
  useEvalsRevision,
  type TestConfig,
  type TestFamily,
} from './mock-store'
import { RunConfigDialog } from './run-config-dialog'
import { EmptyState, Tabs, TestRunsTable, VersionsList } from './shared'
import { PickerCards, StepFlow, type Step } from './step-flow'

// The single-test view (route: evals/<setId>/samples/<sampleId>/tests/<testId>).
// A "Test" is one check. Name (the assertion) + description are edited inline in
// the header; the Configuration tab is a left-to-right flow: pick the test Type
// (binary vs scored, plus the type/judge), then configure it. Save mints a new
// immutable test VERSION (no publish step). Tabs: Configuration | Test runs |
// Versions.

type TestTab = 'config' | 'runs' | 'versions'

const BINARY_TYPES = [
  'tool_called',
  'tool_args_match',
  'node_visited',
  'node_input_match',
  'output_match',
] as const

export type EvalTestProps = {
  setId: string
  sampleId: string
  testId: string
  className?: string
}

export function EvalTest({
  setId,
  sampleId,
  testId,
  className,
}: EvalTestProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [tab, setTab] = useState<TestTab>('config')
  const [runOpen, setRunOpen] = useState(false)

  useEvalsRevision()
  const goal = getGoal(setId)
  const sample = getSample(sampleId)
  const test = getTest(testId)
  const baseline = test ? currentTestVersion(test).config : null

  const [form, setForm] = useState<TestConfig | null>(baseline)
  const scored = form?.family === 'scored'
  const runs = getMockRunHistory(testId, scored)

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
        {
          label: sample ? currentSampleVersion(sample).config.name : 'Sample',
          to: `evals/${setId}/samples/${sampleId}`,
        },
        { label: form?.label || 'Test' },
      ]}
    >
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        {!test || !form ? (
          <EmptyState message="This test doesn't exist, or was archived / removed." />
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <input
                  value={form.label}
                  maxLength={40}
                  placeholder="Untitled test"
                  aria-label="Test name"
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  className="w-full truncate rounded bg-transparent text-lg font-semibold text-neutral-900 outline-none placeholder:text-neutral-300 focus:bg-neutral-50"
                />
                <textarea
                  value={form.description ?? ''}
                  rows={1}
                  placeholder="Add a description…"
                  aria-label="Test description"
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  className="w-full resize-none rounded bg-transparent text-sm text-neutral-600 outline-none placeholder:text-neutral-300 focus:bg-neutral-50"
                />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  disabled={!dirty}
                  onClick={() => saveTest(testId, form)}
                >
                  <Save className="size-4" />
                  Save
                </Button>
                <ArchiveButton
                  description={
                    <>
                      Archive <strong>{form.label || 'this test'}</strong>? It’ll
                      be removed from the sample.
                    </>
                  }
                  onConfirm={() => {
                    archiveTest(testId)
                    navigate(`evals/${setId}/samples/${sampleId}`)
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRunOpen(true)}
                >
                  <Play className="size-4" />
                  Run test
                </Button>
              </div>
            </div>

            <RunConfigDialog
              open={runOpen}
              onClose={() => setRunOpen(false)}
              scope="test"
              targetName={form.label || 'Untitled test'}
            />

            <Tabs
              active={tab}
              onChange={(k) => setTab(k as TestTab)}
              tabs={[
                { key: 'config', label: 'Configuration' },
                { key: 'runs', label: 'Test runs', count: runs.length },
                {
                  key: 'versions',
                  label: 'Versions',
                  count: test.versions.length,
                },
              ]}
            />

            {tab === 'config' ? (
              <ConfigForm form={form} setForm={setForm} />
            ) : tab === 'runs' ? (
              <TestRunsTable rows={runs} />
            ) : (
              <VersionsList versions={test.versions} />
            )}
          </>
        )}
      </div>
    </WfShell>
  )
}

function ConfigForm({
  form,
  setForm,
}: {
  form: TestConfig
  setForm: (next: TestConfig) => void
}) {
  const setFamily = (family: TestFamily) => {
    if (family === 'scored') {
      setForm({
        family: 'scored',
        type: 'llm_judge',
        label: form.label,
        description: form.description,
        rubric: form.rubric ?? form.label,
        threshold: form.threshold ?? 0.7,
        weight: form.weight ?? 1,
        model: form.model ?? 'default',
      })
    } else {
      setForm({
        family: 'binary',
        type: BINARY_TYPES.includes(form.type as (typeof BINARY_TYPES)[number])
          ? form.type
          : 'tool_called',
        label: form.label,
        description: form.description,
      })
    }
  }

  const steps: Step[] = [
    {
      key: 'config',
      title: 'Configuration',
      content: <TestConfigStep form={form} setForm={setForm} />,
    },
  ]

  return (
    <div className="space-y-3">
      <TypeStep form={form} setForm={setForm} setFamily={setFamily} />
      <StepFlow steps={steps} />
    </div>
  )
}

function TypeStep({
  form,
  setForm,
  setFamily,
}: {
  form: TestConfig
  setForm: (next: TestConfig) => void
  setFamily: (family: TestFamily) => void
}) {
  const { Label } = useWfComponents()
  return (
    <PickerCards
      value={form.family}
      collapsedByDefault
      onSelect={(f) => setFamily(f)}
      options={[
        {
          value: 'binary',
          icon: Binary,
          label: 'Binary',
          desc: 'A pass/fail check.',
          accent: 'sky',
          detail: form.type,
          setting: (
            <div className="space-y-1">
              <Label>Check type</Label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
              >
                {BINARY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          ),
        },
        {
          value: 'scored',
          icon: Gauge,
          label: 'Scored',
          desc: 'An LLM judge grades the output come alignment with expectations.',
          accent: 'amber',
          detail: `${form.model || 'default'} judge`,
        },
      ]}
    />
  )
}

function TestConfigStep({
  form,
  setForm,
}: {
  form: TestConfig
  setForm: (next: TestConfig) => void
}) {
  const { Input, Label, Textarea } = useWfComponents()

  if (form.family !== 'scored') {
    return (
      <div className="py-6 text-center text-sm text-neutral-400">
        No extra configuration for binary tests yet — coming soon. Binary tests
        are pure pass/fail; they never enter the score.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Judge model</Label>
        <ModelSelect
          value={form.model ?? ''}
          onChange={(model) => setForm({ ...form, model })}
        />
      </div>
      <div className="space-y-1">
        <Label>Rubric</Label>
        <Textarea
          rows={3}
          value={form.rubric ?? ''}
          placeholder="What should the judge reward or penalize?"
          onChange={(e) => setForm({ ...form, rubric: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Threshold</Label>
          <Input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={String(form.threshold ?? 0.7)}
            onChange={(e) =>
              setForm({ ...form, threshold: Number(e.target.value) })
            }
          />
        </div>
        <div className="space-y-1">
          <Label>Weight</Label>
          <Input
            type="number"
            step="0.5"
            min="0"
            value={String(form.weight ?? 1)}
            onChange={(e) =>
              setForm({ ...form, weight: Number(e.target.value) })
            }
          />
        </div>
      </div>
      <p className="text-xs text-neutral-400">
        Scored tests contribute to the goal/sample score; binary tests only
        affect pass/fail.
      </p>
    </div>
  )
}
