import {
  AlertTriangle,
  Braces,
  Sparkles,
  ToggleLeft,
  Type,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  BOOLEAN_OUTPUT_SOURCE,
  compileZodSource,
  formatZodSource,
  zodSourceFromJsonSchema,
  type AgentOutput,
} from '../../engine'
import { cn } from '../cn'
import { askCopilot, useCopilotSeedAvailable } from '../copilot/ask'

import {
  buildAgentSchemaCopilotPrompt,
  type AgentSchemaPromptInput,
} from './agent-schema-copilot-prompt'
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

// The supported syntax, reachable from the `?` inside the editor rather than
// set as a wall of prose above it.
const SCHEMA_HELP = (
  <>
    <p>
      Describe the output as a Zod schema. Type{' '}
      <code className="rounded bg-neutral-100 px-1">z.</code> for suggestions.
      The schema is parsed, never executed.
    </p>
    <p className="mt-2">
      Supported:{' '}
      <code className="rounded bg-neutral-100 px-1">z.string()</code>,{' '}
      <code className="rounded bg-neutral-100 px-1">z.number()</code>,{' '}
      <code className="rounded bg-neutral-100 px-1">z.boolean()</code>,{' '}
      <code className="rounded bg-neutral-100 px-1">z.enum([…])</code>,{' '}
      <code className="rounded bg-neutral-100 px-1">z.array(…)</code>, nested{' '}
      <code className="rounded bg-neutral-100 px-1">z.object({'{…}'})</code>, and
      the <code className="rounded bg-neutral-100 px-1">.optional()</code> /{' '}
      <code className="rounded bg-neutral-100 px-1">.nullable()</code> /{' '}
      <code className="rounded bg-neutral-100 px-1">.nullish()</code> /{' '}
      <code className="rounded bg-neutral-100 px-1">.int()</code> /{' '}
      <code className="rounded bg-neutral-100 px-1">.describe("…")</code> chains.
    </p>
  </>
)

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
  /**
   * What the agent is and does, used to seed the Copilot when the author asks
   * for help with the schema. Omit it and the help link simply isn't offered —
   * a Copilot handed no context would only be guessing.
   */
  copilotContext?: Omit<AgentSchemaPromptInput, 'currentSource'>
  /**
   * Lift the Zod source into the caller's state — pass both to make it
   * controlled, omit both to keep the local copy.
   *
   * Worth doing wherever there is an undo stack. The config stores the COMPILED
   * schema, so a source keystroke that doesn't yet parse exists only here;
   * restoring a snapshot would move the schema underneath an editor still
   * showing the old text.
   */
  source?: string
  /**
   * One keystroke is ONE edit: the text and the schema it compiles to arrive
   * together. Reporting them as two separate calls is what broke this editor —
   * a caller holding both in a single snapshot recorded the source, then
   * recorded the schema on top of the pre-keystroke snapshot, reverting the
   * source it had just been given. Nothing typed ever appeared in the box.
   *
   * `output` is absent when only the text moved (a reformat on blur).
   */
  onSourceEdit?: (edit: { source: string; output?: AgentOutput }) => void
}

export function AgentOutputEditor({
  value,
  onChange,
  structuredDisabled = false,
  structuredDisabledReason,
  copilotContext,
  source: controlledSource,
  onSourceEdit,
}: AgentOutputEditorProps) {
  const copilotAvailable = useCopilotSeedAvailable()
  // Local source state for the structured editor so keystrokes stay smooth even
  // when a given keystroke doesn't compile. Reconstructed from the stored schema
  // (the single source of truth) so the author always sees the real shape; never
  // the placeholder, so an untouched agent's schema is never overwritten by
  // example text.
  const [localSource, setLocalSource] = useState(() =>
    value.kind === 'object' ? zodSourceFromJsonSchema(value.schema) : '',
  )
  const controlled = controlledSource !== undefined
  const source = controlled ? controlledSource : localSource

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
    const c = compileZodSource(next)
    // While the source doesn't compile, hold the schema at its last-good value
    // so a half-typed draft is still saveable.
    const output: AgentOutput = {
      kind: 'object',
      schema: c.ok
        ? c.schema
        : value.kind === 'object'
          ? value.schema
          : EMPTY_SCHEMA,
    }
    if (controlled) onSourceEdit?.({ source: next, output })
    else {
      setLocalSource(next)
      onChange(output)
    }
  }

  // Reformat on blur ("commit"), but only when the source is valid — never
  // rearrange a half-typed, uncompilable draft. Comments are carried through.
  function formatSource() {
    if (!source.trim() || !compileZodSource(source).ok) return
    const formatted = formatZodSource(source)
    if (formatted === source) return
    // Only the text moves — formatting a compiling source can't change what it
    // compiles to, so there's no schema to send with it.
    if (controlled) onSourceEdit?.({ source: formatted })
    else setLocalSource(formatted)
  }

  // Hand the Copilot the agent's own context and let it ask the author what the
  // result should contain. Offered whether or not a schema exists — an empty box
  // is the hardest place to start, and an existing shape is the thing most worth
  // talking through changes to.
  const askForSchema = () => {
    if (!copilotContext) return
    askCopilot(
      buildAgentSchemaCopilotPrompt({ ...copilotContext, currentSource: source }),
    )
  }

  const options: {
    kind: Kind
    label: string
    hint: string
    Icon: LucideIcon
  }[] = [
    { kind: 'text', label: 'Text', hint: 'Free-form answer', Icon: Type },
    {
      kind: 'boolean',
      label: 'Yes / No',
      hint: 'A single decision',
      Icon: ToggleLeft,
    },
    { kind: 'object', label: 'Structured', hint: 'A typed object', Icon: Braces },
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
              <div className="flex items-center gap-1.5 font-medium">
                <o.Icon className="size-3.5 shrink-0" />
                {o.label}
              </div>
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
        <div className="space-y-1.5">
          <p className="text-xs text-neutral-500">
            The agent returns this fixed shape — the decision routes the node's
            yes/no edges, and the rest flows downstream.
          </p>
          <ZodCodeEditor
            value={BOOLEAN_OUTPUT_SOURCE}
            onChange={() => {}}
            readOnly
          />
        </div>
      ) : null}

      {value.kind === 'object' ? (
        <div className="space-y-2">
          <ZodCodeEditor
            value={source}
            onChange={onSourceChange}
            onBlur={formatSource}
            placeholder={STRUCTURED_PLACEHOLDER}
            invalid={!!compiled && !compiled.ok}
            help={SCHEMA_HELP}
          />
          {compiled && !compiled.ok ? (
            <div className="flex items-start gap-1.5 text-xs text-amber-700">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{compiled.error}</span>
            </div>
          ) : null}
          {copilotAvailable && copilotContext ? (
            <button
              type="button"
              onClick={askForSchema}
              className="inline-flex w-fit items-center gap-1.5 text-xs text-violet-600 underline underline-offset-2 hover:text-violet-700"
            >
              <Sparkles className="size-3" />
              {source.trim()
                ? 'Ask the Copilot to change this schema'
                : 'Ask the Copilot to help write this schema'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
