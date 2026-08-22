import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { agentInputVariables, type AgentConfig } from '../../engine'
import { groupModelsByProvider } from '../editor/model-grouping'
import {
  DEFAULT_EVAL_CONCURRENCY,
  useAgents,
  useEvalSets,
  useModels,
  useProviders,
  useRunEval,
} from '../hooks'

// The MATRIX behind `RunConfigDialog` — everything the dialog knows that isn't
// markup. Extracted so the dialog file is layout and this file is the rules,
// because the two answer different questions: "what does the run sweep over?"
// is decided here and is testable without a DOM; "what does that look like?"
// is decided there.
//
// A test suite is a matrix of two axes:
//   • which MODELS to run against — a provider-bucketed picker with a run-count
//     per model (the count is best-of-N per sample).
//   • which PROMPTS to run — the target agent's saved prompt is always included;
//     you can add extra system prompts to A/B against it. Prompts reuse the
//     agent-editor tiptap editor and its `${variable}` chips; only variables the
//     target already defines are meaningful (missing / repeated is fine).
// The suite size is `models × prompts` — 4 models × 4 prompts = 16 tests.
//
// The engine fans a run out across that matrix: `runEval` expands each sample
// into one run per (model × prompt × best-of-N attempt), and `startEvalRun`
// swaps the wrapper agent's model / system prompt per run via the run context's
// `agentOverride`. Each graded result is stamped with its cell so the report can
// group by model × prompt and surface the per-column winners.

/**
 * One extra system prompt authored for the test matrix. `id` is a client-only
 * key; `body` is the raw prompt text (with `${variable}` tokens).
 */
export type TestPrompt = { id: string; body: string }

export type RunConfigMatrixOptions = {
  /** Whether the dialog is showing — the matrix resets on each open. */
  open: boolean
  /** The eval set(s) to run. Empty = nothing to launch. */
  setIds: string[]
  /** An unsaved agent config under test, if the caller is the agent editor. */
  draftConfig?: AgentConfig
  /** Called once the umbrella run row exists, before the fan-out finishes. */
  onLaunched: (evalRunId: string) => void
  /** Called alongside `onLaunched`, to dismiss the dialog. */
  onClose: () => void
}

export function useRunConfigMatrix({
  open,
  setIds,
  draftConfig,
  onLaunched,
  onClose,
}: RunConfigMatrixOptions) {
  const runEval = useRunEval()

  const modelsQuery = useModels()
  const providersQuery = useProviders()
  // As in `model-select`: two queries folded into one flag for a picker, not a
  // region of the dialog that a QueryState could own.
  const loadingModels = modelsQuery.isLoading || providersQuery.isLoading

  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data])
  const groups = useMemo(
    () => groupModelsByProvider(models, providersQuery.data ?? []),
    [models, providersQuery.data],
  )

  // The `${variables}` the targeted goals' agents already define — the only
  // tokens that mean anything in a test prompt. Resolved from the eval sets in
  // scope → their target agents → each agent's inferred input variables. A draft
  // run reads them off the draft instead: the whole point is that it hasn't been
  // saved, so a variable the author just typed wouldn't be in the stored agent.
  const evalSetsQuery = useEvalSets()
  const agentsQuery = useAgents()
  const availableVariables = useMemo(() => {
    if (draftConfig) return agentInputVariables(draftConfig)
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
  }, [draftConfig, evalSetsQuery.data, agentsQuery.data, setIds])

  const draftModelId = draftConfig?.modelId

  // modelId → run count (0 = unselected). One shared map across all groups.
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Extra prompts to A/B against the agent's saved prompt (always included).
  const [prompts, setPrompts] = useState<TestPrompt[]>([])
  const promptSeqRef = useRef(0)
  // Two-step flow: pick the matrix, then confirm it.
  const [step, setStep] = useState<'configure' | 'confirm'>('configure')
  // How many tests run at once. Chosen on the confirm step, since it's a
  // cost/provider-pressure decision rather than part of the matrix itself.
  const [concurrency, setConcurrency] = useState<number>(DEFAULT_EVAL_CONCURRENCY)

  // Reset the selection each time the dialog opens so a stale pick from a prior
  // target doesn't leak in. A draft run opens with the draft's OWN model already
  // picked: "does my edit still pass?" is the question being asked, and it is
  // answered on the model the author is editing against — anything else makes
  // them re-select the status quo before they can ask it.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the form each time the dialog opens
      setCounts(draftModelId ? { [draftModelId]: 1 } : {})
      setCollapsed({})
      setPrompts([])
      setStep('configure')
      setConcurrency(DEFAULT_EVAL_CONCURRENCY)
    }
    // Keyed on the model id rather than the config object: the editor replaces
    // `config` wholesale on every keystroke, and depending on it would reset the
    // matrix mid-dialog every time something changed behind the modal.
  }, [open, draftModelId])

  const setCount = useCallback((modelId: string, next: number) => {
    setCounts((prev) => {
      const value = Math.max(0, next)
      if (value === 0) {
        const { [modelId]: _drop, ...rest } = prev
        return rest
      }
      return { ...prev, [modelId]: value }
    })
  }, [])

  const toggleProvider = useCallback((providerId: string) => {
    setCollapsed((prev) => ({ ...prev, [providerId]: !(prev[providerId] ?? false) }))
  }, [])

  const addPrompt = useCallback(() => {
    setPrompts((prev) => [...prev, { id: `p${promptSeqRef.current++}`, body: '' }])
  }, [])
  const removePrompt = useCallback((id: string) => {
    setPrompts((prev) => prev.filter((p) => p.id !== id))
  }, [])
  const setPromptBody = useCallback((id: string, body: string) => {
    setPrompts((prev) => prev.map((p) => (p.id === id ? { ...p, body } : p)))
  }, [])

  const selectedIds = Object.keys(counts).filter((id) => (counts[id] ?? 0) > 0)
  const selectedModels = models.filter((m) => selectedIds.includes(m.id))
  const totalRuns = selectedIds.reduce((sum, id) => sum + (counts[id] ?? 0), 0)
  // The saved prompt is always one variation; each extra prompt adds another.
  const totalTests = totalRuns * (1 + prompts.length)

  // What the always-present first prompt column IS. A draft run's baseline is
  // the unsaved prompt in the editor, and calling that "the agent's saved
  // prompt" in the report would be a lie about the only thing under test.
  const baselineLabel = draftConfig
    ? 'Unsaved draft prompt'
    : 'Agent’s saved prompt'

  const canConfigure = setIds.length > 0 && selectedIds.length > 0
  const canRun = canConfigure && !runEval.isPending

  const launch = useCallback(() => {
    if (!canRun) return
    // Build the model × prompt sweep. Baseline is always the first prompt column
    // and carries no `body`, so the engine falls through to whichever config is
    // in play — the agent's saved prompt normally, the DRAFT's prompt when one
    // was handed in. Each extra prompt overrides that. The label says which,
    // because the report shows it long after the draft is gone.
    const matrix = {
      models: selectedIds.map((id) => ({
        modelId: id,
        attempts: counts[id] ?? 1,
      })),
      prompts: [
        { label: baselineLabel },
        ...prompts.map((p, i) => ({ label: `Test prompt ${i + 1}`, body: p.body })),
      ],
    }
    // Don't await the whole matrix — as soon as the run row exists (`onStart`),
    // close and hand the caller the run id. The fan-out keeps running in the
    // background mutation and whatever is watching the run polls it.
    runEval.mutate({
      setIds,
      matrix,
      concurrency,
      configOverride: draftConfig,
      onStart: (evalRunId) => {
        onClose()
        onLaunched(evalRunId)
      },
    })
  }, [
    canRun,
    selectedIds,
    counts,
    baselineLabel,
    prompts,
    runEval,
    setIds,
    concurrency,
    draftConfig,
    onClose,
    onLaunched,
  ])

  return {
    // model axis
    loadingModels,
    groups,
    counts,
    collapsed,
    setCount,
    toggleProvider,
    selectedIds,
    selectedModels,
    totalRuns,
    // prompt axis
    prompts,
    addPrompt,
    removePrompt,
    setPromptBody,
    availableVariables,
    baselineLabel,
    // flow
    step,
    setStep,
    concurrency,
    setConcurrency,
    totalTests,
    canConfigure,
    canRun,
    launching: runEval.isPending,
    runError: runEval.isError,
    launch,
  }
}
