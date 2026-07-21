import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Minus,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { ModelOption } from '../../engine/config'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { groupModelsByProvider } from '../editor/model-grouping'
import { PromptBodyEditor } from '../editor/prompt-body-editor'
import { useAgents, useEvalSets, useModels, useProviders, useRunEval } from '../hooks'
import { Modal } from '../modal'
import { useWfNav } from '../nav'
import { IdeaSpark } from '../idea-spark'
import { BrandMark, inferModelBrand } from './shared'

// The "Run" confirm, shared by the catalog / Goal / Sample / Test Run buttons.
// A run always executes in SIMULATION (write tools no-op, read tools return the
// row's fixtures) and is marked `is_eval` so it stays out of the Runs explorer.
//
// A test suite is a MATRIX of two axes:
//   • which MODELS to run against — a provider-bucketed picker with a run-count
//     per model (the count is best-of-N per sample).
//   • which PROMPTS to run — the target agent's saved prompt is always included;
//     you can add extra system prompts to A/B against it. Prompts reuse the
//     agent-editor tiptap editor and its `${variable}` chips; only variables the
//     target already defines are meaningful (missing / repeated is fine).
// The suite size is `models × prompts` — 4 models × 4 prompts = 16 tests.
//
// Launching is a two-step flow: configure the matrix, then CONFIRM — a screen
// that lays the matrix out and shows an (estimated) cost before anything runs.
//
// The engine can't yet fan a run out across models or swap prompts
// (`startEvalRun` runs each sample once on the target's own configured model
// with its saved prompt), so any matrix beyond a single model / the saved
// prompt disables the launch with a note; the plain path still works. Wiring the
// fan-out — and real cost estimates — is the follow-up captured in the ✨ note.
const SUPPORTS_MATRIX = false

export type RunConfigDialogProps = {
  open: boolean
  onClose: () => void
  /** What this run targets, for the subtitle copy. */
  scope: 'goal' | 'sample' | 'test'
  /** Display name of the thing being run (shown in the subtitle). */
  targetName: string
  /** The eval set(s) to run. Empty = nothing to launch (button disabled). */
  setIds: string[]
}

// One extra system prompt authored for the test matrix. `id` is a client-only
// key; `body` is the raw prompt text (with `${variable}` tokens).
type TestPrompt = { id: string; body: string }

export function RunConfigDialog({
  open,
  onClose,
  scope,
  targetName,
  setIds,
}: RunConfigDialogProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const runEval = useRunEval()

  const modelsQuery = useModels()
  const providersQuery = useProviders()
  const loadingModels = modelsQuery.isLoading || providersQuery.isLoading

  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data])
  const groups = useMemo(
    () => groupModelsByProvider(models, providersQuery.data ?? []),
    [models, providersQuery.data],
  )

  // The `${variables}` the targeted goals' agents already define — the only
  // tokens that mean anything in a test prompt. Resolved from the eval sets in
  // scope → their target agents → each agent's inferred input variables.
  const evalSetsQuery = useEvalSets()
  const agentsQuery = useAgents()
  const availableVariables = useMemo(() => {
    const sets = evalSetsQuery.data ?? []
    const agentById = new Map((agentsQuery.data ?? []).map((a) => [a.id, a]))
    const vars = new Set<string>()
    for (const id of setIds) {
      const set = sets.find((s) => s.id === id)
      if (!set || set.targetKind !== 'agent') continue
      for (const v of agentById.get(set.targetId)?.inputVariables ?? []) {
        vars.add(v)
      }
    }
    return [...vars]
  }, [evalSetsQuery.data, agentsQuery.data, setIds])

  // modelId → run count (0 = unselected). One shared map across all groups.
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Extra prompts to A/B against the agent's saved prompt (always included).
  const [prompts, setPrompts] = useState<TestPrompt[]>([])
  const promptSeq = useRef(0)
  // Two-step flow: pick the matrix, then confirm it.
  const [step, setStep] = useState<'configure' | 'confirm'>('configure')

  // Reset the selection each time the dialog opens so a stale pick from a prior
  // target doesn't leak in.
  useEffect(() => {
    if (open) {
      setCounts({})
      setCollapsed({})
      setPrompts([])
      setStep('configure')
    }
  }, [open])

  if (!open) return null

  const setCount = (modelId: string, next: number) =>
    setCounts((prev) => {
      const value = Math.max(0, next)
      if (value === 0) {
        const { [modelId]: _drop, ...rest } = prev
        return rest
      }
      return { ...prev, [modelId]: value }
    })

  const addPrompt = () =>
    setPrompts((prev) => [...prev, { id: `p${promptSeq.current++}`, body: '' }])
  const removePrompt = (id: string) =>
    setPrompts((prev) => prev.filter((p) => p.id !== id))
  const setPromptBody = (id: string, body: string) =>
    setPrompts((prev) => prev.map((p) => (p.id === id ? { ...p, body } : p)))

  const selectedIds = Object.keys(counts).filter((id) => (counts[id] ?? 0) > 0)
  const selectedModels = models.filter((m) => selectedIds.includes(m.id))
  const totalRuns = selectedIds.reduce((sum, id) => sum + (counts[id] ?? 0), 0)
  // The saved prompt is always one variation; each extra prompt adds another.
  const promptVariations = 1 + prompts.length
  const totalTests = totalRuns * promptVariations

  const needsMatrix = selectedIds.length > 1 || totalRuns > selectedIds.length || prompts.length > 0
  const matrixBlocked = needsMatrix && !SUPPORTS_MATRIX

  const canConfigure = setIds.length > 0 && selectedIds.length > 0
  const canRun = canConfigure && !matrixBlocked && !runEval.isPending

  const launch = async () => {
    if (!canRun) return
    // TODO: thread `selectedIds` / per-model counts / `prompts` through once the
    // engine can fan a run out across the model × prompt matrix. Today the run
    // uses the target's own model and saved prompt.
    const { evalRunId } = await runEval.mutateAsync({ setIds })
    onClose()
    navigate(`evals/runs/${evalRunId}`)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      panelClassName="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-neutral-200 bg-white shadow-xl"
      footer={
        step === 'configure' ? (
          <>
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!canConfigure}
              onClick={() => setStep('confirm')}
            >
              Review run
              <ArrowRight className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStep('configure')}
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <Button size="sm" disabled={!canRun} onClick={() => void launch()}>
              <Play className="size-4" />
              {runEval.isPending ? 'Launching…' : 'Start run'}
            </Button>
          </>
        )
      }
    >
        <div className="flex items-start justify-between border-b border-neutral-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">
              {step === 'confirm' ? 'Confirm test run' : 'Run tests'}
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              {step === 'confirm'
                ? 'Review the test matrix before launching.'
                : 'Run this '}
              {step === 'configure' ? (
                <>
                  {scope} in simulation ·{' '}
                  <span className="font-medium text-neutral-700">
                    {targetName}
                  </span>
                </>
              ) : null}
            </p>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="text-neutral-400 transition hover:text-neutral-700"
          >
            <X className="size-4" />
          </button>
        </div>

        {step === 'configure' ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {/* ── Models axis ── */}
            <div>
              <div className="mb-1.5 flex items-baseline justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Models to run against
                </h3>
                {selectedIds.length > 0 ? (
                  <span className="text-xs tabular-nums text-neutral-400">
                    {selectedIds.length} model
                    {selectedIds.length === 1 ? '' : 's'} · {totalRuns} run
                    {totalRuns === 1 ? '' : 's'} / sample
                  </span>
                ) : null}
              </div>
              <div className="overflow-hidden rounded-lg border border-neutral-200">
                {loadingModels ? (
                  <div className="px-3 py-8 text-center text-sm text-neutral-400">
                    Loading models…
                  </div>
                ) : groups.length === 0 ? (
                  <div className="px-3 py-8 text-center text-sm text-neutral-500">
                    No models available. Wire a provider into the host config.
                  </div>
                ) : (
                  groups.map(({ provider, models: groupModels }) => {
                    const isCollapsed = collapsed[provider.id] ?? false
                    const groupSelected = groupModels.filter(
                      (m) => (counts[m.id] ?? 0) > 0,
                    ).length
                    return (
                      <div
                        key={provider.id}
                        className="border-b border-neutral-100 last:border-b-0"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsed((prev) => ({
                              ...prev,
                              [provider.id]: !isCollapsed,
                            }))
                          }
                          className="flex w-full items-center gap-1.5 bg-neutral-50 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500 transition hover:text-neutral-800"
                        >
                          {isCollapsed ? (
                            <ChevronRight className="size-3.5" />
                          ) : (
                            <ChevronDown className="size-3.5" />
                          )}
                          <span className="flex-1">{provider.label}</span>
                          {groupSelected > 0 ? (
                            <span className="rounded-full bg-neutral-900 px-1.5 py-0.5 text-[10px] text-white">
                              {groupSelected}
                            </span>
                          ) : null}
                        </button>
                        {isCollapsed
                          ? null
                          : groupModels.map((m) => (
                              <ModelMatrixRow
                                key={m.id}
                                model={m}
                                count={counts[m.id] ?? 0}
                                onChange={(n) => setCount(m.id, n)}
                              />
                            ))}
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            {/* ── Prompts axis ── */}
            <div>
              <div className="mb-1.5 flex items-center gap-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Prompts to test
                </h3>
                <IdeaSpark
                  title="Matrix-test alternate system prompts"
                  hint="Idea: A/B system prompts across the model matrix"
                >
                  <p>
                    Today a goal only ever runs against the target agent&apos;s
                    saved prompt. What if a test run could sweep{' '}
                    <strong>prompt variations</strong> too — turning testing into
                    a full matrix?
                  </p>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>
                      The agent&apos;s <strong>saved prompt</strong> is always
                      the baseline in the suite.
                    </li>
                    <li>
                      Add any number of <strong>extra system prompts</strong>,
                      authored in the same tiptap editor as the agent editor —
                      with the same <code>${'{'}variable{'}'}</code> chips. Only
                      variables the target already defines are meaningful; a
                      prompt may skip or repeat one freely.
                    </li>
                    <li>
                      The suite is the <strong>cross-product</strong>:{' '}
                      <em>models × prompts</em>. 4 models × 4 prompts = 16 tests.
                      Each cell is graded against the same sample checks, so you
                      can read off which prompt wins on which model.
                    </li>
                  </ul>
                  <p>
                    Before launching, a <strong>confirmation step</strong> lays
                    out the whole matrix and an <strong>estimated cost</strong>{' '}
                    so a big sweep is a deliberate choice. (Cost is a placeholder
                    until we wire real per-model token pricing.)
                  </p>
                  <p>
                    Not built yet — this dialog collects the prompts and shows
                    the matrix, but the engine still runs the saved prompt on a
                    single model. Fan-out is the follow-up.
                  </p>
                </IdeaSpark>
              </div>

              <div className="space-y-2">
                {/* Baseline — always in the suite, not editable/removable. */}
                <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
                  <span className="rounded-full bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    Baseline
                  </span>
                  <span className="min-w-0 flex-1 truncate text-neutral-700">
                    Agent&apos;s saved prompt
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">
                    always included
                  </span>
                </div>

                {prompts.map((p, i) => (
                  <div
                    key={p.id}
                    className="space-y-1 rounded-lg border border-neutral-200 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-neutral-500">
                        Test prompt {i + 1}
                      </span>
                      <div className="flex-1" />
                      <button
                        type="button"
                        aria-label={`Remove test prompt ${i + 1}`}
                        onClick={() => removePrompt(p.id)}
                        className="text-neutral-400 transition hover:text-red-600"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                    <PromptBodyEditor
                      initialBody={p.body}
                      onChange={(body) => setPromptBody(p.id, body)}
                      placeholder="Write an alternate system prompt… use ${variable} for values."
                      className="min-h-[6rem] [&_.ProseMirror]:min-h-[5rem]"
                    />
                  </div>
                ))}

                <button
                  type="button"
                  onClick={addPrompt}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-neutral-300 px-3 py-2 text-sm text-neutral-500 transition hover:border-neutral-400 hover:text-neutral-700"
                >
                  <Plus className="size-4" />
                  Add test prompt
                </button>

                <p className="text-xs text-neutral-400">
                  {availableVariables.length > 0 ? (
                    <>
                      Variables you can use:{' '}
                      {availableVariables.map((v, i) => (
                        <span key={v}>
                          {i > 0 ? ' ' : ''}
                          <code className="rounded bg-indigo-100 px-1 py-0.5 font-medium text-indigo-700">
                            ${'{'}
                            {v}
                            {'}'}
                          </code>
                        </span>
                      ))}
                    </>
                  ) : (
                    'The target agent defines no ${variables} — prompts run as-is.'
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-lg bg-neutral-50 px-3 py-2.5 text-sm text-neutral-600">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              <p>
                Every sample runs with <strong>simulation on</strong> — write
                tools (e.g. send email) no-op and read tools return the
                sample&apos;s fixtures, so no real data is touched. The run is
                graded against each sample&apos;s tests.
              </p>
            </div>

            {setIds.length === 0 ? (
              <p className="text-xs text-amber-600">
                Nothing to run yet — add a sample first.
              </p>
            ) : null}
          </div>
        ) : (
          <ConfirmStep
            selectedModels={selectedModels}
            counts={counts}
            promptCount={prompts.length}
            totalTests={totalTests}
            matrixBlocked={matrixBlocked}
            runError={runEval.isError}
          />
        )}

    </Modal>
  )
}

// The confirmation screen: the model × prompt matrix laid out as a grid, the
// total test count, and a (blurred, not-yet-real) cost estimate. This is the
// deliberate "here's what you're about to spend" gate before launch.
function ConfirmStep({
  selectedModels,
  counts,
  promptCount,
  totalTests,
  matrixBlocked,
  runError,
}: {
  selectedModels: ModelOption[]
  counts: Record<string, number>
  promptCount: number
  totalTests: number
  matrixBlocked: boolean
  runError: boolean
}) {
  // Row per prompt variation: the baseline plus each extra prompt.
  const promptRows = [
    'Agent’s saved prompt',
    ...Array.from({ length: promptCount }, (_, i) => `Test prompt ${i + 1}`),
  ]

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Models" value={String(selectedModels.length)} />
        <Stat label="Prompts" value={String(promptRows.length)} />
      </div>

      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Test matrix
        </h3>
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-neutral-50">
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-400" />
                {selectedModels.map((m) => (
                  <th
                    key={m.id}
                    className="px-3 py-2 text-center text-xs font-medium text-neutral-600"
                  >
                    <div className="flex items-center justify-center gap-1">
                      <BrandMark
                        brand={inferModelBrand(`${m.id} ${m.label}`)}
                        fallback={m.label}
                      />
                      <span className="max-w-[6rem] truncate">{m.label}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {promptRows.map((label) => (
                <tr
                  key={label}
                  className="border-t border-neutral-100"
                >
                  <td className="px-3 py-2 text-xs text-neutral-500">{label}</td>
                  {selectedModels.map((m) => (
                    <td
                      key={m.id}
                      className="px-3 py-2 text-center tabular-nums text-neutral-800"
                    >
                      {counts[m.id] ?? 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-xs text-neutral-400">
          {selectedModels.length} model
          {selectedModels.length === 1 ? '' : 's'} × {promptRows.length} prompt
          {promptRows.length === 1 ? '' : 's'} ={' '}
          <span className="font-medium text-neutral-600">
            {totalTests} test{totalTests === 1 ? '' : 's'}
          </span>{' '}
          per sample
        </p>
      </div>

      {/* Estimated cost — no pricing data yet, so blur it out as a placeholder. */}
      <div className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Estimated cost
          </div>
          <div className="text-[11px] text-neutral-400">
            Pricing estimate coming soon.
          </div>
        </div>
        <span
          aria-hidden
          className="select-none text-xl font-semibold text-neutral-800 blur-sm"
        >
          $12.34
        </span>
      </div>

      {matrixBlocked ? (
        <p className="text-xs text-amber-600">
          Running a full matrix (multiple models, higher run counts, or extra
          prompts) isn&apos;t supported by the engine yet — select a single
          model with one run and no extra prompts to launch. Matrix runs are
          coming.
        </p>
      ) : null}
      {runError ? (
        <p className="text-xs text-red-600">
          Couldn&apos;t launch the run. Check that eval runs are configured for
          this host, then try again.
        </p>
      ) : null}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-neutral-900">
        {value}
      </div>
    </div>
  )
}

function ModelMatrixRow({
  model,
  count,
  onChange,
}: {
  model: ModelOption
  count: number
  onChange: (next: number) => void
}) {
  const brand = inferModelBrand(`${model.id} ${model.label}`)
  const selected = count > 0
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-sm transition',
        selected ? 'bg-neutral-50/80' : 'hover:bg-neutral-50',
      )}
    >
      {/* Checkbox — mirrors the count (0 = unchecked); toggles 0↔1. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Run ${model.label}`}
        onClick={() => onChange(selected ? 0 : 1)}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded border transition',
          selected
            ? 'border-neutral-900 bg-neutral-900 text-white'
            : 'border-neutral-300 hover:border-neutral-500',
        )}
      >
        {selected ? <Check className="size-3.5" /> : null}
      </button>

      {/* icon + name */}
      <BrandMark brand={brand} fallback={model.label} />
      <span className="min-w-0 flex-1 truncate font-medium text-neutral-800">
        {model.label}
      </span>

      {/* cost */}
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-neutral-400">
        {model.costPerMTok != null ? (
          <>
            ${model.costPerMTok.toFixed(2)}
            <span className="text-neutral-300">/M</span>
          </>
        ) : (
          <span className="text-neutral-300">—</span>
        )}
      </span>

      {/* speed */}
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-neutral-400">
        {model.tokensPerSec != null ? (
          <>
            {model.tokensPerSec}
            <span className="text-neutral-300"> tok/s</span>
          </>
        ) : (
          <span className="text-neutral-300">—</span>
        )}
      </span>

      {/* -/+ stepper (default 0) */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-label="One fewer run"
          disabled={count === 0}
          onClick={() => onChange(count - 1)}
          className="flex size-5 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-800 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Minus className="size-3" />
        </button>
        <span className="min-w-4 text-center text-xs font-medium tabular-nums text-neutral-800">
          {count}
        </span>
        <button
          type="button"
          aria-label="One more run"
          onClick={() => onChange(count + 1)}
          className="flex size-5 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-800"
        >
          <Plus className="size-3" />
        </button>
      </div>
    </div>
  )
}
