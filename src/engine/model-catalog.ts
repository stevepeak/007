// The model catalog domain: how a host describes its providers and models to the
// editor and the Models admin page. These are pure data shapes — the runtime
// injection contract that consumes them (`listModels` / `listProviders` /
// `fetchModelCatalog` on `WfSdkConfig`) lives in `config.ts`, which re-exports
// this module so `./config` stays the single import surface.

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
 * returns from `WfSdkConfig.listProviders`.
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
  /** Capabilities the model supports; omit when the provider reports none. */
  capabilities?: ModelCapabilities
}

/**
 * A full catalog entry for the Models admin page — a {@link ModelOption} plus the
 * richer metadata a provider's `/models` endpoint reports and the platform's
 * `enabled` opt-in. The host's `WfSdkConfig.fetchModelCatalog` returns these
 * without `enabled` (the SDK owns that flag); the admin page reads them with it.
 * `id` is the COMPOSITE `providerId:modelId` so it routes unambiguously through
 * `WfSdkConfig.getModel`; `modelId` keeps the provider-native id.
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
