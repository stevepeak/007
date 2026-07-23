import { MessagesSquare, Plus, Wrench, X } from 'lucide-react'

import type { SeededMessage, SeededToolCall } from '../../server/protocol'
import { useWfComponents } from '../context'
import { useCommittedField } from '../use-committed-field'

// Synthesis mode. A "seeded conversation" pre-bakes the turns an agent starts
// from — user prompts plus assistant turns that already carry their tool calls
// and canned results — so a run begins mid-conversation and only the model's
// NEXT (final) reply is produced and graded. Paired with "Freeze tools", the
// agent gets NO tools and must answer from this transcript alone, isolating
// response quality from retrieval / tool-selection nondeterminism.
//
// The transcript maps 1:1 to `initialCondition.seededMessages`; the freeze flag
// to `initialCondition.freezeTools`. When a conversation is present it REPLACES
// the Given's trigger input as the agent's message history.
export function ConversationEditor({
  messages,
  freezeTools,
  onMessagesChange,
  onFreezeToolsChange,
}: {
  messages: SeededMessage[]
  freezeTools: boolean
  onMessagesChange: (next: SeededMessage[]) => void
  onFreezeToolsChange: (next: boolean) => void
}) {
  const { Button, Checkbox } = useWfComponents()
  const field = useCommittedField(messages, onMessagesChange, JSON.stringify)

  const update = (i: number, patch: Partial<SeededMessage>) =>
    field.onChange(field.value.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  const remove = (i: number) =>
    field.commit(field.value.filter((_, j) => j !== i))
  const add = (role: SeededMessage['role']) =>
    field.commit([...field.value, { role, text: '' }])

  return (
    <div className="space-y-3">
      <p className="px-1 text-xs text-neutral-400">
        Stage the conversation the agent starts from. Give the assistant a turn
        with a tool result to seed retrieved context, then grade only the reply
        it produces next.
      </p>

      <label className="flex items-start gap-2 rounded-lg border border-neutral-200 px-3 py-2.5">
        <Checkbox
          checked={freezeTools}
          onChange={(e) => onFreezeToolsChange(e.target.checked)}
          className="mt-0.5"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-neutral-800">
            Freeze tools
          </span>
          <span className="block text-xs text-neutral-400">
            Run the agent with no tools — it must answer from the conversation
            above. Turns a run into a pure test of the final response.
          </span>
        </span>
      </label>

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
          No seeded turns — this sample runs from the Given instead.
        </div>
      )}

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
