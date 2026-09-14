import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

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
  opts: { invalidatesTools?: boolean } = {},
) {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: TInput) => run(client, input),
    onSuccess: () => {
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

export function useSetConnectorToolEnabled() {
  return useConnectorMutation(
    (client, input: { toolId: string; enabled: boolean }) => { return client.setConnectorToolEnabled(input) },
    { invalidatesTools: true },
  )
}

export function useSetConnectorToolSideEffect() {
  return useConnectorMutation(
    (client, input: { toolId: string; sideEffect: 'read' | 'write' }) => { return client.setConnectorToolSideEffect(input) },
    { invalidatesTools: true },
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
