import type { ReactNode } from 'react'

import { cn } from './cn'

// The loading → error → empty → content ladder that every data-backed 007
// surface hand-rolls the same way. This sequences the states off a react-query
// result; each site keeps control of the copy by passing rendered nodes, and
// omits the ones where the house default is already right. Two shapes converge
// here:
//   • early-return pages (editors, run viewers) pass `children` and render the
//     loaded content in place of the ladder;
//   • list pages render their states inline ALONGSIDE always-present chrome, so
//     they omit `children` — on success the wrapper renders nothing and the
//     page's own grid (a sibling) shows the data.

/** The react-query fields this wrapper reads (a full query result satisfies it). */
export type QueryLike<T> = {
  isLoading: boolean
  error: unknown
  data: T | null | undefined
}

/** The house loading line. Overridable per site via the `loading` prop. */
const DEFAULT_LOADING = (
  <div className="text-sm text-neutral-500">Loading…</div>
)

/** The house error box. Overridable per site via the `error` prop. */
function defaultError(error: Error): ReactNode {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      {error.message}
    </div>
  )
}

export type QueryStateProps<T> = {
  /** A react-query result, or any object exposing `isLoading`/`error`/`data`. */
  query: QueryLike<T>
  /** Shown while the query is pending with nothing to show. Defaults to `Loading…`. */
  loading?: ReactNode
  /** Shown on error, with the thrown error. Defaults to the house error box. */
  error?: (error: Error) => ReactNode
  /** True when the loaded data should render `empty` instead of `children`. */
  isEmpty?: (data: T | null | undefined) => boolean
  /** Shown when the data is missing or `isEmpty` matches. */
  empty?: ReactNode
  /** Renders the loaded, non-empty data. Omit to render nothing on success. */
  children?: (data: NonNullable<T>) => ReactNode
}

export function QueryState<T>({
  query,
  loading = DEFAULT_LOADING,
  error = defaultError,
  isEmpty,
  empty,
  children,
}: QueryStateProps<T>): ReactNode {
  const { data } = query
  // `&& data == null` is what makes a refetch hold the last good render instead
  // of flashing a spinner over content the user is already reading. For a real
  // react-query result this is redundant (`isLoading` is false once data
  // exists), but it is what the hand-rolled `isLoading && !data` ladders meant,
  // so stating it here lets them convert without changing behaviour.
  if (query.isLoading && data == null) return loading
  if (query.error) return error(query.error as Error)
  if (data == null || (isEmpty?.(data) ?? false)) return empty ?? null
  return children ? children(data) : null
}

export type PageQueryStateProps<T> = Pick<
  QueryStateProps<T>,
  'query' | 'isEmpty' | 'error' | 'children'
> & {
  /** Merged onto every state block, so it sizes like the page it stands in for. */
  className?: string
  /** Inset of the state blocks. Editors sit in `p-4` chrome, full pages in `p-6`. */
  padding?: 'p-4' | 'p-6'
  /** The loading line. Defaults to `Loading…`. */
  loadingText?: ReactNode
  /** The missing / `isEmpty` line. */
  emptyText: ReactNode
}

/**
 * `QueryState` for a component that owns a whole page or editor: loading, error
 * and empty all render as one padded line in place of the content.
 */
export function PageQueryState<T>({
  className,
  padding = 'p-4',
  loadingText = 'Loading…',
  emptyText,
  error,
  ...rest
}: PageQueryStateProps<T>): ReactNode {
  const muted = cn(padding, 'text-sm text-neutral-500', className)
  return (
    <QueryState
      {...rest}
      loading={<div className={muted}>{loadingText}</div>}
      error={
        error ??
        ((e) => (
          <div className={cn(padding, 'text-sm text-red-600', className)}>
            {e.message}
          </div>
        ))
      }
      empty={<div className={muted}>{emptyText}</div>}
    />
  )
}

/**
 * `QueryState` for a list page, whose grid renders as a sibling: it shows only
 * the loading, error and empty states, and nothing once the data is in. A list
 * that fails to load is almost always a lost session, so the error says so.
 */
export function ListQueryState<T>({
  query,
  isEmpty,
  empty,
}: Pick<QueryStateProps<T>, 'query' | 'isEmpty' | 'empty'>): ReactNode {
  return (
    <QueryState
      query={query}
      error={(error) => (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error.message} — are you signed in?
        </div>
      )}
      isEmpty={isEmpty}
      empty={empty}
    />
  )
}

/**
 * The name of an entity that has to be looked up in a separate query — an
 * agent id rendered as its title, say. Three states, one line: the resolved
 * name, `Loading…` while the lookup is in flight, or a fallback once it has
 * landed and the id matched nothing.
 *
 * Distinct from `QueryState`: this is an inline LABEL inside otherwise-loaded
 * chrome, not a ladder that owns its region of the page.
 */
export function pendingLabel(
  query: { isLoading: boolean },
  name: string | null | undefined,
  fallback: string,
): string {
  return name ?? (query.isLoading ? 'Loading…' : fallback)
}
