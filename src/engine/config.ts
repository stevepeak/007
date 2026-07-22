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
/**
 * What a model can do, as reported by the provider catalog. Drives the Models
 * page badges and lets the agent editor gate a model against the agent's needs
 * (tools attached → needs `tools`; object output → needs `structuredOutput`).
 * All optional: absent means the provider didn't report it (treated as "no").
 */
export type ModelCapabilities = {
  /** Function/tool calling (OpenRouter `supported_parameters` includes `tools`). */
  tools?: boolean
  /** Reasoning/thinking (`reasoning` / `reasoning_effort`). */
  reasoning?: boolean
  /** JSON-schema structured output (`structured_outputs`). */
  structuredOutput?: boolean
  /** Image/file/other non-text input (`architecture.input_modalities`). */
  vision?: boolean
}

export type ModelOption = {
  id: string
  label: string
  providerId?: string
  /** Blended cost per 1M tokens, USD. Omit when the provider doesn't report it. */
  costPerMTok?: number
  /** Throughput, tokens/second. Omit when the provider doesn't report it. */
  tokensPerSec?: number
  /** Capabilities the model supports; omit when the provider reports none. */
  capabilities?: ModelCapabilities
}

/**
 * A full catalog entry for the Models admin page — a {@link ModelOption} plus the
 * richer metadata a provider's `/models` endpoint reports and the platform's
 * `enabled` opt-in. The host's {@link WfSdkConfig.fetchModelCatalog} returns these
 * without `enabled` (the SDK owns that flag); the admin page reads them with it.
 * `id` is the COMPOSITE `providerId:modelId` so it routes unambiguously through
 * {@link WfSdkConfig.getModel}; `modelId` keeps the provider-native id.
 */
export type ModelCatalogEntry = ModelOption & {
  /** Provider-native id (e.g. `anthropic/claude-sonnet-4.6`) — what `getModel` resolves. */
  modelId: string
  /** Grouping key: vendor prefix (OpenRouter) or the provider label. */
  vendor?: string
  /** Whether the platform has enabled this model for use. */
  enabled: boolean
  /** Prompt-side price, USD per 1M tokens. */
  promptPricePerMTok?: number
  /** Completion-side price, USD per 1M tokens. */
  completionPricePerMTok?: number
  /** Max context window, tokens. */
  contextLength?: number
  /** Model release date, epoch ms (OpenRouter `created`). Omit if unreported. */
  releasedAt?: number
  /** Untouched provider catalog entry, kept for future fields. */
  raw?: unknown
}

/**
 * A provider row as shown on the Models admin page — {@link ModelProvider} plus
 * the platform's `enabled` flag, when it was last refreshed (epoch ms, null if
 * never), and how many models are cached / enabled under it.
 */
export type ModelProviderStatus = ModelProvider & {
  enabled: boolean
  lastRefreshedAt: number | null
  modelCount: number
  enabledCount: number
}

/** A minimal agent reference for the "used by" avatars on the Models page. */
export type AgentUsageRef = {
  id: string
  name: string
  icon: string | null
  color: string | null
}

/** Everything the Models admin page needs in one payload. */
export type ModelCatalog = {
  providers: ModelProviderStatus[]
  models: ModelCatalogEntry[]
  /**
   * Which agents currently reference each model, keyed by catalog model id.
   * Drives the "used by" avatars and locks a model's toggle on while any agent
   * uses it (so it can't be disabled out from under a live agent).
   */
  usage: Record<string, AgentUsageRef[]>
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
export type RunCompletion = { output: unknown; outputNodeId: string | null }
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
  /**
   * Stable 32-hex trace id for the whole run. Minted at run start, persisted to
   * `wf_run`, and used to (a) seed every per-node Sentry span so the run groups
   * into one distributed trace and (b) build the "View trace in Sentry"
   * deep-link. Undefined for runs started before tracing was wired.
   */
  traceId?: string
  /** Host Env (live bindings). Opaque to the SDK; passed back to the host. */
  env?: unknown
}

/**
 * Optional host-tunable runtime execution limits. Only the per-run **node
 * budget** is exposed — the runaway-loop backstop that aborts a run once it has
 * fired this many nodes (default {@link DEFAULT_NODE_BUDGET} = 256). A host that
 * genuinely needs a larger fan-out raises it here.
 *
 * The graph *schema* ceilings (agent `maxTurns` ≤ 20, iteration `concurrency` ≤
 * 20, retry `limit` ≤ 10) are deliberately NOT here: they're static validation
 * bounds baked into the graph schema, so a graph that exceeds them is rejected
 * at author time rather than clamped at runtime. Making them per-host would mean
 * turning the statically-imported schema into a factory — a wide contract change
 * for a speculative need — so they stay fixed until a concrete case appears.
 */
export type WfRunLimits = {
  /**
   * Max nodes a single run may fire before the scheduler aborts with a
   * `WorkflowBudgetError`. Defaults to 256. Nested iteration subgraphs get their
   * own independent budget.
   */
  nodeBudget?: number
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
  /**
   * Optional: fetch a single provider's full catalog from its `/models` endpoint,
   * for the Models admin page's "Refresh" action. The SDK persists the result to
   * its own `wf_model` table and owns the `enabled` flag, so the host returns
   * entries WITHOUT `enabled`. Reads `ctx.env` for the provider's API key. Omit if
   * the host offers only a static model list (no live catalog to refresh).
   */
  fetchModelCatalog?: (
    ctx: ModelListContext,
    providerId: string,
  ) => Promise<Omit<ModelCatalogEntry, 'enabled'>[]>
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
  /**
   * Optional host-tunable runtime limits (currently just the per-run node
   * budget). Omit to use the defaults. See {@link WfRunLimits}.
   */
  limits?: WfRunLimits
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
  if (config.fetchModelCatalog != null && typeof config.fetchModelCatalog !== 'function') {
    problems.push('`fetchModelCatalog`, if set, must be a function')
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
