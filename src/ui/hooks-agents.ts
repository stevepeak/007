import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import type { AgentConfig } from '../engine/graph'
import type { AgentPreviewInput } from '../server/protocol'
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
