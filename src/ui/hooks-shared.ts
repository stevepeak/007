import {
  type QueryKey,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'

import type {
  WfDataClient,
  WfFeedbackListInput,
  WfRunListInput,
} from '../server/protocol'
import { useWfClient } from './context'

// React Query hooks over the injected data client. Query keys are namespaced
// under 'wf' so a host's own cache never collides.

export const keys = {
  models: ['wf', 'models'] as const,
  providers: ['wf', 'providers'] as const,
  modelCatalog: ['wf', 'model-catalog'] as const,
  tools: ['wf', 'tools'] as const,
  toolContextFields: ['wf', 'tool-context-fields'] as const,
  toolInvocations: (toolId: string, limit?: number) =>
    ['wf', 'tool-invocations', toolId, limit ?? null] as const,
  // Prefix key: invalidates every limit variant of a tool's invocations.
  toolInvocationsAll: (toolId: string) =>
    ['wf', 'tool-invocations', toolId] as const,
  triggerEvents: ['wf', 'trigger-events'] as const,
  workflows: ['wf', 'workflows'] as const,
  workflow: (id: string) => ['wf', 'workflow', id] as const,
  versions: (id: string) => ['wf', 'versions', id] as const,
  runs: (input: WfRunListInput) => ['wf', 'runs', input] as const,
  // Prefix key: invalidates every filter/page variant of the runs list.
  runsAll: ['wf', 'runs'] as const,
  runTriggerKinds: ['wf', 'run-trigger-kinds'] as const,
  run: (id: string) => ['wf', 'run', id] as const,
  agents: ['wf', 'agents'] as const,
  agent: (id: string) => ['wf', 'agent', id] as const,
  agentVersions: (id: string) => ['wf', 'agent-versions', id] as const,
  agentReferences: (id: string) => ['wf', 'agent-references', id] as const,
  evalSets: (includeArchived?: boolean) =>
    ['wf', 'eval-sets', includeArchived ?? false] as const,
  // Prefix key: invalidates both archived/active variants of the eval sets list.
  evalSetsAll: ['wf', 'eval-sets'] as const,
  evalSet: (id: string) => ['wf', 'eval-set', id] as const,
  evalRuns: (limit?: number) => ['wf', 'eval-runs', limit ?? null] as const,
  // Prefix key: invalidates every limit variant of the eval runs list.
  evalRunsAll: ['wf', 'eval-runs'] as const,
  evalRun: (id: string) => ['wf', 'eval-run', id] as const,
  feedback: (input: WfFeedbackListInput) => ['wf', 'feedback', input] as const,
  // Prefix key: invalidates every filter variant of the feedback list.
  feedbackAll: ['wf', 'feedback'] as const,
  feedbackForSubjects: (subjectIds: string[]) =>
    ['wf', 'feedback-subjects', subjectIds] as const,
}

// Collapses the shared mutation ceremony: grab the injected client + query
// client, run `mutationFn`, then on success invalidate the query keys returned
// by `invalidate`. The returned promise is awaited (via onSuccess) so the
// mutation stays pending until the refetch settles — matching the hand-written
// `return qc.invalidateQueries(...)` shape it replaces. Mutations that instead
// fire-and-forget (`void qc.invalidateQueries`) or run extra side effects are
// left hand-written.
export function useWfMutation<TInput, TOut>(
  mutationFn: (client: WfDataClient, input: TInput) => Promise<TOut>,
  invalidate?: (input: TInput) => QueryKey[],
) {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: TInput) => mutationFn(client, input),
    onSuccess: (_r, input) => {
      const queryKeys = invalidate?.(input)
      if (!queryKeys) return
      return Promise.all(
        queryKeys.map((queryKey) => qc.invalidateQueries({ queryKey })),
      )
    },
  })
}
