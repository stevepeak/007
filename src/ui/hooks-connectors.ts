import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { ConnectorDetail, ConnectorToolInfo } from '../server/protocol-connectors'
import { useWfClient } from './context'
import { keys } from './hooks-shared'

// Query hooks for MCP connectors.
//
// Every mutation that changes which tools are callable also invalidates
// `keys.tools`: the agent editor's tool picker reads that list, and a connector
// tool someone just enabled has to appear there without a reload — otherwise
// the two surfaces disagree about what the platform can do.

export function useConnectors() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.connectors,
    queryFn: () => client.listConnectors(),
  })
}

export function useConnector(connectorId: string | undefined) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.connector(connectorId ?? ''),
    queryFn: () => client.getConnector({ connectorId: connectorId! }),
    enabled: !!connectorId,
  })
}

/**
 * Whether this deployment can store credentials at all.
 *
 * Its own query rather than a field on the list, because the answer is a
 * property of the DEPLOYMENT and never changes while the page is open — and the
 * page needs it before it can decide whether "Connect" is even a real button.
 */
export function useConnectorCapability() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.connectorCapability,
    queryFn: () => client.getConnectorCapability(),
    staleTime: Infinity,
  })
}

function useConnectorMutation<TInput, TResult>(
  run: (client: ReturnType<typeof useWfClient>, input: TInput) => Promise<TResult>,
  opts: {
    invalidatesTools?: boolean
    /**
     * Applied to every cached connector detail the moment the mutation fires,
     * so a per-tool toggle flips on click instead of after the write AND the
     * refetch that follows it. The refetch still runs and is the truth; on
     * error the cache is restored to what it held before.
     */
    optimistic?: (input: TInput, detail: ConnectorDetail) => ConnectorDetail
  } = {},
) {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: TInput) => run(client, input),
    onMutate: async (input: TInput) => {
      if (!opts.optimistic) return undefined
      await qc.cancelQueries({ queryKey: keys.connectorAll })
      const previous = qc.getQueriesData<ConnectorDetail>({
        queryKey: keys.connectorAll,
      })
      qc.setQueriesData<ConnectorDetail>(
        { queryKey: keys.connectorAll },
        (detail) => (detail ? opts.optimistic!(input, detail) : detail),
      )
      return previous
    },
    onError: (_err, _input, previous) => {
      for (const [key, data] of previous ?? []) qc.setQueryData(key, data)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.connectors })
      void qc.invalidateQueries({ queryKey: keys.connectorAll })
      if (opts.invalidatesTools) {
        void qc.invalidateQueries({ queryKey: keys.tools })
      }
    },
  })
}

export function useSaveConnector() {
  return useConnectorMutation((client, input: Parameters<typeof client.saveConnector>[0]) => { return client.saveConnector(input) },
  )
}

export function useDeleteConnector() {
  return useConnectorMutation(
    (client, input: { connectorId: string }) => client.deleteConnector(input),
    { invalidatesTools: true },
  )
}

export function useSetConnectorEnabled() {
  return useConnectorMutation(
    (client, input: { connectorId: string; enabled: boolean }) => { return client.setConnectorEnabled(input) },
    // A disabled connector withdraws every one of its tools at once.
    { invalidatesTools: true },
  )
}

export function useRefreshConnector() {
  return useConnectorMutation(
    (client, input: { connectorId: string }) => client.refreshConnector(input),
    // A refresh can withdraw a tool an agent is pointed at.
    { invalidatesTools: true },
  )
}

/** Rewrite one tool inside a cached detail; a detail without it is untouched. */
function patchTool(
  detail: ConnectorDetail,
  toolId: string,
  patch: Partial<ConnectorToolInfo>,
): ConnectorDetail {
  if (!detail.tools.some((t) => t.id === toolId)) return detail
  const tools = detail.tools.map((t) => (t.id === toolId ? { ...t, ...patch } : t))
  return {
    ...detail,
    tools,
    connector: {
      ...detail.connector,
      enabledToolCount: tools.filter((t) => t.enabled).length,
    },
  }
}

export function useSetConnectorToolEnabled() {
  return useConnectorMutation(
    (client, input: { toolId: string; enabled: boolean }) => { return client.setConnectorToolEnabled(input) },
    {
      invalidatesTools: true,
      optimistic: (input, detail) => { return patchTool(detail, input.toolId, { enabled: input.enabled }) },
    },
  )
}

export function useSetConnectorToolSideEffect() {
  return useConnectorMutation(
    (client, input: { toolId: string; sideEffect: 'read' | 'write' }) => { return client.setConnectorToolSideEffect(input) },
    {
      invalidatesTools: true,
      optimistic: (input, detail) => { return patchTool(detail, input.toolId, {
          sideEffect: input.sideEffect,
          sideEffectOverridden: true,
        }) },
    },
  )
}

export function useSaveConnectorToken() {
  return useConnectorMutation(
    (client, input: { connectorId: string; token: string }) => { return client.saveConnectorToken(input) },
  )
}

export function useDisconnectConnector() {
  return useConnectorMutation((client, input: { connectorId: string }) => { return client.disconnectConnector(input) },
  )
}

/**
 * Begin an OAuth authorization.
 *
 * Returns the URL rather than navigating, so the caller decides — and so the
 * mutation stays testable. The page then does a full-page navigation: this is a
 * round trip through somebody else's login screen, not a popup we control.
 */
export function useStartConnectorAuth() {
  const client = useWfClient()
  return useMutation({
    mutationFn: (input: { connectorId: string; returnTo?: string }) => { return client.startConnectorAuth(input) },
  })
}
