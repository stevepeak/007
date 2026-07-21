import { Braces, CircleDashed, Eye, Sparkles, Wrench } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'

import type {
  EvalCheck,
  ModelCapabilities,
  WfEvalRunSummary,
} from '../../server/protocol'
import { cn } from '../cn'
import { Tooltip } from '../tooltip'
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

// ── Model capability badges ──────────────────────────────────────────────────
// Compact icon pills for what a model supports (tool calling, reasoning, vision,
// structured output). Shown on the Models page and in the model picker. Icons
// only (with a title tooltip) so a row of them stays narrow.

const CAPABILITY_META = [
  { key: 'tools', label: 'Tool calling', icon: Wrench },
  { key: 'reasoning', label: 'Reasoning', icon: Sparkles },
  { key: 'vision', label: 'Vision', icon: Eye },
  { key: 'structuredOutput', label: 'Structured output', icon: Braces },
] as const

export function CapabilityBadges({
  capabilities,
  only,
  className,
}: {
  capabilities: ModelCapabilities | undefined
  /** Restrict to a subset of capabilities (e.g. just the ones a picker gates on). */
  only?: ReadonlyArray<keyof ModelCapabilities>
  className?: string
}) {
  if (!capabilities) return null
  const shown = CAPABILITY_META.filter(
    (c) => capabilities[c.key] && (!only || only.includes(c.key)),
  )
  if (shown.length === 0) return null
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {shown.map(({ key, label, icon: Icon }) => (
        <Tooltip key={key} content={label}>
          <span className="inline-flex items-center rounded bg-neutral-100 p-0.5 text-neutral-500">
            <Icon className="size-3" />
          </span>
        </Tooltip>
      ))}
    </span>
  )
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
  if (check.label?.trim()) return check.label.trim()
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

export function RunStatusBadge({ status }: { status: string }) {
  if (status === 'running' || status === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
        <CircleDashed className="size-3 animate-spin" />
        {status}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-medium',
        status === 'failed' || status === 'cancelled'
          ? 'bg-red-50 text-red-700'
          : 'bg-neutral-100 text-neutral-500',
      )}
    >
      {status}
    </span>
  )
}

// Shared "test runs" table: When / Pass / Score columns over a list of eval
// runs. Clicking a row opens its report via `onOpenRun`. The first cell defaults
// to a timestamp + RunStatusBadge; pass `renderFirstCell` for a richer cell
// (e.g. the goals list's subtitle line).
export function EvalRunsTable({
  runs,
  emptyMessage,
  loadingMessage,
  isLoading,
  onOpenRun,
  renderFirstCell,
}: {
  runs: WfEvalRunSummary[]
  emptyMessage: string
  loadingMessage?: string
  isLoading?: boolean
  onOpenRun: (runId: string, e: MouseEvent) => void
  renderFirstCell?: (run: WfEvalRunSummary) => ReactNode
}) {
  if (isLoading && loadingMessage) return <EmptyState message={loadingMessage} />
  if (runs.length === 0) return <EmptyState message={emptyMessage} />
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span>When</span>
        <span className="text-right">Pass</span>
        <span className="w-24 text-right">Score</span>
      </div>
      {runs.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={(e) => onOpenRun(r.id, e)}
          className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 px-4 py-3 text-left last:border-b-0 hover:bg-neutral-50"
        >
          {renderFirstCell ? (
            renderFirstCell(r)
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-neutral-700">
                {formatTimestamp(r.createdAt)}
              </span>
              <RunStatusBadge status={r.status} />
            </div>
          )}
          <div className="text-right">
            <PassRate passed={r.passed} total={r.total} />
          </div>
          <div className="w-24 text-right">
            <Score value={r.score} />
          </div>
        </button>
      ))}
    </div>
  )
}
