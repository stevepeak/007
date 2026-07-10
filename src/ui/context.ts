import { createContext, useContext } from 'react'

import type { WfDataClient } from '../server/protocol'
import type { WfComponents } from './primitives'

export type WfSdkContextValue = {
  client: WfDataClient
  components: WfComponents
}

export const WfSdkContext = createContext<WfSdkContextValue | null>(null)

function useWfContext(): WfSdkContextValue {
  const value = useContext(WfSdkContext)
  if (!value) {
    throw new Error('wf-sdk UI components must be used within <WfSdkProvider>.')
  }
  return value
}

/** The injected data client (server RPC over HTTP). */
export function useWfClient(): WfDataClient {
  return useWfContext().client
}

/** The merged UI primitive set (host overrides + defaults). */
export function useWfComponents(): WfComponents {
  return useWfContext().components
}
