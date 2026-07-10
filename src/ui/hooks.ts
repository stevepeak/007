import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import type { AgentConfig, WorkflowGraph } from '../engine/graph'
import type {
  AgentPreviewInput,
  RetryRunMode,
  WfRunListInput,
} from '../server/protocol'
import { useWfClient } from './context'

// React Query hooks over the injected data client. Query keys are namespaced
// under 'wf' so a host's own cache never collides.

const keys = {
  models: ['wf', 'models'] as const,
  tools: ['wf', 'tools'] as const,
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
}

export function useModels() {
  const client = useWfClient()
  return useQuery({ queryKey: keys.models, queryFn: () => client.listModels() })
}

export function useTools() {
  const client = useWfClient()
  return useQuery({ queryKey: keys.tools, queryFn: () => client.listTools() })
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
  })
}

export function useRenameWorkflow() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { workflowId: string; name: string }) =>
      client.renameWorkflow(input),
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
