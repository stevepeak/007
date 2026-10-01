import type { EvalSampleInput } from '../../server/protocol'
import { useWfComponents } from '../context'
import { useCommittedField } from '../use-committed-field'

// A Sample's input for a DECISION agent: one state blob.
//
// It gets its own editor because none of the other three fit. A decision agent
// has no prompt template to fill in, no thread to seed and no trigger payload —
// what it takes is the thing being judged, which is whatever the caller would
// have handed the node. So this is a text box, and deliberately so: the state
// is the sample.
//
// Free text rather than a JSON editor, with JSON preserved when it parses. The
// common decision state IS prose — an email, a message, a clause — and a JSON
// editor would make an author quote and escape it. When the text parses as JSON
// it is stored as the object, so a sample that genuinely wants structure gets
// it without a mode switch.

export function DecisionStateEditor({
  value,
  onChange,
  variableNames,
}: {
  value: Extract<EvalSampleInput, { kind: 'decision' }>
  onChange: (next: EvalSampleInput) => void
  /** The `${…}` tokens the target's questions interpolate; empty hides the grid. */
  variableNames: string[]
}) {
  const { Textarea, Input } = useWfComponents()
  const field = useCommittedField(
    value.state,
    (state) => onChange({ ...value, state }),
    stateText,
  )
  const variables = useCommittedField(
    value.variables,
    (next) => onChange({ ...value, variables: next }),
    JSON.stringify,
  )

  return (
    <div className="space-y-3">
      <p className="px-1 text-xs text-neutral-400">
        The state every question is judged against — one provider call, all
        questions, this text. Paste the real thing: a decision agent is only as
        calibrated as the states it was tuned on.
      </p>
      <Textarea
        value={stateText(field.value)}
        onChange={(e) => field.onChange(readState(e.target.value))}
        onBlur={field.onBlur}
        rows={10}
        spellCheck={false}
        placeholder="Paste the message, ticket or document to judge…"
        className="font-mono text-[11px]"
      />
      {variableNames.length > 0 ? (
        <div className="space-y-2">
          <p className="px-1 text-xs text-neutral-400">
            Values for the `${'{…}'}` tokens this agent&apos;s questions
            interpolate.
          </p>
          {variableNames.map((name) => (
            <div key={name} className="flex items-center gap-2">
              <span
                title={name}
                className="w-40 shrink-0 truncate rounded bg-neutral-100 px-2 py-1.5 font-mono text-xs text-neutral-600"
              >
                {name}
              </span>
              <Input
                value={variables.value[name] ?? ''}
                placeholder="value"
                onChange={(e) => {
                  return variables.onChange({
                    ...variables.value,
                    [name]: e.target.value,
                  })
                }}
                onBlur={variables.onBlur}
                className="h-8 flex-1 font-mono text-xs"
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The state as editable text. A string is itself; anything else is pretty JSON,
 * which is what an author who pasted an object wants to see back.
 */
function stateText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    // `?? ''` covers the values JSON.stringify returns UNDEFINED for (a
    // function, a symbol) rather than throwing — which no stored state should
    // be, but an empty box beats the string "[object Object]".
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return ''
  }
}

/**
 * Text back to a state value. Text that parses as a JSON OBJECT or ARRAY is
 * stored as that; everything else stays the string it is.
 *
 * Objects and arrays only, on purpose. `"42"` and `"true"` are valid JSON, and
 * silently storing the number would strip the quotes off a state that is
 * genuinely the text "42" — an author who wants a scalar can say so in prose,
 * and one who wants structure has written braces.
 */
function readState(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    // Mid-edit JSON — keep the raw text so the caret doesn't jump.
    return text
  }
}
