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
  /**
   * Provider-side web search: the provider can search the web on the model's
   * behalf inside a completion, when asked to via the agent's `webSearch`
   * setting (Venice `supportsWebSearch`, xAI Live Search, …).
   */
  webSearch?: boolean
  /**
   * Zero data retention: the provider does not keep prompts or completions. Its
   * absence means "not guaranteed" (anonymized or unreported), so a deployment
   * restricted to confidential data can filter on it.
   */
  private?: boolean
  /**
   * End-to-end encrypted: prompts are encrypted client-side and only decrypted
   * inside a verified secure enclave. Implies `private`.
   */
  e2ee?: boolean
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
  /**
   * Max context window in tokens. Omit when the provider doesn't report it.
   * Surfaced to the pickers (not just the admin page) because the agent editor
   * sizes a token budget against it — a budget is only meaningful relative to
   * what the chosen model can actually hold.
   */
  contextLength?: number
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
/**
 * What a catalogued model ANSWERS WITH, and therefore which picker may offer it.
 *
 *   • 'chat'     — a text/tool model resolved by `getModel`; the agent editor's
 *                  model dropdown and every `ModelOption` consumer.
 *   • 'decision' — a decision endpoint resolved by `getDecider`; the Decision
 *                  node and decision agents, via `listDecisionModels`.
 *
 * The two are not interchangeable in either direction — a decision model has no
 * `/chat/completions` to call and a chat model reports no calibrated
 * distribution — so the catalog keeps them in one table and separates them HERE,
 * at the only point where it matters: which list a model is offered in.
 *
 * It is a field rather than two tables because everything else about a
 * catalogued model is identical: the composite id, the pricing columns the cost
 * fold reads, the `enabled` opt-in, the provider grouping, the refresh upsert.
 * Splitting the table would duplicate all of that to express one adjective.
 *
 * Defaults to 'chat' everywhere it is absent, so a provider adapter that has
 * never heard of this keeps working and rows written before the column existed
 * read back as what they are.
 */
export type ModelKind = 'chat' | 'decision'

export const MODEL_KINDS = ['chat', 'decision'] as const

export type ModelCatalogEntry = ModelOption & {
  /** Provider-native id (e.g. `anthropic/claude-sonnet-4.6`) — what `getModel` resolves. */
  modelId: string
  /**
   * Which catalog this model belongs to — see {@link ModelKind}. Omit for a chat
   * model; a provider adapter that returns decision models MUST set it, or they
   * land in the agent model dropdown where nothing can call them.
   */
  kind?: ModelKind
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

/**
 * A provider's live spend budget, read straight from the provider's own API on
 * every request — never cached in our DB, so the number on screen is the number
 * the provider will bill against. Providers that expose no such endpoint (a
 * direct Anthropic or OpenAI key: neither publishes a balance API) report
 * `status: 'unsupported'` rather than being omitted, so the UI can say so
 * explicitly instead of leaving a silent gap.
 */
export type ProviderBudget = {
  providerId: string
  status: 'ok' | 'unsupported' | 'error'
  /**
   * Spend still available before requests start failing, USD. null = the key
   * carries no cap. Taken verbatim from the provider — NOT derived from
   * `limit - usage`, which is wrong for a key that resets (see `usage`).
   */
  remaining: number | null
  /** Spend cap, USD. null = uncapped. */
  limit: number | null
  /**
   * ALL-TIME spend on this key, USD (null when unreported). Deliberately not
   * comparable to `limit`: on a monthly key this keeps climbing while
   * `remaining` resets, so the progress bar must use `limit - remaining`.
   */
  usage: number | null
  /** Reset cadence, e.g. 'monthly'. null = never resets. Open-ended string. */
  resetInterval: string | null
  /** The provider's own masked key label, e.g. 'sk-or-v1-efe...071'. */
  keyLabel?: string
  /** Whether the key is on the provider's free tier. */
  isFreeTier?: boolean
  /** Key expiry, epoch ms. Omit when the key never expires. */
  expiresAt?: number
  /** Set when `status` is 'error' — surfaced inline on the card. */
  message?: string
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
