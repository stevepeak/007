import { cn } from './cn'

// Placeholder for wf sections that are navigable but not yet built. Keeps the
// hub's cards from dead-ending while the real interfaces are implemented.
export type ComingSoonProps = {
  title: string
  description: string
  className?: string
}

export function ComingSoon({ title, description, className }: ComingSoonProps) {
  return (
    <div className={cn('mx-auto max-w-2xl space-y-3 p-6', className)}>
      <h1 className="text-lg font-semibold text-neutral-900">{title}</h1>
      <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-6 text-sm text-neutral-500">
        <p className="font-medium text-neutral-700">Coming soon</p>
        <p className="mt-1">{description}</p>
      </div>
    </div>
  )
}
