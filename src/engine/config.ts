import type { LanguageModel } from 'ai'

import type { WfBlobRef } from './blob-ref'
import type { WfRunManifestEntry } from './graph'
import type {
  ModelCatalogEntry,
  ModelOption,
  ModelProvider,
  ProviderBudget,
} from './model-catalog'
import type { ToolRegistry } from './tool-registry'
import type { TriggerRegistry } from './trigger-registry'

// The host-injection contract — the single object a host app supplies to make
// the SDK do real work. The SDK is generic over an opaque per-run deps bundle
// `TDeps`; everything provider/domain-specific (the model provider, the tools)
// lives behind this interface, never inside the SDK.
//
// The model *catalog* data shapes (ModelOption, ModelProvider, ModelCatalog, …)
// are their own domain — see `model-catalog.ts` — and are re-exported here so
// `./config` remains the one import surface for the whole host contract.
export * from './model-catalog'

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
 *
 * `opts.reasoning` is a per-call override of the run-level reasoning intent
 * ({@link RunContext.reasoning}). Agent nodes deliberately pass NOTHING here, so
 * the provider's default (reasoning on) wins — see `agent-config-schema.ts`. It
 * exists for short internal utility calls (e.g. `summarize-changes.ts`) that want
 * a direct answer and would otherwise burn their token budget in a thinking pass
 * and return empty content. Undefined → fall back to the run-level intent.
 */
export type ModelFactory = (
  modelId: string,
  opts?: { reasoning?: boolean },
) => LanguageModel

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
  /**
   * Whether this generation should use the model's reasoning / thinking. The
   * SDK sets it per call site so the *intent* stays with the caller that knows
   * it, not inferred by the host from `triggerKind`:
   *   • agent runs leave it undefined → the host's normal default (reasoning on);
   *   • the SDK's internal utility calls (e.g. the publish change summarizer) set
   *     `false`, since they want a direct answer and reasoning is wasted latency
   *     — and on some providers a reasoning model can spend its whole token
   *     budget in a `<think>` pass and return empty content.
   * The host owns the *mechanism*: its `getModel` translates this into whatever
   * its provider needs (Venice `disableThinking`, Anthropic `thinking.disabled`,
   * …). Undefined means "host default"; the host must not force reasoning off.
   */
  reasoning?: boolean
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
   * Eval synthesis signal. When true, EVERY agent node runs with an empty tool
   * set — no registry tools, no synthesized delegation tools — forcing the model
   * to answer from its seeded message history alone. Set only by the eval runner
   * for a Sample authored with `freezeTools`, whose target is the single-agent
   * wrapper, so "every agent node" is exactly the one node under test. Isolates
   * response quality from tool-selection / retrieval nondeterminism.
   */
  freezeTools?: boolean
  /**
   * Eval matrix override — swaps the `modelId` and/or the system prompt on
   * EVERY agent node for this run. Set only by the eval matrix runner, whose
   * target is always the single-agent eval wrapper, so "every agent node" is
   * exactly the one node under test. Applied at point-of-use in the agent node
   * (after the frozen `manifest` is read), so it never rewrites `wf_run.manifest`
   * — the override is recorded on `wf_eval_result`, not the run's frozen config.
   * A `modelId`/`prompt` left undefined falls through to the agent's saved value.
   */
  agentOverride?: { modelId?: string; prompt?: string }
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
  /**
   * Optional: read one provider's live spend budget (remaining credit, cap,
   * reset cadence) for the Models page and the dashboard's Providers panel.
   * Reads `ctx.env` for the provider's API key, exactly like
   * {@link WfSdkConfig.fetchModelCatalog}. Nothing is persisted — the SDK calls
   * this on every request so the figure is never stale.
   *
   * Return `null` for a provider that publishes no balance endpoint (the UI
   * then shows "not reported"); omit the hook entirely if no provider does.
   * `providerId` is scoped to whatever {@link WfSdkConfig.listProviders} returns.
   */
  fetchProviderBudget?: (
    ctx: ModelListContext,
    providerId: string,
  ) => Promise<ProviderBudget | null>
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
