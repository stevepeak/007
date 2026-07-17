import {
  createContext,
  Fragment,
  useContext,
  type ReactNode,
} from 'react'
import { type LucideIcon } from 'lucide-react'

import { cn } from './cn'
import { WfLink } from './nav'

// Chrome for a page inside the tabbed workflow interface. The tab strip (see
// wf-tab-strip.tsx) is the top-level navigation now, so this shell adapts to
// where it renders:
//   • Inside an asset tab (WfShellAssetProvider) it shows a two-row header — a
//     slim breadcrumb trail (section / … / asset), then the asset's own title
//     (its editable name) with page actions flush-right — above the content.
//   • Anywhere else (the Home tab's hub + section lists) it renders just the
//     content: the tab strip already supplies the context, so no extra bar.
//
// Crumbs still describe the trail; a `home` crumb is dropped (Home is the tab)
// and an `editable` crumb doubles as the asset title.

export type WfCrumbEditable = {
  value: string
  onChange: (next: string) => void
  /** Commit the edit (blur / Enter). */
  onCommit: () => void
  ariaLabel?: string
  /** Shown when the value is empty (e.g. a derived default title). */
  placeholder?: string
}

type WfShellDescriptionEditable = {
  value: string
  onChange: (next: string) => void
  /** Commit the edit (blur / Enter). */
  onCommit: () => void
  ariaLabel?: string
  /** Shown when the value is empty. */
  placeholder?: string
}

export type WfCrumb = {
  /** Crumb text. Omitted for `home` (icon) and `editable` (field) crumbs. */
  label?: ReactNode
  /** Path relative to `basePath`; omit for the current (non-link) page. */
  to?: string
  /** Legacy flag: the root Home crumb. Dropped now that Home is a tab. */
  home?: boolean
  /** Render this crumb as the asset's inline-editable title. */
  editable?: WfCrumbEditable
  /** Asset-type label shown in gray before the icon, e.g. "Goal". */
  assetLabel?: ReactNode
  /** Optional leading icon (e.g. a section marker). */
  icon?: LucideIcon
  /** Tailwind color class for `icon`, e.g. "text-rose-500". */
  iconClassName?: string
}

// True inside an asset tab pane. Set by wf-app.tsx around each asset route so
// the shell knows to render its breadcrumb/title header.
const WfShellAssetContext = createContext(false)

export function WfShellAssetProvider({ children }: { children: ReactNode }) {
  return (
    <WfShellAssetContext.Provider value={true}>
      {children}
    </WfShellAssetContext.Provider>
  )
}

export type WfShellProps = {
  crumbs: WfCrumb[]
  children: ReactNode
  className?: string
  /** Page controls rendered flush-right on the title row. */
  actions?: ReactNode
  /** Icon shown before the asset title. Overrides the leaf crumb's icon. */
  titleIcon?: ReactNode
  /** Asset-type label shown in gray between the icon and the title, e.g. "Agent". */
  assetLabel?: ReactNode
  /** One-line asset description shown under the title (static). */
  description?: ReactNode
  /** Editable description under the title; takes precedence over `description`. */
  descriptionEditable?: WfShellDescriptionEditable
  /** When set, the content area scrolls; otherwise it flexes to fill. */
  scroll?: boolean
}

export function WfShell({
  crumbs,
  children,
  className,
  actions,
  titleIcon,
  assetLabel,
  description,
  descriptionEditable,
  scroll,
}: WfShellProps) {
  const inAsset = useContext(WfShellAssetContext)

  // Home tab (hub + section lists): no chrome bar — the tab strip is the header.
  if (!inAsset) {
    return (
      <div className={cn('flex h-full flex-col', className)}>
        <div className={cn('min-h-0 flex-1', scroll && 'overflow-y-auto')}>
          {children}
        </div>
      </div>
    )
  }

  // Asset tab. Uniform header for every asset:
  //   [ breadcrumb — parent assets only, omitted when there are none ]
  //   [ icon ] Title                                          [ actions ]
  //   [ description ]
  // The leaf crumb is the asset itself (its editable name doubles as the title).
  const items = crumbs.filter((c) => !c.home)
  const leaf = items[items.length - 1]
  const ancestors = items.slice(0, -1)
  const editable = leaf?.editable
  const icon =
    titleIcon ??
    (leaf?.icon ? (
      <leaf.icon className={cn('size-5 shrink-0', leaf.iconClassName)} />
    ) : null)

  return (
    <div className={cn('flex h-full flex-col', className)}>
      <div className="space-y-1 border-b border-neutral-200 px-4 py-3">
        {ancestors.length > 0 ? (
          <div className="flex items-center gap-1.5">
            {ancestors.map((crumb, i) => (
              <Fragment key={i}>
                {i > 0 ? <span className="text-neutral-300">/</span> : null}
                <TrailCrumb crumb={crumb} isLast={false} />
              </Fragment>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          {assetLabel ? (
            <span className="shrink-0 text-lg font-normal text-neutral-400">
              {assetLabel}
            </span>
          ) : null}
          {icon}
          {editable ? (
            <EditableTitle editable={editable} />
          ) : leaf ? (
            <span className="min-w-0 truncate text-lg font-semibold text-neutral-900">
              {leaf.label}
            </span>
          ) : null}
          {actions ? (
            <div className="ml-auto flex items-center gap-2">{actions}</div>
          ) : null}
        </div>
        {descriptionEditable ? (
          <EditableDescription editable={descriptionEditable} />
        ) : description ? (
          <p className="text-sm text-neutral-500">{description}</p>
        ) : null}
      </div>
      <div className={cn('min-h-0 flex-1', scroll && 'overflow-y-auto')}>
        {children}
      </div>
    </div>
  )
}

// A crumb in the breadcrumb trail. An editable crumb shows as static text here
// (its input lives in the title row below); linked crumbs stay SPA links. Any
// crumb may carry a leading (colored) icon.
function TrailCrumb({ crumb, isLast }: { crumb: WfCrumb; isLast: boolean }) {
  const text = crumb.editable ? crumb.editable.value || 'Untitled' : undefined
  const inner = (
    <span className="inline-flex items-center gap-1.5">
      {crumb.assetLabel ? (
        <span className="text-neutral-400">{crumb.assetLabel}</span>
      ) : null}
      {crumb.icon ? (
        <crumb.icon className={cn('size-3.5', crumb.iconClassName)} />
      ) : null}
      {text ?? crumb.label}
    </span>
  )

  if (crumb.to && !isLast && !crumb.editable) {
    return (
      <WfLink to={crumb.to} className="text-xs text-neutral-400 hover:underline">
        {inner}
      </WfLink>
    )
  }

  return (
    <span
      className={cn(
        'text-xs',
        isLast ? 'font-medium text-neutral-600' : 'text-neutral-400',
      )}
    >
      {inner}
    </span>
  )
}

// The asset's editable name, rendered as the page title. The field widens to fit
// its content — via the `size` attribute (chars) — up to a 50-char ceiling, past
// which it stops growing and scrolls internally.
const TITLE_MAX_CHARS = 50

function EditableTitle({ editable }: { editable: WfCrumbEditable }) {
  const { value, onChange, onCommit, ariaLabel, placeholder } = editable
  const size = Math.min(
    TITLE_MAX_CHARS,
    Math.max((value || placeholder || '').length + 1, 8),
  )
  return (
    <input
      value={value}
      size={size}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
      }}
      className="min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 text-base font-semibold text-neutral-900 outline-none placeholder:font-normal placeholder:text-neutral-400 hover:border-neutral-200 focus:border-neutral-300 focus:bg-neutral-50"
    />
  )
}

// The asset's editable one-line description, rendered under the title. Grows to
// one line by default; commits on blur (same contract as the title).
function EditableDescription({
  editable,
}: {
  editable: WfShellDescriptionEditable
}) {
  const { value, onChange, onCommit, placeholder, ariaLabel } = editable
  return (
    <textarea
      value={value}
      rows={1}
      aria-label={ariaLabel}
      placeholder={placeholder ?? 'Add a description…'}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      className="w-full resize-none rounded border border-transparent bg-transparent px-1 py-0.5 text-sm text-neutral-500 outline-none placeholder:text-neutral-300 hover:border-neutral-200 focus:border-neutral-300 focus:bg-neutral-50"
    />
  )
}
