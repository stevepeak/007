import { Archive, Play, Save } from 'lucide-react'
import { useMemo, useState } from 'react'

import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useWfNav } from '../nav'
import { WfShell } from '../shell'
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
import {
  EmptyState,
  FamilyTag,
  Tabs,
  TestRunsTable,
  VersionBadge,
  VersionsList,
} from './shared'
import { TodoSpark } from './todo-spark'

// The single-test view (route: evals/<setId>/samples/<sampleId>/tests/<testId>).
// A "Test" is one check. The Configuration tab is an editable form — Save mints a
// new immutable test VERSION (no publish step). Tabs: Configuration | Test runs |
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
        { label: 'Goals', to: 'evals' },
        { label: goal?.name ?? 'Goal', to: `evals/${setId}` },
        {
          label: sample ? currentSampleVersion(sample).config.name : 'Sample',
          to: `evals/${setId}/samples/${sampleId}`,
        },
        { label: form?.label || 'Test' },
      ]}
    >
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        {!test || !form ? (
          <EmptyState message="This test doesn't exist, or was archived / removed." />
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-lg font-semibold text-neutral-900">
                  {form.label || 'Untitled test'}
                </h1>
                <VersionBadge version={currentTestVersion(test).version} />
                <FamilyTag scored={scored} />
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
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    archiveTest(testId)
                    navigate(`evals/${setId}/samples/${sampleId}`)
                  }}
                >
                  <Archive className="size-4" />
                  Archive
                </Button>
                <Button size="sm" variant="outline">
                  <Play className="size-4" />
                  Run test
                </Button>
              </div>
            </div>

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
  const { Input, Label, Textarea } = useWfComponents()
  const scored = form.family === 'scored'

  const setFamily = (family: TestFamily) => {
    if (family === 'scored') {
      setForm({
        family: 'scored',
        type: 'llm_judge',
        label: form.label,
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
      })
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4">
      <div className="space-y-1">
        <Label>Asserts</Label>
        <Input
          value={form.label}
          placeholder="e.g. notify_supervisor was called"
          onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label>Family</Label>
            <TodoSpark title="Family as a large centered toggle">
              <p>
                Drop the <strong>Family</strong> label entirely. Make
                binary/scored a <strong>larger, centered toggle</strong> at the
                top of the test.
              </p>
              <p>
                Everything else — the assertion, type, and family-specific config
                — flows <strong>below</strong> it, so choosing binary vs scored
                reads as the primary decision that shapes the form.
              </p>
            </TodoSpark>
          </div>
          <div className="inline-flex rounded-md border border-neutral-300 p-0.5">
            {(['binary', 'scored'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFamily(f)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                  form.family === f
                    ? 'bg-neutral-900 text-white'
                    : 'text-neutral-500 hover:text-neutral-800',
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <Label>Type</Label>
          {scored ? (
            <div className="flex h-9 items-center">
              <code className="rounded bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-600">
                llm_judge
              </code>
            </div>
          ) : (
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
          )}
        </div>
      </div>

      {scored ? (
        <>
          <div className="space-y-1">
            <Label>Rubric</Label>
            <Textarea
              rows={3}
              value={form.rubric ?? ''}
              placeholder="What should the judge reward or penalize?"
              onChange={(e) => setForm({ ...form, rubric: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
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
            <div className="space-y-1">
              <Label>Judge model</Label>
              <Input
                value={form.model ?? 'default'}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
            </div>
          </div>
          <p className="text-xs text-neutral-400">
            Scored tests contribute to the goal/sample score; binary tests only
            affect pass/fail.
          </p>
        </>
      ) : (
        <p className="text-xs text-neutral-400">
          Binary tests are pure pass/fail — they never enter the score.
        </p>
      )}
    </section>
  )
}
