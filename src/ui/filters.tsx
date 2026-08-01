import { cn } from './cn'

// The filter / segmented-control family. Three flavours of the same "pick one
// of N labelled options" data model, kept as distinct exports because their
// affordances differ enough that one component with a variant union would be
// less legible than three small ones:
//   - `FilterSelect` — a compact native `<select>` dropdown (toolbar filters).
//   - `Segmented`     — a pill/segmented button track (mutually-exclusive tabs).
//   - `Tabs`          — an underline tab strip with optional count badges.
// Previously `FilterSelect` was copy-pasted in the models list and the eval
// results table, and `Segmented`/`Tabs` lived in separate feature files; this is
// their one home.

// ── FilterSelect ──────────────────────────────────────────────────────────────

/** A labelled native `<select>` — the compact dropdown used in filter toolbars. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-neutral-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 outline-none transition focus:border-neutral-400"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

// ── Segmented ─────────────────────────────────────────────────────────────────

/** A pill/segmented button track — mutually-exclusive options in a gray rail. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center rounded-md bg-neutral-100 p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded px-2.5 py-1 text-xs font-medium transition-colors',
            value === opt.value
              ? 'bg-white text-neutral-900 shadow-sm'
              : 'text-neutral-500 hover:text-neutral-900',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

export type TabDef = { key: string; label: string; count?: number }

/** An underline tab strip with optional per-tab count badges. */
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
