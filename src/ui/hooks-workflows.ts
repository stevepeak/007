import { useMutation, useQuery } from '@tanstack/react-query'

import type { WorkflowGraph } from '../engine/graph'

import { useWfClient } from './context'
import {
  keys,
  pendingAiSummaryInterval,
  useWfMutation,
} from './hooks-shared'

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
    (client, input: { workflowId: string; graph: WorkflowGraph }) => {
      return client.updateDraft(input)
    },
    (input) => [keys.workflow(input.workflowId)],
  )
}

export function useSaveVersion() {
  return useWfMutation(
    (
      client,
      input: {
        workflowId: string
        graph: WorkflowGraph
        changeNote?: string
        aiSummary?: { short: string; long: string }
        baseVersionNumber?: number
      },
    ) => client.saveVersion(input),
    (input) => [
      keys.workflow(input.workflowId),
      keys.versions(input.workflowId),
    ],
    { awaitInvalidation: false },
  )
}

export function useSummarizeChanges() {
  const client = useWfClient()
  return useMutation({
    mutationFn: (input: { workflowId: string; graph: WorkflowGraph }) => {
      return client.summarizeChanges(input)
    },
  })
}

export function useVersions(workflowId: string) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.versions(workflowId),
    queryFn: () => client.listVersions(workflowId),
    refetchInterval: (query) => pendingAiSummaryInterval(query.state.data),
  })
}

export function useUpdateWorkflow() {
  return useWfMutation(
    (
      client,
      input: {
        workflowId: string
        name?: string
        description?: string | null
        archived?: boolean
      },
    ) => client.updateWorkflow(input),
    (input) => [keys.workflow(input.workflowId), keys.workflows],
    { awaitInvalidation: false },
  )
}
