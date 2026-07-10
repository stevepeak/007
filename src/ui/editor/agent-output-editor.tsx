import { AlertTriangle, Check } from 'lucide-react'
import { useMemo, useState } from 'react'

import { compileZodSource, type AgentOutput } from '../../engine'
import { cn } from '../cn'
import { ZodCodeEditor } from './zod-code-editor'

// Editor for an agent's "expected output" contract. Three shapes:
//   • Text    — the agent's final text (no config).
//   • Yes / No — a single boolean decision (+ reason).
//   • Structured — an object the author writes as a Zod schema, compiled to a
//     JSON Schema for `generateObject`.
//
// The structured editor keeps the raw Zod source in the value (round-trips) and
// a compiled JSON Schema (what the engine runs). While the source doesn't
// compile, the compiled schema holds at its last-good value and the error is
// shown, so a draft is always saveable.

const STRUCTURED_TEMPLATE = `z.object({
  summary: z.string(),
  isUrgent: z.boolean(),
})`

const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

type Kind = AgentOutput['kind']

export type AgentOutputEditorProps = {
  value: AgentOutput
  onChange: (value: AgentOutput) => void
}

export function AgentOutputEditor({ value, onChange }: AgentOutputEditorProps) {
  // Local source state for the structured editor so keystrokes stay smooth even
  // when a given keystroke doesn't compile.
  const [source, setSource] = useState(
    value.kind === 'object' ? value.source || STRUCTURED_TEMPLATE : '',
  )

  const compiled = useMemo(
    () => (value.kind === 'object' ? compileZodSource(source) : null),
    [value.kind, source],
  )

  function selectKind(kind: Kind) {
    if (kind === value.kind) return
    if (kind === 'text') onChange({ kind: 'text' })
    else if (kind === 'boolean') onChange({ kind: 'boolean' })
    else {
      const seed = source || STRUCTURED_TEMPLATE
      setSource(seed)
      const c = compileZodSource(seed)
      onChange({
        kind: 'object',
        source: seed,
        schema: c.ok ? c.schema : EMPTY_SCHEMA,
      })
    }
  }

  function onSourceChange(next: string) {
    setSource(next)
    const c = compileZodSource(next)
    onChange({
      kind: 'object',
      source: next,
      schema: c.ok
        ? c.schema
        : value.kind === 'object'
          ? value.schema
          : EMPTY_SCHEMA,
    })
  }

  const options: { kind: Kind; label: string; hint: string }[] = [
    { kind: 'text', label: 'Text', hint: 'Free-form answer' },
    { kind: 'boolean', label: 'Yes / No', hint: 'A single decision' },
    { kind: 'object', label: 'Structured', hint: 'A typed object' },
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {options.map((o) => {
          const active = value.kind === o.kind
          return (
            <button
              key={o.kind}
              type="button"
              onClick={() => selectKind(o.kind)}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-sm transition',
                active
                  ? 'border-neutral-800 bg-neutral-900 text-white'
                  : 'border-neutral-300 text-neutral-700 hover:border-neutral-400',
              )}
            >
              <div className="font-medium">{o.label}</div>
              <div
                className={cn(
                  'mt-0.5 text-xs',
                  active ? 'text-neutral-300' : 'text-neutral-400',
                )}
              >
                {o.hint}
              </div>
            </button>
          )
        })}
      </div>

      {value.kind === 'boolean' ? (
        <p className="text-xs text-neutral-500">
          The agent returns{' '}
          <code className="rounded bg-neutral-100 px-1">
            {'{ answer: boolean, reason: string }'}
          </code>{' '}
          — the decision plus a short justification, useful for routing and
          gates.
        </p>
      ) : null}

      {value.kind === 'object' ? (
        <div className="space-y-2">
          <div className="text-xs text-neutral-500">
            Describe the output as a Zod schema. Supported:{' '}
            <code className="rounded bg-neutral-100 px-1">z.string()</code>,{' '}
            <code className="rounded bg-neutral-100 px-1">z.number()</code>,{' '}
            <code className="rounded bg-neutral-100 px-1">z.boolean()</code>,{' '}
            <code className="rounded bg-neutral-100 px-1">z.enum([…])</code>,{' '}
            <code className="rounded bg-neutral-100 px-1">z.array(…)</code>,
            nested{' '}
            <code className="rounded bg-neutral-100 px-1">
              z.object({'{…}'})
            </code>
            , and the{' '}
            <code className="rounded bg-neutral-100 px-1">.optional()</code> /{' '}
            <code className="rounded bg-neutral-100 px-1">.describe("…")</code>{' '}
            chains. The schema is parsed, never executed. Type{' '}
            <code className="rounded bg-neutral-100 px-1">z.</code> for
            suggestions.
          </div>
          <ZodCodeEditor
            value={source}
            onChange={onSourceChange}
            invalid={!!compiled && !compiled.ok}
          />
          {compiled && !compiled.ok ? (
            <div className="flex items-start gap-1.5 text-xs text-amber-700">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{compiled.error}</span>
            </div>
          ) : compiled && compiled.ok ? (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600">
              <Check className="size-3.5 shrink-0" />
              <span>
                {compiled.fields.length} field
                {compiled.fields.length === 1 ? '' : 's'}:{' '}
                {compiled.fields.join(', ')}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
