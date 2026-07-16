import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react'

import { useWfTabsOptional } from './wf-tabs'

// Framework-agnostic navigation for the workflow interface. The SDK never
// imports a router (it must stay whitelabel); the host injects the current
// location + a navigate function, and every internal link/route decision here
// is expressed as a path *relative to `basePath`* (`''` is the hub root).

export type WfNav = {
  /** Absolute mount point in the host app, e.g. `/wf`. No trailing slash. */
  basePath: string
  /** Current location relative to `basePath` — no leading slash. `''` = hub. */
  path: string
  /** Navigate to a path relative to `basePath` (may include a query string). */
  navigate: (to: string) => void
  /** Absolute href for a relative path — for real `<a>` fallbacks. */
  hrefFor: (to: string) => string
}

const WfNavContext = createContext<WfNav | null>(null)

export function useWfNav(): WfNav {
  const value = useContext(WfNavContext)
  if (!value) {
    throw new Error('wf-sdk navigation components must be used within <WfApp>.')
  }
  return value
}

export type WfNavProviderProps = {
  basePath: string
  path: string
  navigate: (to: string) => void
  children: ReactNode
}

export function WfNavProvider({
  basePath,
  path,
  navigate,
  children,
}: WfNavProviderProps) {
  const value = useMemo<WfNav>(() => {
    const base = basePath.replace(/\/$/, '')
    const rel = path.replace(/^\//, '')
    return {
      basePath: base,
      path: rel,
      navigate: (to) => navigate(to.replace(/^\//, '')),
      hrefFor: (to) => {
        const clean = to.replace(/^\//, '')
        return clean ? `${base}/${clean}` : base
      },
    }
  }, [basePath, path, navigate])
  return <WfNavContext.Provider value={value}>{children}</WfNavContext.Provider>
}

// Tab-aware navigation for non-anchor triggers (list/table row buttons, etc.).
// A plain activation follows the tab policy (replace the active asset tab, or a
// new tab when on Home); pass `newTab` — e.g. from a cmd/ctrl-click — to force a
// new tab. Mirrors what WfLink does for real anchors. Degrades to plain
// navigation outside a tabs provider.
export function useOpenAsset(): (
  to: string,
  opts?: { newTab?: boolean },
) => void {
  const { navigate } = useWfNav()
  const tabs = useWfTabsOptional()
  return useCallback(
    (to, opts) => {
      if (tabs) tabs.openAsset(to, opts)
      else navigate(to)
    },
    [tabs, navigate],
  )
}

export type WfLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'href'
> & {
  /** Destination relative to `basePath` (`''` = hub). */
  to: string
}

// A link that renders a real anchor (so middle-click / SEO work) but hands
// clicks to the tab-aware navigation. A plain left-click opens the destination
// following the tab policy (replace the current asset tab, or a new tab from
// Home); cmd/ctrl-click always opens it in a NEW tab.
export function WfLink({ to, onClick, ...rest }: WfLinkProps) {
  const { navigate, hrefFor } = useWfNav()
  const tabs = useWfTabsOptional()
  return (
    <a
      href={hrefFor(to)}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented || (rest.target && rest.target !== '_self')) {
          return
        }
        // Shift/alt/middle/non-primary → let the browser handle it.
        if (e.button !== 0 || e.shiftKey || e.altKey) return
        e.preventDefault()
        const newTab = e.metaKey || e.ctrlKey
        if (tabs) tabs.openAsset(to, { newTab })
        else navigate(to)
      }}
      {...rest}
    />
  )
}
