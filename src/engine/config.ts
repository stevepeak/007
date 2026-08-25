import type { LanguageModel } from 'ai'

import type { TelemetrySink } from '../analytics/sink'

import type { WfBlobRef } from './blob-ref'
import type {
  AgentOverride,
  NodeExecution,
  WfRunManifestEntry,
} from './graph'
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
export type RunFailure = {
  error: string
  /**
   * The `wf_run` id — the one in the run viewer's URL. Present on both backing
   * stores (durable + inline); undefined only on the pure in-process engine
   * (evals, tests, the playground), which writes no run row at all. A host that
   * reports failures somewhere durable needs this to link back, and it cannot
   * reconstruct it from `RunContext` — nothing there names the run.
   */
  workflowRunId?: string
}

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

/** Where a spilled value was about to cross, so a host can key spills by kind. */
export type BlobSpillContext = {
  runId: string
  nodeId: string
  /** Set when the value is one item's result inside an iteration subgraph. */
  itemIndex?: number
  slot: 'node-output' | 'iteration-item'
  /**
   * Where inside the node's output this payload sat, e.g. `text` or
   * `items.3.body` (empty when the output *is* the payload). Part of the key's
   * identity: one node can spill several leaves, and they must not collide.
   */
  path: string
}

/**
 * Writes a payload the engine judged too large to cross a step boundary, and
 * reports the key it can later be read back by. The inverse of
 * {@link BlobRefResolver}: this one runs *inside* the producing node's step,
 * that one inside the consuming node's, so the payload itself never sits at a
 * boundary. The engine decides *whether* to spill and encodes the payload; the
 * host decides only *where the bytes go* — which is where storage layout and
 * tenancy belong. See `createR2BlobSpiller` in `../cloudflare`.
 */
export type BlobSpiller<TDeps> = (
  payload: { text: string; contentType: string },
  ctx: BlobSpillContext,
  deps: TDeps,
) => Promise<{ key: string; storage?: string }>

// NOTE: vision (`ResolvedImage` / `ImageRefResolver` / an agent node's
// `imageInputs`) was removed along with the implicit user message. Image parts
// were appended to whatever turn happened to exist, which is exactly the kind of
// content an author never declared — and a `${var}` cannot carry an image, since
// base64 in a text turn is not an image to any provider. Vision needs its own
// design where the user template names and places the attachment.

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
  /**
   * The host principal this run acts for (a user id) — a third opaque host
   * reference, same contract as `subjectId`/`correlationId`: the SDK never
   * interprets it, only persists it (`wf_run.actor_id`) and attributes the
   * run's Sentry spans with it. That is what lets a failure report name the
   * affected user without the host re-deriving it from a chat id. Undefined for
   * unattended runs (cron, ingest, evals) and for runs started before it
   * existed.
   */
  actorId?: string
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
   * Run-scoped execution policy layered onto every node's own, TIGHTENING only
   * (see `tightenExecution`). Lets a caller cap what one run may spend without
   * touching anybody's published graph — eval runs use it so a wedged provider
   * surfaces in a couple of minutes instead of consuming the 20-minute AI
   * default four times over. Undefined → each node's declared policy stands.
   */
  executionOverride?: NodeExecution
  /**
   * Canned tool outputs keyed by tool id, consumed only under `simulate`: a read
   * tool returns `fixtures[toolId]` instead of hitting live data, making an eval
   * run reproducible. Absent id → the tool's safe empty default (`{}`).
   */
  fixtures?: Record<string, unknown>
  /**
   * Eval integration signal. When true, tools tagged `sideEffect: 'read'`
   * execute for real instead of returning their `fixtures` entry — write tools
   * stay neutralized by `simulate`. Set by the eval runner for a Sample whose
   * tools are `live`, which is how a goal grades the agent against real
   * retrieval rather than a canned corpus.
   */
  liveReads?: boolean
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
   * Eval override — swaps the whole agent `config` (an unsaved draft) and/or the
   * `modelId` / system prompt (the matrix axes) on EVERY agent node for this
   * run. Set only by the eval runner, whose target is always the single-agent
   * eval wrapper, so "every agent node" is exactly the one node under test.
   * Applied at point-of-use in the agent node (after the frozen `manifest` is
   * read), so it never rewrites `wf_run.manifest` — the override is recorded on
   * `wf_eval_result`, not the run's frozen config. Any field left undefined
   * falls through to the agent's saved value. See {@link AgentOverride}.
   */
  agentOverride?: AgentOverride
  /**
   * Stable 32-hex trace id for the whole run. Minted at run start, persisted to
   * `wf_run`, and used to (a) seed every per-node Sentry span so the run groups
   * into one distributed trace and (b) build the "View trace in Sentry"
   * deep-link. Undefined for runs started before tracing was wired.
   */
  traceId?: string
  /**
   * Mirrors `wf_run.is_eval`. Carried for TELEMETRY partitioning only — every
   * dashboard query filters `is_eval = false`, so points that couldn't be
   * partitioned the same way would never reconcile with the charts. Nothing
   * about execution reads it; `simulate` and `freezeTools` are the eval signals
   * that change behavior.
   */
  isEval?: boolean
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
   * Optional: write the parts of a node output that exceed
   * {@link spillThresholdBytes} to blob storage, so the boundary carries a
   * pointer instead of the payload. Applied to every node output and every
   * iteration item result — the two places a value crosses a durable step
   * boundary and meets Cloudflare Workflows' 1 MiB cap.
   *
   * Requires {@link resolveBlobRef}: a pointer nothing can read back is worse
   * than the oversized value it replaced, so declaring one without the other is
   * a config error rather than a degraded mode.
   */
  spillBlobRef?: BlobSpiller<TDeps>
  /**
   * Byte threshold above which a string inside a node output is spilled
   * (default 128 KiB — well under the 1 MiB step cap, so the pointer and its
   * preview fit with room for the rest of the step's envelope). Ignored without
   * {@link spillBlobRef}.
   */
  spillThresholdBytes?: number
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
  /**
   * Optional: where per-step and per-run telemetry points go. Called once per
   * Worker invocation (a Workflow's `run()` re-executes on every wake, so the
   * sink's per-invocation point cap scopes itself naturally), and handed the
   * live `env` so the host can reach a binding the SDK deliberately doesn't
   * name — on Cloudflare, `createAnalyticsEngineTelemetry` from
   * `@stevepeak/007/cloudflare`.
   *
   * Omit and runs are untelemetered: the engine writes to a no-op sink, which
   * is what every in-process caller (evals, tests, the playground) uses.
   * Telemetry is strictly additive — the D1 run trace is unaffected either way.
   */
  resolveTelemetry?: (ctx: {
    env?: unknown
  }) => TelemetrySink | undefined | null
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
  if (config.spillBlobRef != null && typeof config.spillBlobRef !== 'function') {
    problems.push('`spillBlobRef`, if set, must be a function')
  }
  if (config.spillBlobRef != null && config.resolveBlobRef == null) {
    problems.push(
      '`spillBlobRef` requires `resolveBlobRef` — a spilled pointer with no reader would break every node downstream of a large output',
    )
  }
  if (
    config.spillThresholdBytes != null &&
    (typeof config.spillThresholdBytes !== 'number' ||
      !Number.isFinite(config.spillThresholdBytes) ||
      config.spillThresholdBytes <= 0)
  ) {
    problems.push('`spillThresholdBytes`, if set, must be a positive number')
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
