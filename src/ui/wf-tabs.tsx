import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { isAssetPath } from './wf-tab-routes'

// Browser-style tab state for the 007 surface, layered on the injected
// `path`/`navigate` contract (the SDK stays framework-free — the host owns the
// URL). A tab is a container that can show different assets over its lifetime
// (like a browser tab navigating between pages), so ids are stable and the path
// is mutable.
//
// Navigation policy:
//   • On the Home tab, opening an asset creates a NEW tab (Home is never
//     replaced).
//   • Inside an asset tab, a plain click REPLACES that tab's asset (same tab).
//   • cmd/ctrl-click always opens a NEW tab.
// The active tab's path is kept in sync with the URL; open tabs (and the Home
// sub-path) persist to localStorage. Keep-alive rendering lives in wf-app.tsx.

export const HOME_TAB_ID = 'home'

/** One open asset tab. `id` is stable for the tab's lifetime; `path` is the
 * asset it currently shows (mutable — a plain click navigates it in place). */
export type WfTab = { id: string; path: string }

export type WfTabsState = {
  /** Open asset tabs, in strip order (Home is implicit, always first). */
  tabs: WfTab[]
  /** `HOME_TAB_ID` or an asset tab id. */
  activeId: string
  /** The Home tab's current sub-path (`''` = hub). */
  homePath: string
  /**
   * Open an asset. Plain (`newTab` false) follows the policy above; `newTab`
   * forces a new tab. Non-asset paths are treated as Home navigation.
   */
  openAsset: (to: string, opts?: { newTab?: boolean }) => void
  /** Close an asset tab; if it was active, focus falls back to a neighbor/Home. */
  closeTab: (id: string) => void
  /** Close every asset tab and return focus to Home. */
  closeAllTabs: () => void
  /** Focus an existing tab. Focusing Home always returns to the hub root. */
  activateTab: (id: string) => void
}

const WfTabsContext = createContext<WfTabsState | null>(null)

export function useWfTabs(): WfTabsState {
  const value = useContext(WfTabsContext)
  if (!value) {
    throw new Error('useWfTabs must be used within <WfTabsProvider>.')
  }
  return value
}

/** Tab state if available, else `null` — for components that may render outside
 * a provider (e.g. `WfLink`, which degrades to plain browser navigation). */
export function useWfTabsOptional(): WfTabsState | null {
  return useContext(WfTabsContext)
}

// --- persistence -----------------------------------------------------------

const STORAGE_KEY = 'wf-sdk:tabs'
type StoredTabs = { tabs: WfTab[]; homePath: string; activeId: string }

function readStored(): StoredTabs | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredTabs>
    if (!parsed || !Array.isArray(parsed.tabs)) return null
    const tabs = parsed.tabs.filter(
      (t): t is WfTab =>
        !!t && typeof t.id === 'string' && typeof t.path === 'string',
    )
    return {
      tabs,
      homePath: typeof parsed.homePath === 'string' ? parsed.homePath : '',
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : HOME_TAB_ID,
    }
  } catch {
    return null
  }
}

function writeStored(state: StoredTabs): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // storage full / unavailable — best-effort only
  }
}

/** Highest numeric suffix across `t<n>` ids, for seeding the id counter. */
function maxIdNum(tabs: WfTab[]): number {
  return tabs.reduce((max, t) => {
    const n = Number(t.id.replace(/^t/, ''))
    return Number.isInteger(n) && n > max ? n : max
  }, 0)
}

type Init = {
  tabs: WfTab[]
  homePath: string
  activeId: string
  counter: number
}

// Reconcile persisted tabs with the initial URL: an asset URL ensures+activates
// its tab; a home URL activates Home and remembers the sub-path.
function computeInit(path: string, stored: StoredTabs | null): Init {
  let tabs = stored?.tabs ?? []
  let homePath = stored?.homePath ?? ''
  let counter = maxIdNum(tabs)
  let activeId: string

  if (isAssetPath(path)) {
    const existing = tabs.find((t) => t.path === path)
    if (existing) {
      activeId = existing.id
    } else {
      counter += 1
      const id = `t${counter}`
      tabs = [...tabs, { id, path }]
      activeId = id
    }
  } else {
    homePath = path
    activeId = HOME_TAB_ID
  }

  return { tabs, homePath, activeId, counter }
}

// --- provider --------------------------------------------------------------

export type WfTabsProviderProps = {
  /** Current location relative to basePath (from the host, no query). */
  path: string
  /** Navigate to a path relative to basePath. */
  navigate: (to: string) => void
  children: ReactNode
}

export function WfTabsProvider({ path, navigate, children }: WfTabsProviderProps) {
  const [init] = useState<Init>(() => computeInit(path, readStored()))
  const [tabs, setTabs] = useState<WfTab[]>(init.tabs)
  const [homePath, setHomePath] = useState<string>(init.homePath)
  const [activeId, setActiveId] = useState<string>(init.activeId)
  const idCounter = useRef(init.counter)
  // The URL we last drove ourselves — lets the reconcile effect ignore our own
  // navigations and react only to external ones (initial load, back/forward).
  const expectedPath = useRef(path)
  // Latest tabs/active read inside the path-only effect without making it a dep
  // (else our own tab mutations would re-fire it before the URL catches up).
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  const genId = useCallback(() => {
    idCounter.current += 1
    return `t${idCounter.current}`
  }, [])

  // Reconcile external URL changes only (browser back/forward, deep links). Our
  // own navigations set `expectedPath` first and are skipped here.
  useEffect(() => {
    if (path === expectedPath.current) return
    expectedPath.current = path
    if (!isAssetPath(path)) {
      setHomePath(path)
      setActiveId(HOME_TAB_ID)
      return
    }
    const existing = tabsRef.current.find((t) => t.path === path)
    if (existing) {
      setActiveId(existing.id)
      return
    }
    if (activeIdRef.current !== HOME_TAB_ID) {
      const aid = activeIdRef.current
      setTabs((prev) => prev.map((t) => (t.id === aid ? { ...t, path } : t)))
      return
    }
    const id = genId()
    setTabs((prev) => [...prev, { id, path }])
    setActiveId(id)
  }, [path, genId])

  useEffect(() => {
    writeStored({ tabs, homePath, activeId })
  }, [tabs, homePath, activeId])

  const openAsset = useCallback(
    (to: string, opts?: { newTab?: boolean }) => {
      expectedPath.current = to
      if (!isAssetPath(to)) {
        // Home navigation.
        setHomePath(to)
        setActiveId(HOME_TAB_ID)
        navigate(to)
        return
      }
      if (opts?.newTab || activeId === HOME_TAB_ID) {
        const id = genId()
        setTabs((prev) => [...prev, { id, path: to }])
        setActiveId(id)
      } else {
        // Replace the active tab's asset in place.
        setTabs((prev) =>
          prev.map((t) => (t.id === activeId ? { ...t, path: to } : t)),
        )
      }
      navigate(to)
    },
    [activeId, navigate, genId],
  )

  const activateTab = useCallback(
    (id: string) => {
      if (id === HOME_TAB_ID) {
        // 007 always returns to the hub root.
        expectedPath.current = ''
        setHomePath('')
        setActiveId(HOME_TAB_ID)
        navigate('')
        return
      }
      const tab = tabs.find((t) => t.id === id)
      if (!tab) return
      expectedPath.current = tab.path
      setActiveId(id)
      navigate(tab.path)
    },
    [tabs, navigate],
  )

  const closeTab = useCallback(
    (id: string) => {
      const idx = tabs.findIndex((t) => t.id === id)
      if (idx === -1) return
      const next = tabs.filter((t) => t.id !== id)
      setTabs(next)
      if (id !== activeId) return
      const fallback = next[idx - 1] ?? next[idx] ?? null
      if (fallback) {
        expectedPath.current = fallback.path
        setActiveId(fallback.id)
        navigate(fallback.path)
      } else {
        expectedPath.current = homePath
        setActiveId(HOME_TAB_ID)
        navigate(homePath)
      }
    },
    [tabs, activeId, homePath, navigate],
  )

  const closeAllTabs = useCallback(() => {
    if (tabs.length === 0) return
    setTabs([])
    expectedPath.current = homePath
    setActiveId(HOME_TAB_ID)
    navigate(homePath)
  }, [tabs, homePath, navigate])

  const value = useMemo<WfTabsState>(
    () => ({ tabs, activeId, homePath, openAsset, closeTab, closeAllTabs, activateTab }),
    [tabs, activeId, homePath, openAsset, closeTab, closeAllTabs, activateTab],
  )

  return <WfTabsContext.Provider value={value}>{children}</WfTabsContext.Provider>
}
