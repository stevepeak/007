import { createContext, useContext, type FC } from 'react'

import type { WfDataClient } from '../server/protocol'
import type { WfComponents } from './primitives'

// The context passed to the host-injected assistant slot: what the user is
// currently looking at. `subject` is the surface kind (workflow/agent/tool/
// run/eval/feedback — kept as a plain string here so this module doesn't
// depend on the dock, avoiding an import cycle); `subjectId`/`runId` scope it
// to the concrete asset so the assistant can ground its answers.
export type WfAssistantContext = {
  subject: string
  subjectId?: string
  runId?: string
}

/**
 * A host-supplied chat assistant. When injected via `WfSdkProvider`, the "Chat"
 * dock renders this instead of the built-in "Coming soon" placeholder. The SDK
 * stays generic — it owns no model, prompt, or tools; the host wires those into
 * this component (see the app's `WfAssistantChat` shell + `/api/copilot`).
 */
export type WfAssistantComponent = FC<WfAssistantContext>

export type WfSdkContextValue = {
  client: WfDataClient
  components: WfComponents
  assistant?: WfAssistantComponent
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

/**
 * The host-injected assistant slot, or `undefined` when the host wired none (in
 * which case the Chat dock shows a "Coming soon" placeholder).
 */
export function useWfAssistant(): WfAssistantComponent | undefined {
  return useWfContext().assistant
}
