import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { useWfClient } from './context'
import { keys } from './hooks-shared'

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

// The full catalog (every model + provider status) for the Models admin page.
export function useModelCatalog() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.modelCatalog,
    queryFn: () => client.getModelCatalog(),
  })
}

// Each provider's live spend budget. Its OWN query, never folded into
// `useModelCatalog` — that's what keeps the money async: the Models page and the
// dashboard render immediately off their existing queries and each card fills
// its balance in when this one settles.
export function useProviderBudgets() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.providerBudgets,
    queryFn: () => client.getProviderBudgets(),
    // A balance that's a minute old is fresh enough, and this hook mounts on
    // two surfaces — don't re-hit the provider on every navigation between them.
    staleTime: 60_000,
    // A failing provider comes back as a per-entry `status: 'error'`, not a
    // rejected query; a rejection here means the route itself is down, and
    // retrying that just delays the (already handled) empty state.
    retry: false,
  })
}

// Pull a provider's catalog from its `/models` endpoint. Invalidates the catalog
// (admin page), the enabled-models list and the providers list (pickers + refresh
// times) so every model surface reflects the refresh.
export function useRefreshModels() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { providerId: string }) => client.refreshModels(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.modelCatalog })
      void qc.invalidateQueries({ queryKey: keys.models })
      void qc.invalidateQueries({ queryKey: keys.providers })
    },
  })
}

// Enable/disable a single model for the platform's pickers.
export function useSetModelEnabled() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { modelId: string; enabled: boolean }) =>
      client.setModelEnabled(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.modelCatalog })
      void qc.invalidateQueries({ queryKey: keys.models })
    },
  })
}
