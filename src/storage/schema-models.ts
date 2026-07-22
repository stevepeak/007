import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createdAt } from './schema-common'

// A model provider the platform can pull a catalog from (OpenRouter today;
// Venice/others later). Providers are a single GLOBAL set — the enabled catalog
// is platform-wide config, not tenant-scoped. `lastRefreshedAt` records the last
// successful pull from this provider's `/models` endpoint. No FK; `id` is an
// opaque host-chosen key (e.g. 'openrouter') matching the host's provider
// registry. Credentials live in the host env, never here.
export const wfModelProvider = sqliteTable('wf_model_provider', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  // Mirrors engine `ModelProviderKind`: openrouter | openai | openai-compatible
  // | custom. Free text (not an enum) so the host can introduce kinds without a
  // migration.
  kind: text('kind').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  note: text('note'),
  lastRefreshedAt: integer('last_refreshed_at', { mode: 'timestamp' }),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// One cached model from a provider's catalog. `id` is the COMPOSITE
// `providerId:modelId` (two providers may expose the same bare id), while
// `modelId` keeps the provider-native id passed to the host's `getModel`.
// `enabled` is the platform's opt-in: refresh inserts new models disabled and
// preserves the flag on existing ones, so the user curates which models the
// pickers may use. Prices are USD per 1M tokens; `tokensPerSec` and the price
// fields are nullable when the provider doesn't report them. `raw` keeps the
// untouched catalog entry for future fields. No FK to the provider row.
export const wfModel = sqliteTable(
  'wf_model',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    label: text('label').notNull(),
    // Grouping/filter key: the vendor prefix (before '/') for OpenRouter ids,
    // else the provider label.
    vendor: text('vendor'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    // Blended USD/1M tokens used by the existing pickers' cost display.
    costPerMTok: real('cost_per_m_tok'),
    promptPricePerMTok: real('prompt_price_per_m_tok'),
    completionPricePerMTok: real('completion_price_per_m_tok'),
    contextLength: integer('context_length'),
    tokensPerSec: real('tokens_per_sec'),
    // When the model was released, per the provider catalog (OpenRouter's
    // `created`). Drives the Models page "age" filter. Null when unreported.
    releasedAt: integer('released_at', { mode: 'timestamp' }),
    // Capability flags derived from the provider catalog (OpenRouter's
    // `supported_parameters` + `architecture.input_modalities`). Drive the Models
    // page badges and the agent editor's requirement gating. Default false =
    // "not reported / not supported"; a refresh repopulates them.
    supportsTools: integer('supports_tools', { mode: 'boolean' })
      .notNull()
      .default(false),
    supportsReasoning: integer('supports_reasoning', { mode: 'boolean' })
      .notNull()
      .default(false),
    supportsStructuredOutput: integer('supports_structured_output', {
      mode: 'boolean',
    })
      .notNull()
      .default(false),
    supportsVision: integer('supports_vision', { mode: 'boolean' })
      .notNull()
      .default(false),
    raw: text('raw', { mode: 'json' }),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (t) => [
    index('wf_model_provider_idx').on(t.providerId),
    index('wf_model_enabled_idx').on(t.enabled),
  ],
)
