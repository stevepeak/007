/** The dashed placeholder box a list or panel shows when it has nothing to render. */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-500">
      {message}
    </div>
  )
}
