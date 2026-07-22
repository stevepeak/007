import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import type { WorkflowGraph } from '../engine/graph'
import { useWfClient } from './context'
import { keys, useWfMutation } from './hooks-shared'

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

export function useCreateWorkflow() {
  return useWfMutation(
    (
      client,
      input: {
        name: string
        description?: string
        graph: WorkflowGraph
      },
    ) => client.createWorkflow(input),
    () => [keys.workflows],
  )
}

export function useSaveDraft() {
  return useWfMutation(
    (client, input: { workflowId: string; graph: WorkflowGraph }) =>
      client.updateDraft(input),
    (input) => [keys.workflow(input.workflowId)],
  )
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
