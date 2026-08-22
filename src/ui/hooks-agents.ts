import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import type { AgentConfig } from '../engine/graph'
import type { AgentPreviewInput, WfChangeSummary } from '../server/protocol'

import { useWfClient } from './context'
import { keys, useWfMutation } from './hooks-shared'

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

export function useSummarizeAgentChanges() {
  const client = useWfClient()
  return useMutation({
    mutationFn: (input: { agentId: string; config: AgentConfig }) =>
      client.summarizeAgentChanges(input),
  })
}

export function useCreateAgent() {
  return useWfMutation(
    (
      client,
      input: {
        name: string
        description?: string
        icon?: string
        color?: string
        config: AgentConfig
      },
    ) => client.createAgent(input),
    () => [keys.agents],
  )
}

export function useSaveAgentDraft() {
  return useWfMutation(
    (client, input: { agentId: string; config: AgentConfig }) =>
      client.updateAgentDraft(input),
    (input) => [keys.agent(input.agentId)],
  )
}

export function usePublishAgent() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      agentId: string
      config: AgentConfig
      changeNote?: string
      aiSummary?: WfChangeSummary
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

// The workflows that reference this agent (draft or latest published version) —
// drives the archive dialog's block/list. `enabled` gates it to the open dialog.
export function useAgentReferences(agentId: string, enabled: boolean) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.agentReferences(agentId),
    queryFn: () => client.listAgentReferences(agentId),
    enabled,
  })
}

// This agent's recent executions across all runs (real ones — eval runs are
// excluded server-side), each reduced to its metrics: turns, tokens, cost, and
// per-tool call counts. Backs the editor's "Recent calls" section.
export function useAgentCalls(agentId: string, opts?: { limit?: number }) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.agentCalls(agentId, opts?.limit),
    queryFn: () => client.listAgentCalls({ agentId, limit: opts?.limit }),
    enabled: !!agentId,
  })
}

export function useArchiveAgent() {
  return useWfMutation(
    (client, agentId: string) => client.archiveAgent(agentId),
    () => [keys.agents],
  )
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
