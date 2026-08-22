import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'

import type { WfDataClient } from '../server/protocol'

import { WfSdkContext, type WfAssistantComponent } from './context'
import { defaultComponents, type WfComponents } from './primitives'

export type WfSdkProviderProps = {
  /** Data client — usually `createHttpWfDataClient({ baseUrl })`. */
  client: WfDataClient
  /** Override any UI primitives with the host's design-system components. */
  components?: Partial<WfComponents>
  /**
   * OPTIONAL override for the chat assistant. The dock renders the SDK's built-in
   * System Copilot by default; inject this only to replace it entirely.
   */
  assistant?: WfAssistantComponent
  /**
   * URL the built-in System Copilot streams from (POST). The host mounts a thin
   * route there wired to `handleCopilotRequest`. Defaults to `/api/copilot`.
   */
  copilotEndpoint?: string
  /** Bring your own React Query client; one is created if omitted. */
  queryClient?: QueryClient
  children: ReactNode
}

export function WfSdkProvider({
  client,
  components,
  assistant,
  copilotEndpoint = '/api/copilot',
  queryClient,
  children,
}: WfSdkProviderProps) {
  const [qc] = useState(() => queryClient ?? new QueryClient())
  const value = useMemo(
    () => ({
      client,
      components: { ...defaultComponents, ...components },
      assistant,
      copilotEndpoint,
    }),
    [client, components, assistant, copilotEndpoint],
  )
  return (
    <QueryClientProvider client={qc}>
      <WfSdkContext.Provider value={value}>{children}</WfSdkContext.Provider>
    </QueryClientProvider>
  )
}
