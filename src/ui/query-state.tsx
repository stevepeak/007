import type { ReactNode } from 'react'

// The loading → error → empty → content ladder that every data-backed 007
// surface hand-rolls the same way. Each site owns its exact copy + styling by
// passing the already-rendered nodes; this only sequences them off a react-query
// result. Two shapes converge here:
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

export type QueryStateProps<T> = {
  /** A react-query result, or any object exposing `isLoading`/`error`/`data`. */
  query: QueryLike<T>
  /** Shown while the query is pending. */
  loading: ReactNode
  /** Shown on error, with the thrown error. */
  error: (error: Error) => ReactNode
  /** True when the loaded data should render `empty` instead of `children`. */
  isEmpty?: (data: T | null | undefined) => boolean
  /** Shown when the data is missing or `isEmpty` matches. */
  empty?: ReactNode
  /** Renders the loaded, non-empty data. Omit to render nothing on success. */
  children?: (data: NonNullable<T>) => ReactNode
}

export function QueryState<T>({
  query,
  loading,
  error,
  isEmpty,
  empty,
  children,
}: QueryStateProps<T>): ReactNode {
  if (query.isLoading) return loading
  if (query.error) return error(query.error as Error)
  const { data } = query
  if (data == null || (isEmpty?.(data) ?? false)) return empty ?? null
  return children ? children(data) : null
}
