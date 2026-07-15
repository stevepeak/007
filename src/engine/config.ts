import type { LanguageModel } from 'ai'

import type { WfBlobRef } from './blob-ref'
import type { WfRunManifestEntry } from './graph'
import type { ToolRegistry } from './tool-registry'
import type { TriggerRegistry } from './trigger-registry'

// The host-injection contract — the single object a host app supplies to make
// the SDK do real work. The SDK is generic over an opaque per-run deps bundle
// `TDeps`; everything provider/domain-specific (the model provider, the tools)
// lives behind this interface, never inside the SDK.

/**
 * How a provider enumerates its models — drives the (host-owned) fetch. E.g.
 * `openrouter` and `venice`/`openai-compatible` expose a `/models` endpoint;
 * `custom` is a host-supplied static list.
 */
export type ModelProviderKind =
  | 'openrouter'
  | 'openai'
  | 'openai-compatible'
  | 'custom'

/**
 * A model source the host (the "client" of the SDK) has wired up. The host may
 * declare several — OpenRouter, a direct OpenAI key, Venice, a self-hosted
 * endpoint — and every {@link ModelOption} references one by `providerId`. The
 * editor groups its model pickers by these, showing ONLY the providers the host
 * returns from {@link WfSdkConfig.listProviders}.
 */
export type ModelProvider = {
  id: string
  /** Display name, e.g. "OpenRouter", "Venice AI". */
  label: string
  kind: ModelProviderKind
  /** Optional one-line note shown under the provider header. */
  note?: string
}

/**
 * A model the editor can offer and `getModel` can resolve. `providerId` ties it
 * to a {@link ModelProvider} (omit when the host declares no providers — the UI
 * then treats every model as belonging to one implicit group). `costPerMTok` /
 * `tokensPerSec` are shown when the provider reports them (e.g. OpenRouter) and
 * omitted otherwise.
 */
export type ModelOption = {
  id: string
  label: string
  providerId?: string
  /** Blended cost per 1M tokens, USD. Omit when the provider doesn't report it. */
  costPerMTok?: number
  /** Throughput, tokens/second. Omit when the provider doesn't report it. */
  tokensPerSec?: number
}

/**
 * Context handed to {@link WfSdkConfig.listModels} / {@link WfSdkConfig.listProviders}
 * so they can read live host bindings — e.g. a provider API key out of `env` — to
 * fetch a provider's `/models` endpoint. `env` is the same opaque host Env the
 * data-route handler resolves per request (see `resolveEnv`); it's undefined when
 * the host wires no `resolveEnv`, in which case the listers must degrade (e.g. to
 * a static fallback list).
 */
export type ModelListContext = { env?: unknown }

/** Payload handed to {@link WfSdkConfig.onRunComplete} when a run finalizes. */
export type RunCompletion = { output: unknown; outputNodeId: string }
/** Payload handed to {@link WfSdkConfig.onRunFailed} when a run aborts. */
export type RunFailure = { error: string }

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
 * A resolved image, ready to hand to a vision model as a message part. `url` is
 * either a `data:` URL (host base64-encoded the bytes) or an `http(s)` URL the
 * model can fetch (e.g. a signed link); `mediaType` is its MIME type.
 */
export type ResolvedImage = { url: string; mediaType: string }

/**
 * Reads a {@link WfBlobRef} that points at an IMAGE back to a model-ready
 * {@link ResolvedImage}. This is the vision counterpart to
 * {@link BlobRefResolver} (which returns text): an agent node's `imageInputs`
 * bind to image blob-refs, and the SDK calls this — inside the agent's own step
 * — to turn each into an image message part. The host owns the storage read and
 * the bytes→URL choice, keeping the engine provider-agnostic.
 */
export type ImageRefResolver<TDeps> = (
  ref: WfBlobRef,
  deps: TDeps,
) => Promise<ResolvedImage>

/**
 * Per-run context handed to `buildRunDeps`. Identity is opaque to the SDK:
 * `subjectId` ties a run to a host entity (a chat, a document, …),
 * `correlationId` is a free-form host reference. `env` carries the host's live
 * Cloudflare bindings so `buildRunDeps` can construct clients inside a `step.do`
 * boundary.
 */
export type RunContext = {
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
  /**
   * Eval signal. When true the run executes for real (real graph, real trace)
   * but side-effecting tools are neutralized: tools tagged `sideEffect: 'write'`
   * no-op, tools tagged `sideEffect: 'read'` return their `fixtures` entry (or an
   * empty object). Untagged tools run normally. Invisible to the model — it is a
   * property of the run, not a tool argument — so a prompt can't route around it.
   */
  simulate?: boolean
  /**
   * Canned tool outputs keyed by tool id, consumed only under `simulate`: a read
   * tool returns `fixtures[toolId]` instead of hitting live data, making an eval
   * run reproducible. Absent id → the tool's safe empty default (`{}`).
   */
  fixtures?: Record<string, unknown>
  /** Host Env (live bindings). Opaque to the SDK; passed back to the host. */
  env?: unknown
}

export interface WfSdkConfig<TDeps = unknown> {
  /**
   * Resolve a node `modelId` to an AI SDK model (host's provider). Receives the
   * run context so it can read live bindings (e.g. `(ctx.env as Env).API_KEY`).
   */
  getModel: (modelId: string, ctx: RunContext) => LanguageModel
  /**
   * Models offered in the editor's model dropdowns. May be async and read
   * `ctx.env` to fetch a provider's live `/models` (see {@link ModelListContext}).
   */
  listModels: (ctx: ModelListContext) => ModelOption[] | Promise<ModelOption[]>
  /**
   * The model providers the host has wired up (OpenRouter, a direct OpenAI key,
   * Venice, a custom endpoint). The editor groups models by provider and shows
   * ONLY these — each {@link ModelOption} is bucketed by its `providerId`. Return
   * a single entry for a one-provider host (`[]` only if you offer no models).
   * May be async and read `ctx.env` (e.g. to include a provider only when its
   * key is configured).
   */
  listProviders: (
    ctx: ModelListContext,
  ) => ModelProvider[] | Promise<ModelProvider[]>
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
   * Optional: resolve an agent node's `imageInputs` that are {@link WfBlobRef}
   * pointers into model-ready images (vision). Omit if no agent consumes image
   * inputs; an image-ref input with no resolver configured is a run-time error.
   */
  resolveImageRef?: ImageRefResolver<TDeps>
  /**
   * Host-declared **events** + their data schemas. These are the "on an event"
   * trigger options offered in the creation flow; the built-in manual and
   * periodic triggers need no registry entry.
   */
  triggers: TriggerRegistry
  /**
   * Optional: called once when a run reaches a terminal Output node, so the
   * host can reflect completion onto its own domain entity (the one named by
   * `ctx.subjectId`). The SDK owns `wf_run`; this is how the host learns the
   * run is done. Runs in a durable step so it retries, but it is **best-effort**
   * — a callback that ultimately throws is logged and does NOT fail the run
   * (the run already produced its output). Symmetric with {@link onRunFailed}.
   */
  onRunComplete?: (ctx: RunContext, result: RunCompletion) => void | Promise<void>
  /**
   * Optional: called once when a run aborts (a node failed, or the graph
   * stalled), so the host can mark its own entity failed with the error — the
   * seam that otherwise leaves a host row stuck "pending" forever. Same
   * best-effort, durable-step semantics as {@link onRunComplete}.
   */
  onRunFailed?: (ctx: RunContext, failure: RunFailure) => void | Promise<void>
}

/**
 * Identity helper that validates a {@link WfSdkConfig} at construction and
 * returns it unchanged (so `wfConfig` stays a plain object). Wrap your host
 * config with it to turn silent under-wiring into a loud, early failure:
 *
 * ```ts
 * export const wfConfig = defineWfConfig<HostDeps>({ getModel, ... })
 * ```
 *
 * It checks that every required injection point is present and is the right
 * broad shape — the class of mistake (a forgotten `buildRunDeps`, a
 * `toolRegistry` that isn't a Map) that otherwise surfaces as an opaque runtime
 * error deep inside a run or an empty editor dropdown.
 */
export function defineWfConfig<TDeps = unknown>(
  config: WfSdkConfig<TDeps>,
): WfSdkConfig<TDeps> {
  const fn = (k: keyof WfSdkConfig<TDeps>) => typeof config[k] === 'function'
  const problems: string[] = []
  if (!fn('getModel')) problems.push('`getModel` must be a function')
  if (!fn('listModels')) problems.push('`listModels` must be a function')
  if (!fn('listProviders')) problems.push('`listProviders` must be a function')
  if (!fn('buildRunDeps')) problems.push('`buildRunDeps` must be a function')
  if (!(config.toolRegistry instanceof Map)) {
    problems.push('`toolRegistry` must be a Map (see ToolRegistry)')
  }
  if (config.triggers == null || typeof config.triggers !== 'object') {
    problems.push('`triggers` must be an object (`{}` if you have no events)')
  }
  if (config.resolveBlobRef != null && typeof config.resolveBlobRef !== 'function') {
    problems.push('`resolveBlobRef`, if set, must be a function')
  }
  if (config.resolveImageRef != null && typeof config.resolveImageRef !== 'function') {
    problems.push('`resolveImageRef`, if set, must be a function')
  }
  if (config.onRunComplete != null && typeof config.onRunComplete !== 'function') {
    problems.push('`onRunComplete`, if set, must be a function')
  }
  if (config.onRunFailed != null && typeof config.onRunFailed !== 'function') {
    problems.push('`onRunFailed`, if set, must be a function')
  }
  if (problems.length > 0) {
    throw new Error(
      `defineWfConfig: invalid WfSdkConfig —\n  - ${problems.join('\n  - ')}`,
    )
  }
  return config
}
