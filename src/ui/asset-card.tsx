import type { ReactNode } from 'react'

import { WfLink } from './nav'

// The card a catalog page (agents, tools) shows per asset: avatar and name, an
// optional eyebrow above the name, a two-line description, and an optional
// footer. `to` makes it a tab-aware link; `onClick` a plain button.

export type AssetCardProps = {
  avatar: ReactNode
  /** Small muted line above the title (e.g. the asset's kind). */
  eyebrow?: ReactNode
  /** Tooltip on the eyebrow. */
  eyebrowTitle?: string
  title: string
  description: string | null | undefined
  /** Rendered in a two-column grid under a divider. */
  footer?: ReactNode
} & ({ to: string; onClick?: never } | { onClick: () => void; to?: never })

const CARD_CLASS =
  'flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-left transition duration-200 hover:border-neutral-300 hover:shadow-md'

export function AssetCard({
  avatar,
  eyebrow,
  eyebrowTitle,
  title,
  description,
  footer,
  to,
  onClick,
}: AssetCardProps) {
  const body = (
    <>
      <div className="flex w-full items-center gap-3">
        {avatar}
        <span className="flex min-w-0 flex-1 flex-col">
          {eyebrow ? (
            <span className="text-xs text-neutral-500" title={eyebrowTitle}>
              {eyebrow}
            </span>
          ) : null}
          <span className="truncate text-base font-medium text-neutral-900">
            {title}
          </span>
        </span>
      </div>
      <p className="line-clamp-2 min-h-[2.5rem] text-sm text-neutral-500">
        {description || 'No description yet.'}
      </p>
      {footer ? (
        <div className="grid w-full grid-cols-2 gap-4 border-t border-neutral-100 pt-3">
          {footer}
        </div>
      ) : null}
    </>
  )
  return to != null ? (
    <WfLink to={to} className={CARD_CLASS}>
      {body}
    </WfLink>
  ) : (
    <button type="button" onClick={onClick} className={CARD_CLASS}>
      {body}
    </button>
  )
}
