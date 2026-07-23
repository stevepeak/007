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
   * A host-supplied chat assistant. Injected here, it powers the "Chat" dock on
   * every asset surface. Omit it and the dock shows a "Coming soon" placeholder.
   * The SDK never bakes in a model/prompt/tools — those live in this component.
   */
  assistant?: WfAssistantComponent
  /** Bring your own React Query client; one is created if omitted. */
  queryClient?: QueryClient
  children: ReactNode
}

export function WfSdkProvider({
  client,
  components,
  assistant,
  queryClient,
  children,
}: WfSdkProviderProps) {
  const [qc] = useState(() => queryClient ?? new QueryClient())
  const value = useMemo(
    () => ({
      client,
      components: { ...defaultComponents, ...components },
      assistant,
    }),
    [client, components, assistant],
  )
  return (
    <QueryClientProvider client={qc}>
      <WfSdkContext.Provider value={value}>{children}</WfSdkContext.Provider>
    </QueryClientProvider>
  )
}
