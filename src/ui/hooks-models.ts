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
