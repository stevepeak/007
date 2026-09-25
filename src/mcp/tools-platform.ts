import { z } from 'zod'

import { clip } from '../server/clip'
import type {
  ModelCapabilities,
  ModelOption,
  ProviderBudget,
  WfChangeDTO,
  WfDashboardSeries,
} from '../server/protocol'

import { boundedLimit, optString, reqString, type WfMcpTool } from './tools'

// Tools pulled off the "extend the surface" queue, each because something that
// already shipped was unusable without it. `WfDataClient` has ~70 methods
// and exposing them all would be worse than exposing fifteen good ones — tool
// descriptions are prompt, and a bloated registry degrades selection. So the
// bar is a written reason, not coverage.
//
//   • `list_models` — `run_eval` takes a `models` array of catalog ids and
//     NOTHING told the model which ids exist. Asked to sweep two models it had
//     to recall one from training or scrape one out of a run trace, and a wrong
//     id fails at the provider after the sweep has already been launched.
//   • `list_changes` — `get_eval_run`'s drift block reports "the target agent
//     was republished since the last run". The immediate next question is who
//     changed what, and `wf_change` is the only record of it: 007 keeps no
//     per-table `updated_by`.
//
//   • `get_dashboard` — every other read here answers a question you already
//     knew to ask. Nothing answered "what is wrong right now", so a session
//     opened by guessing: list some runs, hope a failure is recent enough to be
//     on the first page. The rollup is the one call that ranks the work.
//
//   • `list_decision_models` — the same argument as `list_models`, one namespace
//     over. Deciders are a SEPARATE catalog from chat models, and two write
//     tools already take an id out of it: a `decision_judge` check's `modelId`
//     (`upsert_eval_sample`) and a Decision node's `config.modelId`
//     (`patch_workflow_draft`). With nothing listing them, a model either
//     invented an id — failing at the provider after a sweep had launched, the
//     exact failure `list_models` was built to prevent — or omitted it and
//     silently got whatever sorts first.
//
//   • `set_model_enabled` / `refresh_model_catalog` — curating the catalog is
//     the Models page's whole job, and this category had ZERO write tools: you
//     could read the consequence of a model being disabled in `list_changes` and
//     never cause it, so an agent told "this model is deprecated, stop anyone
//     picking it" could only file a ticket. Both are thin (the handlers already
//     enforce the in-use guard and write the `wf_change` row), reversible, and
//     audited — well below `publish_workflow` on risk, which is already here.
//
// Deliberately NOT here: `run_tool_preview` (executes the real tool against
// live services — see `tools-agents.ts`) and `list_tool_invocations` (nothing has
// wanted it).
//
// `get_model_catalog` and `list_providers` are not separate tools either, but the
// reason changed. The old one — that offering the full catalog "would only invite
// naming a model that is off on purpose" — was sound for a raw dump and wrong for
// everything else on those payloads: the prompt/completion price split, `vendor`,
// per-provider refresh status, and which agents use a model are all questions a
// cost or deprecation conversation has to answer, and none of them could be
// asked. So `list_models` now reads the catalog and projects it: filtered,
// bounded, enabled-only unless asked, and every row marked `enabled`. Which
// answers the objection rather than working around it — a disabled row is
// labelled as disabled, not hidden.
//
// Provider ADD / EDIT / DELETE and provider enable/disable stay out, and not as a
// judgement call: providers come from the host's `WfSdkConfig.listProviders` and
// every read is gated against that set, so there is no such action anywhere, UI
// included (`wf_model_provider.enabled` is a column with no writer). Raw
// credentials stay out permanently — `storage/schema-models.ts`: "Credentials
// live in the host env, never here." Note that rule is about SECRETS and does not
// cover `ProviderBudget`, which is already a masked projection the console shows
// freely; it rides on `get_dashboard`. And bulk catalog import / cross-env sync
// belongs to `scripts/sync-model-catalog.ts`, whose header forbids a second
// mechanism — `refresh_model_catalog` is per-environment curation, not sync.

/** A change's `before`/`after` can be a whole agent config or workflow graph. */
const CHANGE_PAYLOAD_CHARS = 1200

/**
 * Every `wf_change` entity kind, in the order the description lists them.
 *
 * The prose used to name six and stop, while the filter already accepted eight —
 * so `connector` and `connector_tool` worked and nothing said they existed. Same
 * failure as `upsert_eval_sample`'s check types: a hardcoded list beside a
 * derived one.
 *
 * Spelled as a `Record` keyed on the wire type rather than read off
 * `WF_CHANGE_ENTITY_KINDS` directly, because that constant lives in a drizzle-
 * importing module and this file is reached by `describe.ts` — which runs in a
 * Worker where the ORM has no business being bundled. A missing key is still a
 * compile error, so the list cannot drift again; it just can't cost a dependency.
 */
const CHANGE_ENTITY_KINDS = Object.keys({
  workflow: null,
  agent: null,
  eval_set: null,
  eval_row: null,
  model: null,
  assignment: null,
  connector: null,
  connector_tool: null,
} satisfies Record<WfChangeDTO['entityKind'], null>)

/**
 * Model rows one `list_models` returns by default, and the ceiling.
 *
 * An OpenRouter catalog is 300+ entries, so `includeDisabled` without a bound
 * would spend more context on models nobody will pick than the answer is worth.
 * The counts above the list always describe every match, so a bounded page never
 * hides the SHAPE of the result — only its tail.
 */
const DEFAULT_MODEL_ROWS = 40
const MAX_MODEL_ROWS = 200

/**
 * The fields every model row carries, enabled list or full catalog.
 *
 * `capabilities` is the one a caller acts on rather than reads: it is what the
 * agent-model gate gives a refusal for, so a model picked WITH it in hand can't
 * be refused for something this call already showed.
 */
function projectModel(m: ModelOption): Record<string, unknown> {
  return {
    id: m.id,
    label: m.label,
    providerId: m.providerId,
    costPerMTok: m.costPerMTok,
    tokensPerSec: m.tokensPerSec,
    contextLength: m.contextLength,
    capabilities: m.capabilities,
  }
}

/** Widest dashboard window a caller may ask for, in hours. */
const MAX_DASHBOARD_HOURS = 24 * 90

/** Series kept per panel. The tail is the long thin part nobody acts on. */
const MAX_DASHBOARD_SERIES = 8

/** Failures listed with their error text — enough to spot a shared cause. */
const MAX_RECENT_FAILURES = 10

/** A run's `error` is a provider message and can carry a whole stack. */
const FAILURE_ERROR_CHARS = 400

/**
 * A series without its per-bucket points.
 *
 * The dashboard payload is mostly `points` — one number per bucket per series,
 * on four panels — because it draws charts. A reader here draws nothing, and a
 * 90-day window at daily buckets would spend thousands of tokens on arrays that
 * can only be summed back into the `total` that is already right there.
 */
function rank(series: WfDashboardSeries[]): { label: string; total: number }[] {
  return [...series]
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_DASHBOARD_SERIES)
    .map((s) => ({ label: s.label, total: s.total }))
}

export function platformReadTools(): WfMcpTool[] {
  return [
    {
      name: 'list_models',
      title: 'List models',
      description: [
        "The models available here, with cost per 1M tokens, throughput, context window and capabilities. Pass an `id` from this list VERBATIM wherever a model is named (run_eval's `models`, an agent's modelId) — ids are composite `provider:model` and the provider-native half alone will 404. Use it before any matrix sweep that names models.",
        '',
        'ENABLED models only by default — the catalog is larger and the rest are off on purpose. `includeDisabled: true` shows the whole thing with an `enabled` flag on each row, which is how you answer "is there a cheaper model we already have but have not turned on?".',
        '',
        'Narrow it rather than reading all of it: `query` matches id/label/vendor, `capability` keeps models that can do a thing (tools, structuredOutput, reasoning, vision, webSearch), and `maxCostPerMTok` / `minContextLength` bound the rest. Filtering by capability is also how you pick a model FOR a requirement instead of guessing and being refused by the gate.',
        '',
        'Each provider carries `enabledCount` / `modelCount` and `lastRefreshedAt`. Those two are what explain a surprising result: "only 3 of 312 are enabled" and "last refreshed six weeks ago" are the usual reasons a model you expected is missing. A stale catalog is fixed with refresh_model_catalog; a disabled model with set_model_enabled.',
        '',
        '`usedByAgents` names the agents pointing at each model — the blast radius before disabling one, and the reason the platform refuses to disable a model still in use.',
      ].join('\n'),
      inputSchema: {
        query: z
          .string()
          .nullish()
          .describe('Case-insensitive substring match on id, label or vendor.'),
        capability: z
          .string()
          .nullish()
          .describe(
            'Keep only models KNOWN to support this: tools, structuredOutput, reasoning, vision or webSearch. A model whose capabilities are unreported is kept either way — unknown is not the same as unsupported.',
          ),
        vendor: z
          .string()
          .nullish()
          .describe('Keep only this vendor (e.g. "anthropic", "openai").'),
        providerId: z
          .string()
          .nullish()
          .describe('Keep only models served by this provider id.'),
        maxCostPerMTok: z
          .number()
          .nullish()
          .describe('Keep only models at or below this blended USD/1M tokens.'),
        minContextLength: z
          .number()
          .nullish()
          .describe('Keep only models with at least this context window.'),
        includeDisabled: z
          .boolean()
          .nullish()
          .describe(
            'Include models the platform has turned off. Default false. A disabled id is NOT accepted anywhere a model is named.',
          ),
        limit: z
          .number()
          .nullish()
          .describe(
            `Rows to return, cheapest first (default ${DEFAULT_MODEL_ROWS}, max ${MAX_MODEL_ROWS}). The counts above the list always describe every match, not just the page.`,
          ),
      },
      readOnly: true,
      run: async (client, args) => {
        // The admin-page read, not `listModels()`. It is the only one carrying
        // the disabled rows, the prompt/completion price split, `vendor`, the
        // per-provider refresh status and the agent usage map — all of which are
        // questions ("what would break if I disabled this?", "what is the
        // prompt-side price?") that were one click in the console and
        // unanswerable here. `listModels()` is the fallback, because a filtered
        // enabled list is still worth more than an error.
        const catalog = await client.getModelCatalog().catch(() => null)
        if (!catalog) {
          const [models, providers] = await Promise.all([
            client.listModels(),
            client.listProviders().catch(() => []),
          ])
          return {
            providers,
            models: models.map(projectModel),
            degraded:
              'The full catalog could not be read, so this is the plain enabled list: no disabled rows, no price split, no provider refresh status.',
          }
        }

        const query = optString(args.query)?.toLowerCase()
        const capability = optString(args.capability) as
          | keyof ModelCapabilities
          | undefined
        const vendor = optString(args.vendor)?.toLowerCase()
        const providerId = optString(args.providerId)
        const maxCost =
          typeof args.maxCostPerMTok === 'number'
            ? args.maxCostPerMTok
            : undefined
        const minContext =
          typeof args.minContextLength === 'number'
            ? args.minContextLength
            : undefined
        const includeDisabled = args.includeDisabled === true

        const matched = catalog.models.filter((m) => {
          if (!includeDisabled && !m.enabled) return false
          if (providerId && m.providerId !== providerId) return false
          if (vendor && m.vendor?.toLowerCase() !== vendor) return false
          if (query) {
            const haystack =
              `${m.id} ${m.label} ${m.vendor ?? ''}`.toLowerCase()
            if (!haystack.includes(query)) return false
          }
          // Unreported capabilities are never filtered OUT, mirroring
          // `unmetRequirements`: a model is only ever excluded for something it
          // is KNOWN to lack.
          if (
            capability &&
            m.capabilities &&
            m.capabilities[capability] !== true
          ) {
            return false
          }
          if (maxCost != null && (m.costPerMTok ?? Infinity) > maxCost) {
            return false
          }
          if (
            minContext != null &&
            (m.contextLength ?? 0) < minContext
          ) {
            return false
          }
          return true
        })

        // Cheapest first: the ordering the question "what could we use instead"
        // actually wants. An unpriced model sorts last rather than free.
        const ordered = [...matched].sort(
          (a, b) => (a.costPerMTok ?? Infinity) - (b.costPerMTok ?? Infinity),
        )
        const limit = boundedLimit(args.limit, DEFAULT_MODEL_ROWS, MAX_MODEL_ROWS)
        const shown = ordered.slice(0, limit)

        return {
          providers: catalog.providers.map((p) => ({
            id: p.id,
            label: p.label,
            kind: p.kind,
            note: p.note,
            enabled: p.enabled,
            modelCount: p.modelCount,
            enabledCount: p.enabledCount,
            lastRefreshedAt:
              p.lastRefreshedAt == null
                ? null
                : new Date(p.lastRefreshedAt).toISOString(),
          })),
          counts: {
            matched: ordered.length,
            shown: shown.length,
            enabledInCatalog: catalog.models.filter((m) => m.enabled).length,
            inCatalog: catalog.models.length,
          },
          models: shown.map((m) => ({
            ...projectModel(m),
            enabled: m.enabled,
            vendor: m.vendor,
            // The split, not just the blend: a prompt-heavy workload and a
            // completion-heavy one are priced differently by the same model, and
            // `get_dashboard`'s cost series is blended.
            promptPricePerMTok: m.promptPricePerMTok,
            completionPricePerMTok: m.completionPricePerMTok,
            releasedAt:
              m.releasedAt == null
                ? undefined
                : new Date(m.releasedAt).toISOString(),
            usedByAgents: (catalog.usage[m.id] ?? []).map((a) => a.name),
          })),
          note:
            ordered.length > shown.length
              ? `Showing the ${shown.length} cheapest of ${ordered.length} matches. Narrow with query/capability/vendor/maxCostPerMTok, or raise limit.`
              : undefined,
        }
      },
    },

    {
      name: 'list_decision_models',
      title: 'List decision models',
      description:
        'The DECISION models (deciders) this deployment can reach — a separate catalog from list_models, which returns chat models. A decider answers one closed question with a probability instead of prose. Pass an `id` from here VERBATIM wherever a decision model is named: a `decision_judge` check’s `modelId`, or a Decision node’s `config.modelId`. A chat model id in either slot resolves to nothing. `calibrated` says whether the probabilities are real or the model’s self-report — a threshold means much less against an uncalibrated decider. An empty list means this deployment has no decision provider wired, so `decision_judge` checks cannot be graded here and Decision nodes are off.',
      inputSchema: {},
      readOnly: true,
      run: async (client) => {
        const [models, providers] = await Promise.all([
          client.listDecisionModels(),
          // Same reason `list_models` names its providers: it is the difference
          // between "nothing is enabled" and "nothing is wired up".
          client.listDecisionProviders().catch(() => []),
        ])
        return {
          providers,
          models,
          // Stated rather than left to be inferred from `[]`: the empty case has
          // a specific, actionable cause and reads like a bug otherwise.
          note:
            models.length === 0
              ? 'No decision provider is wired on this host (WfSdkConfig.listDecisionModels / getDecider). A `decision_judge` check authored here would report that in its own check error rather than grading.'
              : 'Deciders come straight from the host config — there is no enable/disable curation for them, so every id here is live.',
        }
      },
    },

    {
      name: 'get_dashboard',
      title: 'Get dashboard',
      description:
        'The health rollup over a recent window: run volume and failure count, what is in flight right now, spend per model, each provider’s remaining credit, the outstanding feedback queue, and the newest failed runs with their errors. Start here when the question is open-ended ("what is broken", "what did we spend") — it ranks where to look, and every id it returns can be handed to get_run, get_workflow or list_feedback. Check `providerBudgets` before launching anything that spends: a key with no credit left is a top cause of a sweep dying mid-matrix, and it reads in the report as the agent regressing.',
      inputSchema: {
        hours: z
          .number()
          .nullish()
          .describe(
            `How far back to look (default 24, max ${MAX_DASHBOARD_HOURS} — 90 days).`,
          ),
      },
      readOnly: true,
      run: async (client, args) => {
        const hours = boundedLimit(args.hours, 24, MAX_DASHBOARD_HOURS)
        const until = Date.now()
        const since = until - hours * 3_600_000
        // Derived, not asked for: the bucket only decides chart resolution and
        // this tool returns no chart. Hourly over a long window would just be
        // more arrays to throw away.
        // Budgets ride along rather than living in their own tool. This is the
        // "what is wrong right now" call, and an exhausted provider key is one of
        // the most common things that IS wrong — it kills an eval sweep
        // mid-matrix, and the failure reads as the agent regressing. The console
        // puts its Providers panel next to these same numbers.
        //
        // Two things make it safe to fold in. It never fails the dashboard: the
        // handler already contains one provider's outage to its own entry, and
        // the catch here covers an unwired host. And the secrets rule does not
        // reach it — `ProviderBudget` is a masked projection (a masked key label,
        // a free-tier flag, a dollar balance), which is why the UI shows it
        // freely; no token, not even a redacted one, crosses this boundary.
        const [d, budgets] = await Promise.all([
          client.getDashboard({
            since,
            until,
            bucket: hours <= 48 ? 'hour' : 'day',
          }),
          client.getProviderBudgets().catch((): ProviderBudget[] => []),
        ])
        return {
          // The window the SERVER charted — it clamps what it is asked for, and
          // a reader comparing two calls needs to know which one it got.
          window: {
            since: new Date(d.since).toISOString(),
            until: new Date(d.until).toISOString(),
            hours: Math.round((d.until - d.since) / 3_600_000),
          },
          runs: {
            total: d.runs.total,
            failed: d.runs.failed,
            // Stated rather than left to be divided: a failure COUNT reads very
            // differently against 20 runs than against 2000.
            failureRate:
              d.runs.total > 0
                ? Number((d.runs.failed / d.runs.total).toFixed(3))
                : null,
            // Not window-scoped — this is right now. A high number with no
            // recent failures is a stall, not throughput.
            inFlight: d.runs.inFlight,
            byWorkflow: rank(d.runs.series),
            source: d.runs.source,
          },
          cost: {
            totalUsd: d.cost.totalUsd,
            totalTokens: d.cost.totalTokens,
            unpricedTokens: d.cost.unpricedTokens,
            byModel: rank(d.cost.series),
            source: d.cost.source,
            note: d.cost.pricedAtRunTime
              ? undefined
              : 'Dollars are token usage × TODAY’s catalog price, so historical spend moves when the catalog does.',
          },
          feedback: {
            unacknowledged: d.feedback.unacknowledged,
            unacknowledgedDown: d.feedback.unacknowledgedDown,
            up: d.feedback.up,
            down: d.feedback.down,
          },
          // Read this before sizing anything expensive. `remaining` is the spend
          // left before requests start FAILING, taken verbatim from the provider
          // rather than derived — on a key that resets, `limit - usage` is simply
          // wrong. `status: 'unsupported'` means the provider publishes no
          // balance API (a direct Anthropic or OpenAI key), not that the key is
          // fine; `'error'` means we could not ask, which is itself worth seeing.
          providerBudgets: budgets.map((b) => ({
            providerId: b.providerId,
            status: b.status,
            remaining: b.remaining,
            limit: b.limit,
            usage: b.usage,
            resetInterval: b.resetInterval,
            keyLabel: b.keyLabel,
            isFreeTier: b.isFreeTier,
            expiresAt:
              b.expiresAt == null
                ? undefined
                : new Date(b.expiresAt).toISOString(),
            message: b.message,
          })),
          // Null, never zero, when analytics is unconfigured — nothing in SQL
          // counts `step.do` calls, and a fabricated 0 reads as "these were free".
          steps: d.steps
            ? {
                total: d.steps.total,
                runs: d.steps.runs,
                nodes: d.steps.nodes,
                iterationItems: d.steps.iterationItems,
                byWorkflow: rank(d.steps.series),
              }
            : null,
          recentFailures: d.recentFailures
            .slice(0, MAX_RECENT_FAILURES)
            .map((r) => ({
              runId: r.id,
              workflow: r.workflowName,
              triggerKind: r.triggerKind,
              finishedAt: r.finishedAt,
              error: clip(r.error, FAILURE_ERROR_CHARS),
            })),
          note: 'Per-bucket chart series are omitted; each panel’s figures are window totals. Pass a runId from recentFailures to get_run for the trace.',
        }
      },
    },

    {
      name: 'list_changes',
      title: 'List changes',
      description:
        "The audit feed — who changed what, when, and which fields. This is the ONLY who-touched-this record: there is no per-row `updated_by` anywhere else. Use it to answer 'what changed since…', to explain a drifted eval (get_eval_run's `agentRepublishedSinceLastRun`) by naming the publish that caused it, and to find who disabled a model or a connector tool.",
      inputSchema: {
        entityKind: z
          .string()
          .nullish()
          .describe(
            `One of: ${CHANGE_ENTITY_KINDS.join(', ')}. Omit for all.`,
          ),
        entityId: z
          .string()
          .nullish()
          .describe('Only changes to this one entity.'),
        parentId: z
          .string()
          .nullish()
          .describe(
            "Changes to an entity's children — a Goal's id returns its Samples' edits.",
          ),
        actorId: z
          .string()
          .nullish()
          .describe(
            'Only this actor. Edits made over the MCP carry the user id of whoever authorized the session, same as a click in the console — `source` is what tells the two apart.',
          ),
        limit: z
          .number()
          .nullish()
          .describe('How many rows (default 30, max 100).'),
      },
      readOnly: true,
      run: async (client, args) => {
        const rows = await client.listChanges({
          entityKind: optString(args.entityKind) as
            | WfChangeDTO['entityKind']
            | undefined,
          entityId: optString(args.entityId),
          parentId: optString(args.parentId),
          actorId: optString(args.actorId),
          limit: boundedLimit(args.limit, 30, 100),
        })
        return rows.map((r: WfChangeDTO) => ({
          ...r,
          // A published agent config or workflow graph rides along whole.
          before: clip(r.before, CHANGE_PAYLOAD_CHARS),
          after: clip(r.after, CHANGE_PAYLOAD_CHARS),
        }))
      },
    },
  ]
}

/**
 * The model-catalog writes.
 *
 * Curation, not configuration: both change which models the pickers OFFER, and
 * neither can reach a credential or invent a provider. Both are `wf_change`-
 * logged and reversible, which is what puts them below `publish_workflow` — the
 * write this catalog already exposes — on consequence.
 *
 * They are platform-wide though, unlike every other write here: one call changes
 * what every author in the workspace sees. So both say so, and `set_model_enabled`
 * reports the blast radius it checked rather than only the outcome.
 */
export function platformWriteTools(): WfMcpTool[] {
  return [
    {
      name: 'set_model_enabled',
      title: 'Enable or disable a model',
      description: [
        'Turn one model on or off for the whole workspace. Enabled models are what every picker offers and the only ids accepted where a model is named — an agent’s `modelId`, run_eval’s `models`. This is how "that model is deprecated, stop anyone picking it" actually gets done.',
        '',
        'PLATFORM-WIDE and immediate: it changes what every author sees, not just this session. It is also reversible, and lands in the `wf_change` feed attributed to whoever authorized this session.',
        '',
        'Disabling is REFUSED while an agent still points at the model, because that would break the agent’s model resolution at its next run. The refusal names the agents; repoint them first. Enabling is never refused.',
        '',
        'A model must be in the catalog to be enabled — run refresh_model_catalog first if the provider has only just shipped it. Ids are composite `provider:model`; list_models({ includeDisabled: true }) is where they come from.',
      ].join('\n'),
      inputSchema: {
        modelId: z
          .string()
          .describe(
            'Composite catalog id, from list_models({ includeDisabled: true }).',
          ),
        enabled: z
          .boolean()
          .describe('true offers it in every picker; false withdraws it.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const modelId = reqString(args.modelId, 'modelId')
        if (typeof args.enabled !== 'boolean') {
          throw new TypeError(
            'Missing required argument `enabled` — true to offer the model, false to withdraw it.',
          )
        }
        const enabled = args.enabled
        // Read the catalog first so a bad id is a refusal here rather than an
        // UPDATE that matches zero rows and returns `{ ok: true }` — the
        // silent-no-op-reads-as-success shape `update_description` also guards.
        const catalog = await client.getModelCatalog().catch(() => null)
        const found = catalog?.models.find((m) => m.id === modelId)
        if (catalog && !found) {
          return {
            error: `No model in this catalog with id ${modelId}. Ids are composite \`provider:model\` and come from list_models({ includeDisabled: true }). If the provider has only just shipped it, run refresh_model_catalog first.`,
          }
        }
        if (found && found.enabled === enabled) {
          return {
            modelId,
            enabled,
            changed: false,
            note: `Already ${enabled ? 'enabled' : 'disabled'} — nothing was written, so nothing lands in the change feed.`,
          }
        }
        // `setModelEnabled` THROWS the in-use refusal, naming the agents. Let it
        // through verbatim: the names are the actionable part.
        await client.setModelEnabled({ modelId, enabled })
        return {
          modelId,
          label: found?.label,
          enabled,
          changed: true,
          usedByAgents: (catalog?.usage[modelId] ?? []).map((a) => a.name),
          note: enabled
            ? 'Now offered in every picker, for every author in this workspace.'
            : 'Withdrawn from every picker workspace-wide. Agents already pointing at it were checked first — none were.',
        }
      },
    },

    {
      name: 'refresh_model_catalog',
      title: 'Refresh a provider’s model catalog',
      description: [
        'Re-read one provider’s `/models` endpoint and cache what it reports. This is the only way a model the provider has newly shipped becomes visible here at all — until it runs, list_models keeps returning the same stale set, and the reason (`lastRefreshedAt`) is the only hint.',
        '',
        'Nothing is auto-enabled. Newly discovered models are cached DISABLED and someone opts them in with set_model_enabled; models already in the catalog keep the enabled flag they had. So a refresh cannot change what any agent runs on — it only changes what is available to choose.',
        '',
        'SLOW: it calls the provider’s API and upserts hundreds of rows, so give it time and do not call it in a loop. It also drops the cached price map, so run costs re-derive against the new prices immediately.',
        '',
        'This is per-environment curation. It is NOT how a catalog moves between local and prod — `scripts/sync-model-catalog.ts` owns that, and running both against one database would fight.',
      ].join('\n'),
      inputSchema: {
        providerId: z
          .string()
          .describe('Provider id, from the `providers` block of list_models.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const providerId = reqString(args.providerId, 'providerId')
        const before = await client.getModelCatalog().catch(() => null)
        if (before && !before.providers.some((p) => p.id === providerId)) {
          return {
            error: `This host declares no provider with id ${providerId}. Providers come from the host's own config (WfSdkConfig.listProviders) and cannot be added from here — list_models names the ones that exist.`,
            providerIds: before.providers.map((p) => p.id),
          }
        }
        const beforeCount =
          before?.models.filter((m) => m.providerId === providerId).length ?? 0
        const result = await client.refreshModels({ providerId })
        const after = await client.getModelCatalog().catch(() => null)
        const rows = after?.models.filter((m) => m.providerId === providerId)
        return {
          providerId,
          cached: result.count,
          refreshedAt: new Date(result.refreshedAt).toISOString(),
          // The delta is the interesting number: "312 models" says nothing,
          // "4 new since last time" is the answer to why you ran this.
          newlyDiscovered: Math.max(0, (rows?.length ?? beforeCount) - beforeCount),
          enabled: rows?.filter((m) => m.enabled).length,
          total: rows?.length,
          note: 'New models are cached DISABLED. Enable the ones you want with set_model_enabled — nothing an agent runs on changed.',
        }
      },
    },
  ]
}
