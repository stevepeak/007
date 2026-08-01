import { AlertTriangle, Check } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  compileZodSource,
  zodSourceFromJsonSchema,
  type AgentOutput,
} from '../../engine'
import { cn } from '../cn'
import { ZodCodeEditor } from './zod-code-editor'

// Editor for an agent's "expected output" contract. Three shapes:
//   • Text    — the agent's final text (no config).
//   • Yes / No — a single boolean decision (+ reason).
//   • Structured — an object the author writes as a Zod schema, compiled to a
//     JSON Schema for `generateObject`.
//
// The persisted value is ONLY the compiled JSON Schema (what the engine runs).
// The editable Zod source is local editor state, seeded by decompiling that
// schema; it is never stored, so source and schema can't drift. While the
// source doesn't compile, the stored schema holds at its last-good value and
// the error is shown, so a draft is always saveable.

// Ghost/example text only — shown as a placeholder when the author hasn't typed
// a source yet. It must NEVER be seeded into `source` state or written back via
// `onChange`, or it becomes the persisted schema for every untouched agent.
const STRUCTURED_PLACEHOLDER = `z.object({
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
  /**
   * The selected model can't produce structured output — both Yes/No and
   * Structured go through `generateObject`, so they're disabled, leaving Text.
   */
  structuredDisabled?: boolean
  /** Why the structured shapes are disabled; shown as a hint. */
  structuredDisabledReason?: string
}

export function AgentOutputEditor({
  value,
  onChange,
  structuredDisabled = false,
  structuredDisabledReason,
}: AgentOutputEditorProps) {
  // Local source state for the structured editor so keystrokes stay smooth even
  // when a given keystroke doesn't compile. Reconstructed from the stored schema
  // (the single source of truth) so the author always sees the real shape; never
  // the placeholder, so an untouched agent's schema is never overwritten by
  // example text.
  const [source, setSource] = useState(() =>
    value.kind === 'object' ? zodSourceFromJsonSchema(value.schema) : '',
  )

  // Only compile once there's actually a source to compile. When the source is
  // empty (e.g. a schema authored in code, with no round-trip source), stay
  // neutral rather than flagging the untouched agent as "invalid".
  const compiled = useMemo(
    () =>
      value.kind === 'object' && source.trim() ? compileZodSource(source) : null,
    [value.kind, source],
  )

  function selectKind(kind: Kind) {
    if (kind === value.kind) return
    if (kind === 'text') onChange({ kind: 'text' })
    else if (kind === 'boolean') onChange({ kind: 'boolean' })
    else {
      // Carry over any existing source; do NOT seed the placeholder. A fresh
      // structured output starts empty (an object with no fields) and the author
      // types the schema, guided by the placeholder ghost text.
      const c = source.trim() ? compileZodSource(source) : null
      onChange({
        kind: 'object',
        schema: c?.ok ? c.schema : EMPTY_SCHEMA,
      })
    }
  }

  function onSourceChange(next: string) {
    setSource(next)
    const c = compileZodSource(next)
    onChange({
      kind: 'object',
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
          // Yes/No and Structured both need model structured-output support.
          const optDisabled = structuredDisabled && o.kind !== 'text'
          return (
            <button
              key={o.kind}
              type="button"
              disabled={optDisabled}
              title={optDisabled ? structuredDisabledReason : undefined}
              onClick={() => selectKind(o.kind)}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-sm transition',
                optDisabled
                  ? 'cursor-not-allowed border-neutral-200 bg-neutral-50 text-neutral-300'
                  : active
                    ? 'border-neutral-800 bg-neutral-900 text-white'
                    : 'border-neutral-300 text-neutral-700 hover:border-neutral-400',
              )}
            >
              <div className="font-medium">{o.label}</div>
              <div
                className={cn(
                  'mt-0.5 text-xs',
                  optDisabled
                    ? 'text-neutral-300'
                    : active
                      ? 'text-neutral-300'
                      : 'text-neutral-400',
                )}
              >
                {o.hint}
              </div>
            </button>
          )
        })}
      </div>

      {structuredDisabled ? (
        <p className="flex items-start gap-1.5 text-xs text-neutral-500">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>
            {structuredDisabledReason ??
              'The selected model doesn’t support structured output — only Text is available.'}
          </span>
        </p>
      ) : null}

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
            <code className="rounded bg-neutral-100 px-1">.nullable()</code> /{' '}
            <code className="rounded bg-neutral-100 px-1">.int()</code> /{' '}
            <code className="rounded bg-neutral-100 px-1">.describe("…")</code>{' '}
            chains. The schema is parsed, never executed. Type{' '}
            <code className="rounded bg-neutral-100 px-1">z.</code> for
            suggestions.
          </div>
          <ZodCodeEditor
            value={source}
            onChange={onSourceChange}
            placeholder={STRUCTURED_PLACEHOLDER}
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
