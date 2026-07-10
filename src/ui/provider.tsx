import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'

import type { WfDataClient } from '../server/protocol'
import { WfSdkContext } from './context'
import { defaultComponents, type WfComponents } from './primitives'

export type WfSdkProviderProps = {
  /** Data client — usually `createHttpWfDataClient({ baseUrl })`. */
  client: WfDataClient
  /** Override any UI primitives with the host's design-system components. */
  components?: Partial<WfComponents>
  /** Bring your own React Query client; one is created if omitted. */
  queryClient?: QueryClient
  children: ReactNode
}

export function WfSdkProvider({
  client,
  components,
  queryClient,
  children,
}: WfSdkProviderProps) {
  const [qc] = useState(() => queryClient ?? new QueryClient())
  const value = useMemo(
    () => ({ client, components: { ...defaultComponents, ...components } }),
    [client, components],
  )
  return (
    <QueryClientProvider client={qc}>
      <WfSdkContext.Provider value={value}>{children}</WfSdkContext.Provider>
    </QueryClientProvider>
  )
}
