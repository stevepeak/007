import type { EvalCheck } from '../../server/protocol'
import { cn } from '../cn'
import { getProvider, ProviderLogo } from './provider-logos'

// Small presentational bits shared across the Evals catalog, set, sample, and
// test pages. All real-data — nothing here depends on the (deleted) mock store.

export function PassRate({
  passed,
  total,
}: {
  passed: number
  total: number
}) {
  const ok = total > 0 && passed === total
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums',
        ok ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
      )}
    >
      {passed}/{total}
      <span className="ml-1">{ok ? '✓' : '✗'}</span>
    </span>
  )
}

/** Judge-only score, 0..1. Renders "—" when there are no scored checks. */
export function Score({ value }: { value: number | null }) {
  return (
    <span className="text-sm tabular-nums text-neutral-700">
      {value == null ? '—' : value.toFixed(2)}
    </span>
  )
}

/** Tag for a test's family — binary (pass/fail) or scored (judged). */
export function FamilyTag({ scored }: { scored: boolean }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        scored
          ? 'bg-amber-50 text-amber-700'
          : 'bg-neutral-100 text-neutral-500',
      )}
    >
      {scored ? 'scored' : 'binary'}
    </span>
  )
}

// ── Model brand marks ────────────────────────────────────────────────────────
// A best-effort vendor tag for a model, used to render a colored logomark next
// to a model name (in the model picker and anywhere models are listed).

export type ModelBrand =
  | 'openai'
  | 'anthropic'
  | 'venice'
  | 'openrouter'
  | 'google'
  | 'meta'
  | 'mistral'
  | 'qwen'
  | 'deepseek'

/**
 * Colored monogram fallback for vendors we don't ship a real logo for. Brands
 * with a logomark (openai, anthropic, venice, openrouter) are handled by
 * ProviderLogo in BrandMark below and never hit this table.
 */
const BRAND_MARK: Partial<
  Record<ModelBrand, { label: string; className: string }>
> = {
  google: { label: 'G', className: 'bg-blue-100 text-blue-700' },
  meta: { label: 'M', className: 'bg-indigo-100 text-indigo-700' },
  mistral: { label: 'Mi', className: 'bg-rose-100 text-rose-700' },
  qwen: { label: 'Qw', className: 'bg-purple-100 text-purple-700' },
  deepseek: { label: 'Ds', className: 'bg-cyan-100 text-cyan-700' },
}

export function BrandMark({
  brand,
  fallback,
}: {
  brand?: ModelBrand | null
  /** Text (e.g. the model name) to derive a neutral mark from when brand is unknown. */
  fallback?: string
}) {
  // Prefer the real vendor logomark when we have one.
  const provider = getProvider(brand)
  if (provider) return <ProviderLogo id={provider.id} />

  const b = brand ? BRAND_MARK[brand] : undefined
  const label = b?.label ?? (fallback?.trim()?.slice(0, 2) || '··')
  return (
    <span
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-bold',
        b?.className ?? 'bg-neutral-100 text-neutral-500',
      )}
    >
      {label}
    </span>
  )
}

/**
 * Best-effort vendor guess from a model id/name, so a bare model option (which
 * carries no brand) still gets a colored mark. Returns undefined when nothing
 * matches — the caller then renders a neutral fallback.
 */
export function inferModelBrand(idOrLabel: string): ModelBrand | undefined {
  const t = idOrLabel.toLowerCase()
  if (t.includes('claude') || t.includes('anthropic')) return 'anthropic'
  if (t.includes('gpt') || t.includes('openai') || /\bo[134]\b/.test(t)) return 'openai'
  if (t.includes('venice')) return 'venice'
  if (t.includes('openrouter')) return 'openrouter'
  if (t.includes('gemini') || t.includes('google')) return 'google'
  if (t.includes('llama') || t.includes('meta')) return 'meta'
  if (t.includes('qwen')) return 'qwen'
  if (t.includes('deepseek')) return 'deepseek'
  if (t.includes('mistral') || t.includes('mixtral')) return 'mistral'
  return undefined
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-500">
      {message}
    </div>
  )
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export type TabDef = { key: string; label: string; count?: number }

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="flex items-center gap-1 border-b border-neutral-200">
      {tabs.map((t) => {
        const on = t.key === active
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              on
                ? 'border-neutral-900 text-neutral-900'
                : 'border-transparent text-neutral-500 hover:text-neutral-800',
            )}
          >
            {t.label}
            {t.count != null ? (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[11px] font-medium',
                  on
                    ? 'bg-neutral-900 text-white'
                    : 'bg-neutral-100 text-neutral-500',
                )}
              >
                {t.count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// A short human phrasing of what a check asserts — the label shown for a Test in
// the sample's test list and in the run report. Kept here so both surfaces agree.
export function describeCheck(check: EvalCheck | undefined): string {
  if (!check) return 'check'
  switch (check.type) {
    case 'tool_called':
      return `${check.toolId || 'tool'} ${check.called ? 'called' : 'not called'}`
    case 'tool_args_match':
      return `${check.toolId || 'tool'} args${check.path ? `.${check.path}` : ''} ${check.match}`
    case 'node_visited':
      return `node ${check.nodeId || '?'} ${check.visited ? 'visited' : 'not visited'}`
    case 'node_input_match':
      return `node ${check.nodeId || '?'} input${check.path ? `.${check.path}` : ''} ${check.match}`
    case 'output_match':
      return `output${check.path ? `.${check.path}` : ''} ${check.match}`
    case 'llm_judge':
      return check.rubric
        ? `judge: ${check.rubric.slice(0, 60)}${check.rubric.length > 60 ? '…' : ''}`
        : 'judge'
  }
}
