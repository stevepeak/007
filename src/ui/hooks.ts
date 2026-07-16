import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import type { AgentConfig, WorkflowGraph } from '../engine/graph'
import type {
  AgentPreviewInput,
  CheckTree,
  EvalFixtures,
  EvalInitialCondition,
  RetryRunMode,
  WfDataClient,
  WfEvalTargetKind,
  WfRunListInput,
} from '../server/protocol'
import { useWfClient } from './context'

// React Query hooks over the injected data client. Query keys are namespaced
// under 'wf' so a host's own cache never collides.

const keys = {
  models: ['wf', 'models'] as const,
  providers: ['wf', 'providers'] as const,
  tools: ['wf', 'tools'] as const,
  toolContextFields: ['wf', 'tool-context-fields'] as const,
  toolInvocations: (toolId: string, limit?: number) =>
    ['wf', 'tool-invocations', toolId, limit ?? null] as const,
  triggerEvents: ['wf', 'trigger-events'] as const,
  workflows: ['wf', 'workflows'] as const,
  workflow: (id: string) => ['wf', 'workflow', id] as const,
  versions: (id: string) => ['wf', 'versions', id] as const,
  runs: (input: WfRunListInput) => ['wf', 'runs', input] as const,
  runTriggerKinds: ['wf', 'run-trigger-kinds'] as const,
  run: (id: string) => ['wf', 'run', id] as const,
  agents: ['wf', 'agents'] as const,
  agent: (id: string) => ['wf', 'agent', id] as const,
  agentVersions: (id: string) => ['wf', 'agent-versions', id] as const,
  evalSets: (includeArchived?: boolean) =>
    ['wf', 'eval-sets', includeArchived ?? false] as const,
  evalSet: (id: string) => ['wf', 'eval-set', id] as const,
  evalRuns: (limit?: number) => ['wf', 'eval-runs', limit ?? null] as const,
  evalRun: (id: string) => ['wf', 'eval-run', id] as const,
}

export function useModels() {
  const client = useWfClient()
  return useQuery({ queryKey: keys.models, queryFn: () => client.listModels() })
}

export function useProviders() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.providers,
    queryFn: () => client.listProviders(),
  })
}

export function useTools() {
  const client = useWfClient()
  return useQuery({ queryKey: keys.tools, queryFn: () => client.listTools() })
}

export function useToolContextFields() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.toolContextFields,
    queryFn: () => client.listToolContextFields(),
  })
}

export function useToolInvocations(toolId: string, limit?: number) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.toolInvocations(toolId, limit),
    queryFn: () => client.listToolInvocations({ toolId, limit }),
    enabled: !!toolId,
  })
}

// Playground — run one tool FOR REAL against scratch args. Not cached (each run
// is a one-off, deliberate action); the detail page reads `data`/`isPending`
// straight off the mutation. On success the tool's invocation list is
// invalidated so the fresh call shows up in "recent calls".
export function useRunToolPreview(toolId: string) {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      toolId: string
      args: Record<string, unknown>
      context?: Record<string, string>
    }) => client.runToolPreview(input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['wf', 'tool-invocations', toolId] }),
  })
}

export function useTriggerEvents() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.triggerEvents,
    queryFn: () => client.listTriggerEvents(),
  })
}

export function useWorkflows() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.workflows,
    queryFn: () => client.listWorkflows(),
  })
}

export function useWorkflow(workflowId: string) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.workflow(workflowId),
    queryFn: () => client.getWorkflow(workflowId),
  })
}

export function useRuns(input: WfRunListInput = {}) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.runs(input),
    queryFn: () => client.listRuns(input),
    // Keep the prior page visible while the next page/filter loads — avoids the
    // table flashing empty on every keystroke or page change.
    placeholderData: keepPreviousData,
  })
}

export function useRunTriggerKinds() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.runTriggerKinds,
    queryFn: () => client.listRunTriggerKinds(),
  })
}

export function useRun(runId: string | null) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.run(runId ?? ''),
    queryFn: () => client.getRun(runId as string),
    enabled: !!runId,
  })
}

// Re-dispatch a finished run. On success the runs list + this run are
// invalidated (its status may flip) and the new run id is returned so the
// caller can navigate to it.
export function useRetryRun() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { runId: string; mode: RetryRunMode }) =>
      client.retryRun(input),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: keys.run(input.runId) })
      void qc.invalidateQueries({ queryKey: ['wf', 'runs'] })
    },
  })
}

export function useCreateWorkflow() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      name: string
      description?: string
      graph: WorkflowGraph
    }) => client.createWorkflow(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workflows }),
  })
}

export function useSaveDraft() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { workflowId: string; graph: WorkflowGraph }) =>
      client.updateDraft(input),
    onSuccess: (_r, input) =>
      qc.invalidateQueries({ queryKey: keys.workflow(input.workflowId) }),
  })
}

export function useSaveVersion() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      workflowId: string
      graph: WorkflowGraph
      changeNote?: string
      aiSummary?: { short: string; long: string }
    }) => client.saveVersion(input),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: keys.workflow(input.workflowId) })
      void qc.invalidateQueries({ queryKey: keys.versions(input.workflowId) })
    },
  })
}

export function useSummarizeChanges() {
  const client = useWfClient()
  return useMutation({
    mutationFn: (input: { workflowId: string; graph: WorkflowGraph }) =>
      client.summarizeChanges(input),
  })
}

export function useVersions(workflowId: string) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.versions(workflowId),
    queryFn: () => client.listVersions(workflowId),
    // A version published before its AI summary was ready gets one generated in
    // the background — poll briefly so it shows up without a manual refresh.
    // Bounded to recently-published versions so we never poll forever over old
    // rows that will never get one (pre-feature versions, or a failed gen).
    refetchInterval: (query) => {
      const rows = query.state.data
      if (!rows) return false
      const pending = rows.some(
        (v) =>
          !v.aiSummaryShort &&
          v.publishedAt != null &&
          Date.now() - v.publishedAt < 90_000,
      )
      return pending ? 3000 : false
    },
  })
}

export function useUpdateWorkflow() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      workflowId: string
      name?: string
      description?: string | null
      archived?: boolean
    }) => client.updateWorkflow(input),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: keys.workflow(input.workflowId) })
      void qc.invalidateQueries({ queryKey: keys.workflows })
    },
  })
}

// --- Agents ----------------------------------------------------------------

export function useAgents() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.agents,
    queryFn: () => client.listAgents(),
  })
}

export function useAgent(agentId: string) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.agent(agentId),
    queryFn: () => client.getAgent(agentId),
  })
}

export function useAgentVersions(agentId: string) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.agentVersions(agentId),
    queryFn: () => client.listAgentVersions(agentId),
  })
}

export function useCreateAgent() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      name: string
      description?: string
      icon?: string
      color?: string
      config: AgentConfig
    }) => client.createAgent(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.agents }),
  })
}

export function useSaveAgentDraft() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { agentId: string; config: AgentConfig }) =>
      client.updateAgentDraft(input),
    onSuccess: (_r, input) =>
      qc.invalidateQueries({ queryKey: keys.agent(input.agentId) }),
  })
}

export function usePublishAgent() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      agentId: string
      config: AgentConfig
      changeNote?: string
    }) => client.publishAgent(input),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: keys.agent(input.agentId) })
      void qc.invalidateQueries({ queryKey: keys.agentVersions(input.agentId) })
    },
  })
}

export function useUpdateAgentMeta() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      agentId: string
      name?: string
      description?: string
      icon?: string
      color?: string
    }) => client.updateAgentMeta(input),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: keys.agent(input.agentId) })
      void qc.invalidateQueries({ queryKey: keys.agents })
    },
  })
}

// Playground — run the editor's live agent draft in isolation against a scratch
// input. Not cached (each run is a one-off); the editor reads `data`/`isPending`
// straight off the mutation.
export function useRunAgentPreview() {
  const client = useWfClient()
  return useMutation({
    mutationFn: (input: AgentPreviewInput) => client.runAgentPreview(input),
  })
}

// --- Evals -----------------------------------------------------------------

export function useEvalSets(includeArchived?: boolean) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.evalSets(includeArchived),
    queryFn: () => client.listEvalSets({ includeArchived }),
  })
}

export function useEvalSet(setId: string | null) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.evalSet(setId ?? ''),
    queryFn: () => client.getEvalSet(setId as string),
    enabled: !!setId,
  })
}

export function useEvalRuns(limit?: number) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.evalRuns(limit),
    queryFn: () => client.listEvalRuns({ limit }),
  })
}

// Poll while the run is still executing so the report fills in live, then stop.
export function useEvalRun(evalRunId: string | null) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.evalRun(evalRunId ?? ''),
    queryFn: () => client.getEvalRun(evalRunId as string),
    enabled: !!evalRunId,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status
      return status === 'queued' || status === 'running' ? 2000 : false
    },
  })
}

export function useCreateEvalSet() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      name: string
      description?: string
      targetKind: WfEvalTargetKind
      targetId: string
      targetVersion?: number | null
      triggerKind: string
    }) => client.createEvalSet(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wf', 'eval-sets'] }),
  })
}

export function useUpdateEvalSet() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      setId: string
      name?: string
      description?: string | null
      targetKind?: WfEvalTargetKind
      targetId?: string
      targetVersion?: number | null
      triggerKind?: string
      archived?: boolean
    }) => client.updateEvalSet(input),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: ['wf', 'eval-sets'] })
      void qc.invalidateQueries({ queryKey: keys.evalSet(input.setId) })
    },
  })
}

export function useDeleteEvalSet() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (setId: string) => client.deleteEvalSet(setId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wf', 'eval-sets'] }),
  })
}

export function useUpsertEvalRow() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      id?: string
      setId: string
      name: string
      description?: string | null
      initialCondition?: EvalInitialCondition
      fixtures?: EvalFixtures
      checks?: CheckTree
      sortOrder?: number
    }) => client.upsertEvalRow(input),
    onSuccess: (_r, input) =>
      qc.invalidateQueries({ queryKey: keys.evalSet(input.setId) }),
  })
}

export function useDeleteEvalRow(setId: string) {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (rowId: string) => client.deleteEvalRow(rowId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.evalSet(setId) }),
  })
}

// Client-driven eval orchestration (Phase 5 v1): create the run, then for each
// sample start a real (simulated) run, wait for it to finish, and grade it —
// concurrency-capped. A later durable orchestrator can replace this without
// touching the protocol. Errors on one sample don't abort the batch; the run is
// finalized over whatever results landed.
const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function waitForRun(
  client: WfDataClient,
  wfRunId: string,
  opts: { pollIntervalMs: number; timeoutMs: number },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    const detail = await client.getRun(wfRunId)
    if (detail && RUN_TERMINAL.has(detail.run.status)) return
    if (Date.now() > deadline) {
      throw new Error(`Eval run ${wfRunId} did not finish within the timeout.`)
    }
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs))
  }
}

async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      for (;;) {
        const i = cursor++
        if (i >= items.length) return
        await worker(items[i] as T)
      }
    },
  )
  await Promise.all(runners)
}

export type RunEvalInput = {
  setIds: string[]
  concurrency?: number
  pollIntervalMs?: number
  timeoutMs?: number
  onProgress?: (p: { done: number; total: number }) => void
}

export async function runEval(
  client: WfDataClient,
  input: RunEvalInput,
): Promise<{ evalRunId: string }> {
  const sets = await Promise.all(
    input.setIds.map((id) => client.getEvalSet(id)),
  )
  const jobs = sets
    .filter((s): s is NonNullable<typeof s> => !!s)
    .flatMap((s) => s.rows.map((row) => ({ rowId: row.id })))

  const { evalRunId } = await client.createEvalRun({
    setIds: input.setIds,
    total: jobs.length,
  })

  const wait = {
    pollIntervalMs: input.pollIntervalMs ?? 1500,
    timeoutMs: input.timeoutMs ?? 120000,
  }
  let done = 0
  await pool(jobs, input.concurrency ?? 4, async (job) => {
    try {
      const { wfRunId } = await client.startEvalRun({
        evalRunId,
        rowId: job.rowId,
      })
      await waitForRun(client, wfRunId, wait)
      await client.gradeEvalResult({ evalRunId, rowId: job.rowId, wfRunId })
    } catch (err) {
      // Keep the batch going — a single sample's failure is captured by the
      // absence of its result and the run still finalizes.
      console.error(`[wf] eval sample ${job.rowId} failed:`, err)
    } finally {
      done += 1
      input.onProgress?.({ done, total: jobs.length })
    }
  })

  await client.finalizeEvalRun({ evalRunId })
  return { evalRunId }
}

// Kicks off a full client-driven eval run. On success the eval-runs list is
// invalidated and the new `evalRunId` is returned so the caller can navigate to
// the report.
export function useRunEval() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: RunEvalInput) => runEval(client, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wf', 'eval-runs'] }),
  })
}
