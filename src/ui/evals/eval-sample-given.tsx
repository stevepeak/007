import { Plus, X } from 'lucide-react'

import { useWfComponents } from '../context'
import { useAgents } from '../hooks'
import { useCommittedField } from '../use-committed-field'

// The "Given" is the initial state a sample runs from — the values the goal's
// agent is invoked with. When the target agent declares input variables (the
// `${vars}` its published prompt requires), we render one value field per
// variable. Absent a schema, it falls back to a free-form key/value editor. Both
// map to initialCondition.promptVariables.
export function GivenEditor({
  targetId,
  value,
  onChange,
}: {
  targetId: string
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}) {
  const { Input, Button } = useWfComponents()
  const agentsQuery = useAgents()
  const agent = agentsQuery.data?.find((a) => a.id === targetId)
  const fields = agent?.inputVariables ?? []

  // Local mirror so typing is smooth; commit up on blur.
  const field = useCommittedField(value, onChange, JSON.stringify)

  // Schema-driven: one value input per declared variable.
  if (fields.length > 0) {
    return (
      <div className="space-y-2">
        <p className="px-1 text-xs text-neutral-400">
          Inputs required by{' '}
          <span className="font-medium text-neutral-500">
            {agent?.name ?? 'the target agent'}
          </span>{' '}
          — fill in the values this sample runs from.
        </p>
        {fields.map((f) => (
          <div key={f} className="flex items-center gap-2">
            <span
              title={f}
              className="w-40 shrink-0 truncate rounded bg-neutral-100 px-2 py-1.5 font-mono text-xs text-neutral-600"
            >
              {f}
            </span>
            <Input
              value={field.value[f] ?? ''}
              placeholder="value"
              onChange={(e) =>
                field.onChange({ ...field.value, [f]: e.target.value })
              }
              onBlur={field.onBlur}
              className="h-8 flex-1 font-mono text-xs"
            />
          </div>
        ))}
      </div>
    )
  }

  // Fallback: no target, or the agent has no declared inputs — free-form pairs.
  const entries = Object.entries(field.value)
  const setKey = (oldKey: string, newKey: string) => {
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(field.value))
      next[k === oldKey ? newKey : k] = v
    field.onChange(next)
  }
  const remove = (k: string) => {
    const next = { ...field.value }
    delete next[k]
    field.commit(next)
  }
  return (
    <div className="space-y-2">
      <p className="px-1 py-1 text-xs text-neutral-400">
        {targetId
          ? 'The target agent has no declared input variables — add initial state manually.'
          : 'This goal has no target agent yet — set one on the goal, or add state manually.'}
      </p>
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={k}
            placeholder="field"
            onChange={(e) => setKey(k, e.target.value)}
            onBlur={field.onBlur}
            className="h-8 w-40 font-mono text-xs"
          />
          <Input
            value={v}
            placeholder="value"
            onChange={(e) =>
              field.onChange({ ...field.value, [k]: e.target.value })
            }
            onBlur={field.onBlur}
            className="h-8 flex-1 font-mono text-xs"
          />
          <button
            type="button"
            aria-label="Remove"
            onClick={() => remove(k)}
            className="text-neutral-300 transition hover:text-neutral-600"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => field.onChange({ ...field.value, '': '' })}
      >
        <Plus className="size-4" />
        Add field
      </Button>
    </div>
  )
}
