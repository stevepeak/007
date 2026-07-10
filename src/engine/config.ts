import type { LanguageModel } from 'ai'

import type { WfBlobRef } from './blob-ref'
import type { WfRunManifestEntry } from './graph'
import type { ToolRegistry } from './tool-registry'
import type { TriggerRegistry } from './trigger-registry'

// The host-injection contract — the single object a host app supplies to make
// the SDK do real work. The SDK is generic over an opaque per-run deps bundle
// `TDeps`; everything provider/domain-specific (the model provider, the tools,
// the tenant scope) lives behind this interface, never inside the SDK.

/** A model the editor can offer and `getModel` can resolve. */
export type ModelOption = { id: string; label: string }

/**
 * Node-facing model factory — resolves a `modelId` to an AI SDK model. The
 * backend binds the run context in (so the host's `getModel` can read live
 * bindings like an API key), leaving nodes a simple `(modelId) => model` call.
 */
export type ModelFactory = (modelId: string) => LanguageModel

/**
 * Reads a {@link WfBlobRef} back to its real (text) value, using the run's deps
 * (e.g. an R2 binding). Called by agent/tool nodes when a resolved input is a
 * blob pointer — the read happens *inside* the consuming node's step, so the
 * large payload never crosses a step boundary. See `createR2BlobResolver` in
 * `../cloudflare` for the Cloudflare implementation.
 */
export type BlobRefResolver<TDeps> = (
  ref: WfBlobRef,
  deps: TDeps,
) => Promise<string>

/**
 * Per-run context handed to `buildRunDeps`. Identity is opaque to the SDK:
 * `tenantId` scopes ownership, `subjectId` ties a run to a host entity (a chat,
 * a document, …), `correlationId` is a free-form host reference. `env` carries
 * the host's live Cloudflare bindings so `buildRunDeps` can construct clients
 * inside a `step.do` boundary.
 */
export type RunContext = {
  tenantId: string
  subjectId?: string
  correlationId?: string
  triggerKind: string
  /** Variables exposed to Agent system-prompt `${name}` interpolation. */
  promptVariables?: Record<string, string | undefined>
  /**
   * Floating references (prompts, later agents) resolved to their published
   * version once at run start and frozen for the whole run. Agent nodes with a
   * `promptId` read their template from here. Persisted to `wf_run.manifest`.
   */
  manifest?: WfRunManifestEntry[]
  /** Host Env (live bindings). Opaque to the SDK; passed back to the host. */
  env?: unknown
}

export interface WfSdkConfig<TDeps = unknown> {
  /**
   * Resolve a node `modelId` to an AI SDK model (host's provider). Receives the
   * run context so it can read live bindings (e.g. `(ctx.env as Env).API_KEY`).
   */
  getModel: (modelId: string, ctx: RunContext) => LanguageModel
  /** Models offered in the editor's model dropdowns. */
  listModels: () => ModelOption[]
  /** Host tool registry, generic over the host's per-run deps. */
  toolRegistry: ToolRegistry<TDeps>
  /** Build the opaque per-run deps from a run context (live bindings inside). */
  buildRunDeps: (ctx: RunContext) => TDeps | Promise<TDeps>
  /**
   * Optional: rehydrate {@link WfBlobRef} pointers a node returned in place of a
   * large value. When set, agent/tool nodes replace any blob-ref input with its
   * resolved text before use. Omit if no tool spills values to storage.
   */
  resolveBlobRef?: BlobRefResolver<TDeps>
  /**
   * Host-declared **events** + their data schemas. These are the "on an event"
   * trigger options offered in the creation flow; the built-in manual and
   * periodic triggers need no registry entry.
   */
  triggers: TriggerRegistry
}
