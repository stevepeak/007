import {
  createContext,
  useContext,
  useMemo,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react'

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

export type WfLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'href'
> & {
  /** Destination relative to `basePath` (`''` = hub). */
  to: string
}

// A link that renders a real anchor (so middle-click / cmd-click / SEO work)
// but hands plain left-clicks to the injected `navigate` for SPA transitions.
export function WfLink({ to, onClick, ...rest }: WfLinkProps) {
  const { navigate, hrefFor } = useWfNav()
  return (
    <a
      href={hrefFor(to)}
      onClick={(e) => {
        onClick?.(e)
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey ||
          (rest.target && rest.target !== '_self')
        ) {
          return
        }
        e.preventDefault()
        navigate(to)
      }}
      {...rest}
    />
  )
}
