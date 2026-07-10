import { Home } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

import { cn } from './cn'
import { WfLink } from './nav'

// Shared breadcrumb chrome for the workflow interface — a thin header bar over a
// full-height content area. Each crumb with a `to` is a SPA link back up the
// tree; the last crumb is the current page. Crumbs come in three flavours:
//   • `home`     → a home icon linking to the root (always the first crumb)
//   • `editable` → an inline text field (e.g. the workflow name in the editor)
//   • plain      → a link (has `to`) or the current-page label (last crumb)
// `actions` renders page-level controls flush-right on the same bar.

export type WfCrumbEditable = {
  value: string
  onChange: (next: string) => void
  /** Commit the edit (blur / Enter). */
  onCommit: () => void
  ariaLabel?: string
}

export type WfCrumb = {
  /** Crumb text. Omitted for `home` (icon) and `editable` (field) crumbs. */
  label?: ReactNode
  /** Path relative to `basePath`; omit for the current (non-link) page. */
  to?: string
  /** Render this crumb as a home icon linking to `to` (defaults to the root). */
  home?: boolean
  /** Render this crumb as an inline-editable field. Takes over rendering. */
  editable?: WfCrumbEditable
}

export type WfShellProps = {
  crumbs: WfCrumb[]
  children: ReactNode
  className?: string
  /** Page controls rendered flush-right on the breadcrumb bar. */
  actions?: ReactNode
  /** When set, the content area scrolls; otherwise it flexes to fill. */
  scroll?: boolean
}

export function WfShell({
  crumbs,
  children,
  className,
  actions,
  scroll,
}: WfShellProps) {
  return (
    <div className={cn('flex h-full flex-col', className)}>
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2">
        {crumbs.map((crumb, i) => (
          <Fragment key={i}>
            {i > 0 ? <span className="text-neutral-300">/</span> : null}
            <Crumb crumb={crumb} isLast={i === crumbs.length - 1} />
          </Fragment>
        ))}
        {actions ? (
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        ) : null}
      </div>
      <div className={cn('min-h-0 flex-1', scroll && 'overflow-y-auto')}>
        {children}
      </div>
    </div>
  )
}

function Crumb({ crumb, isLast }: { crumb: WfCrumb; isLast: boolean }) {
  if (crumb.home) {
    return (
      <WfLink
        to={crumb.to ?? ''}
        aria-label="Home"
        className="flex items-center text-neutral-500 hover:text-neutral-800"
      >
        <Home className="size-4" />
      </WfLink>
    )
  }

  if (crumb.editable) {
    const { value, onChange, onCommit, ariaLabel } = crumb.editable
    return (
      <input
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
        }}
        className="min-w-0 max-w-xs rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-neutral-900 outline-none hover:border-neutral-200 focus:border-neutral-300 focus:bg-neutral-50"
      />
    )
  }

  if (crumb.to && !isLast) {
    return (
      <WfLink
        to={crumb.to}
        className="text-sm text-neutral-500 hover:underline"
      >
        {crumb.label}
      </WfLink>
    )
  }

  return (
    <span
      className={cn(
        'text-sm',
        isLast ? 'font-semibold text-neutral-900' : 'text-neutral-500',
      )}
    >
      {crumb.label}
    </span>
  )
}
