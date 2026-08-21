import { AlertTriangle, MessagesSquare, Plus, Wrench, X } from 'lucide-react'

import type { SeededMessage, SeededToolCall } from '../../server/protocol'
import { useWfComponents } from '../context'
import { useCommittedField } from '../use-committed-field'

// The thread a CONVERSATION agent answers — user turns plus assistant turns that
// already carry their tool calls and canned results. These become the agent's
// message history, so a run begins mid-conversation and only the model's NEXT
// (final) reply is produced and graded.
//
// Tools are NOT configured here. Whether the agent may call any (and what they
// return) is the Sample's Tools setting, one card down — pairing this transcript
// with `frozen` tools is what makes a pure synthesis test, but the transcript
// stands on its own without it.
export function ConversationEditor({
  turns,
  onChange,
}: {
  turns: SeededMessage[]
  onChange: (next: SeededMessage[]) => void
}) {
  const { Button } = useWfComponents()
  const field = useCommittedField(turns, onChange, JSON.stringify)

  const update = (i: number, patch: Partial<SeededMessage>) =>
    field.onChange(field.value.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  const remove = (i: number) =>
    field.commit(field.value.filter((_, j) => j !== i))
  const add = (role: SeededMessage['role']) =>
    field.commit([...field.value, { role, text: '' }])

  // A transcript ending on a plain assistant message leaves the model nothing to
  // answer, so it generates a SECOND assistant turn — and the sample grades that
  // instead of the reply the author meant. Cheap to spot, expensive to debug.
  const last = field.value[field.value.length - 1]
  const endsOnAssistantText =
    !!last &&
    last.role === 'assistant' &&
    (last.toolCalls ?? []).length === 0 &&
    !!last.text?.trim()

  return (
    <div className="space-y-3">
      <p className="px-1 text-xs text-neutral-400">
        Stage the conversation the agent starts from. Give the assistant a turn
        with a tool result to seed retrieved context, then grade only the reply
        it produces next.
      </p>

      {field.value.length > 0 ? (
        <div className="space-y-2">
          {field.value.map((m, i) => (
            <TurnCard
              key={i}
              message={m}
              onChange={(patch) => update(i, patch)}
              onCommit={field.onBlur}
              onRemove={() => remove(i)}
            />
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-xs text-neutral-400">
          <MessagesSquare className="size-4" />
          No turns yet — add the thread this agent should answer.
        </div>
      )}

      {endsOnAssistantText ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <p className="text-[11px] text-amber-700">
            This transcript ends on an assistant message, so the model will
            generate <strong>another</strong> assistant turn — and that is what
            gets graded. End on a user turn, or on an assistant turn carrying a
            tool result.
          </p>
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => add('user')}>
          <Plus className="size-4" />
          User turn
        </Button>
        <Button size="sm" variant="ghost" onClick={() => add('assistant')}>
          <Plus className="size-4" />
          Assistant turn
        </Button>
      </div>
    </div>
  )
}

function TurnCard({
  message,
  onChange,
  onCommit,
  onRemove,
}: {
  message: SeededMessage
  onChange: (patch: Partial<SeededMessage>) => void
  onCommit: () => void
  onRemove: () => void
}) {
  const { Textarea } = useWfComponents()
  const isAssistant = message.role === 'assistant'

  const setToolCalls = (toolCalls: SeededToolCall[]) => onChange({ toolCalls })
  const addToolCall = () =>
    setToolCalls([...(message.toolCalls ?? []), { tool: '', output: {} }])

  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 p-3">
      <div className="flex items-center gap-2">
        <span
          className={
            isAssistant
              ? 'rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-violet-700'
              : 'rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-sky-700'
          }
        >
          {isAssistant ? 'Assistant' : 'User'}
        </span>
        <button
          type="button"
          aria-label="Remove turn"
          onClick={onRemove}
          className="ml-auto text-neutral-300 transition hover:text-neutral-600"
        >
          <X className="size-4" />
        </button>
      </div>

      <Textarea
        value={message.text ?? ''}
        placeholder={
          isAssistant ? 'Assistant message (optional)' : 'User message'
        }
        onChange={(e) => onChange({ text: e.target.value })}
        onBlur={onCommit}
        rows={isAssistant ? 2 : 3}
        className="text-sm"
      />

      {isAssistant ? (
        <div className="space-y-2">
          {(message.toolCalls ?? []).map((tc, i) => (
            <ToolCallEditor
              key={i}
              call={tc}
              onChange={(patch) =>
                setToolCalls(
                  (message.toolCalls ?? []).map((c, j) =>
                    j === i ? { ...c, ...patch } : c,
                  ),
                )
              }
              onCommit={onCommit}
              onRemove={() =>
                setToolCalls(
                  (message.toolCalls ?? []).filter((_, j) => j !== i),
                )
              }
            />
          ))}
          <button
            type="button"
            onClick={addToolCall}
            className="flex items-center gap-1.5 px-1 text-xs font-medium text-neutral-500 hover:text-neutral-800"
          >
            <Wrench className="size-3.5" />
            Add tool result
          </button>
        </div>
      ) : null}
    </div>
  )
}

// One staged tool interaction: the tool the assistant "called", the args it
// used (optional), and the result it "saw". `args`/`output` are edited as raw
// JSON and parsed leniently — unparseable text is stored as a string so a
// half-typed value is never lost.
function ToolCallEditor({
  call,
  onChange,
  onCommit,
  onRemove,
}: {
  call: SeededToolCall
  onChange: (patch: Partial<SeededToolCall>) => void
  onCommit: () => void
  onRemove: () => void
}) {
  const { Input } = useWfComponents()
  return (
    <div className="space-y-1.5 rounded-md border border-neutral-100 bg-neutral-50 p-2">
      <div className="flex items-center gap-2">
        <Wrench className="size-3.5 shrink-0 text-neutral-400" />
        <Input
          value={call.tool}
          placeholder="tool id (e.g. search_rag)"
          onChange={(e) => onChange({ tool: e.target.value })}
          onBlur={onCommit}
          className="h-7 flex-1 font-mono text-xs"
        />
        <button
          type="button"
          aria-label="Remove tool result"
          onClick={onRemove}
          className="text-neutral-300 transition hover:text-neutral-600"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <JsonField
        label="args"
        value={call.args}
        onChange={(args) => onChange({ args })}
        onCommit={onCommit}
      />
      <JsonField
        label="result"
        value={call.output}
        onChange={(output) => onChange({ output })}
        onCommit={onCommit}
      />
    </div>
  )
}

function JsonField({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string
  value: unknown
  onChange: (next: unknown) => void
  onCommit: () => void
}) {
  const { Textarea } = useWfComponents()
  const text =
    value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : safeStringify(value)
  return (
    <div className="flex gap-2">
      <span className="w-12 shrink-0 pt-1.5 text-right font-mono text-[10px] uppercase text-neutral-400">
        {label}
      </span>
      <Textarea
        value={text}
        placeholder={label === 'args' ? '{ } (optional)' : '{ "chunks": [ … ] }'}
        onChange={(e) => onChange(parseLoose(e.target.value))}
        onBlur={onCommit}
        rows={2}
        spellCheck={false}
        className="flex-1 font-mono text-[11px]"
      />
    </div>
  )
}

// Parse JSON, but never throw: empty → undefined, invalid → the raw string.
// Keeps a mid-edit value intact and lets an author paste plain text as a result.
function parseLoose(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return text
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
