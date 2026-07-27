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
 * An OPTIONAL host override for the chat assistant. The SDK now ships a built-in
 * System Copilot (see `ui/copilot`) that the "Chat" dock renders by default —
 * streaming from {@link WfSdkContextValue.copilotEndpoint}, with the model, tools,
 * and prompt owned server-side by `handleCopilotRequest`. Inject this only to
 * replace that built-in entirely; most hosts leave it unset.
 */
export type WfAssistantComponent = FC<WfAssistantContext>

export type WfSdkContextValue = {
  client: WfDataClient
  components: WfComponents
  assistant?: WfAssistantComponent
  /**
   * URL the built-in System Copilot streams from (POST). The host mounts a thin
   * route there that hands the request to `handleCopilotRequest`. Defaults to
   * `/api/copilot`.
   */
  copilotEndpoint: string
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
 * The optional host assistant override, or `undefined` when the host wired none
 * (in which case the Chat dock renders the built-in System Copilot).
 */
export function useWfAssistant(): WfAssistantComponent | undefined {
  return useWfContext().assistant
}

/** The URL the built-in System Copilot streams from. */
export function useCopilotEndpoint(): string {
  return useWfContext().copilotEndpoint
}
