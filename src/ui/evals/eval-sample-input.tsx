import { Plus, X } from 'lucide-react'

import type { EvalSampleInput } from '../../server/protocol'
import { useWfComponents } from '../context'
import { useAgents } from '../hooks'
import { useCommittedField } from '../use-committed-field'

import { ConversationEditor } from './eval-sample-conversation'

// A Sample's INPUT — what the target is invoked with. One editor, chosen by the
// TARGET's own input contract, so a sample never shows two competing input
// sources:
//
//   • task         — the values the agent's `${vars}` resolve to. Input → output.
//   • conversation — the thread the agent answers, plus any `${vars}` its system
//                    prompt still interpolates.
//
// The variant is picked for the author from the target agent's `inputKind`, not
// offered as a choice: a sample whose shape disagreed with its target's contract
// would just fail at run time.

export function SampleInputEditor({
  targetId,
  value,
  onChange,
}: {
  targetId: string
  value: EvalSampleInput
  onChange: (next: EvalSampleInput) => void
}) {
  if (value.kind === 'conversation') {
    return (
      <div className="space-y-4">
        <ConversationEditor
          turns={value.turns}
          onChange={(turns) => onChange({ ...value, turns })}
        />
        {/* A conversation agent's SYSTEM prompt can still interpolate — those
        variables have nowhere else to come from, so they ride alongside the
        thread. Hidden entirely when the agent declares none. */}
        <VariablesEditor
          targetId={targetId}
          value={value.variables}
          onChange={(variables) => onChange({ ...value, variables })}
          hideWhenUndeclared
        />
      </div>
    )
  }
  return (
    <VariablesEditor
      targetId={targetId}
      value={value.variables}
      onChange={(variables) => onChange({ ...value, variables })}
    />
  )
}

// ── Variables ────────────────────────────────────────────────────────────────
// One value field per `${var}` the target's published prompt declares. Absent a
// schema, a free-form key/value editor — the same fallback the Given had, since
// an agent with no declared inputs still has to be given something.

function VariablesEditor({
  targetId,
  value,
  onChange,
  hideWhenUndeclared,
}: {
  targetId: string
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
  /** Render nothing when the agent declares no variables (conversation input). */
  hideWhenUndeclared?: boolean
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
            {agent?.name ?? 'the agent'}
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
              onChange={(e) => {
                return field.onChange({ ...field.value, [f]: e.target.value })
              }}
              onBlur={field.onBlur}
              className="h-8 flex-1 font-mono text-xs"
            />
          </div>
        ))}
      </div>
    )
  }

  // A conversation agent with no declared variables needs nothing here — the
  // thread IS its input, so an empty key/value grid would be noise.
  if (hideWhenUndeclared && Object.keys(field.value).length === 0) return null

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
          ? 'The agent has no declared input variables — add initial state manually.'
          : 'This goal has no agent yet — set one on the goal, or add state manually.'}
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
            onChange={(e) => {
              return field.onChange({ ...field.value, [k]: e.target.value })
            }}
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
