import { MessageSquarePlus, X } from 'lucide-react'

import type { AgentPreviewMessage } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'

// The playground's scratch conversation, for an agent that works on one
// (`acceptsConversation`). In a real run the agent's history comes from the chat
// trigger's `messages`; here the author writes those turns by hand, so a
// follow-up question ("and what about the second one?") can be tested with the
// context that makes it mean anything.
//
// These are the turns BEFORE the message being sent: the playground's input box
// is the current user turn and is appended after this list at run time. That
// ordering is what keeps the panel honest — you are always answering the last
// thing you typed, with everything above it as context.

const ROLE_LABEL: Record<AgentPreviewMessage['role'], string> = {
  user: 'User',
  assistant: 'Agent',
}

export function ConversationBuilder({
  messages,
  onChange,
  disabled,
}: {
  messages: AgentPreviewMessage[]
  onChange: (next: AgentPreviewMessage[]) => void
  /** Locked while a run is in flight — the history is part of that run. */
  disabled?: boolean
}) {
  const { Button, Textarea } = useWfComponents()

  function patch(index: number, next: Partial<AgentPreviewMessage>) {
    onChange(messages.map((m, i) => (i === index ? { ...m, ...next } : m)))
  }
  function remove(index: number) {
    onChange(messages.filter((_, i) => i !== index))
  }
  // New turns alternate: a conversation reads user → agent → user, and typing
  // the role every time is friction the common case doesn't need.
  function add() {
    const last = messages[messages.length - 1]
    onChange([
      ...messages,
      { role: last?.role === 'user' ? 'assistant' : 'user', text: '' },
    ])
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-neutral-700">
          Conversation
        </span>
        <span className="text-[11px] text-neutral-400">
          {messages.length === 0
            ? 'no prior turns'
            : `${messages.length} prior turn${messages.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {messages.length > 0 ? (
        <ul className="space-y-1.5">
          {messages.map((m, i) => (
            <li
              key={i}
              className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-white p-2"
            >
              <RoleToggle
                role={m.role}
                disabled={disabled}
                onToggle={() =>
                  patch(i, {
                    role: m.role === 'user' ? 'assistant' : 'user',
                  })
                }
              />
              <Textarea
                value={m.text}
                rows={2}
                disabled={disabled}
                placeholder={
                  m.role === 'user'
                    ? 'What the person said…'
                    : 'How the agent replied…'
                }
                onChange={(e) => patch(i, { text: e.target.value })}
                className="min-h-0 resize-y border-0 bg-transparent px-0 py-0 text-xs focus:border-0"
              />
              <button
                type="button"
                aria-label={`Remove ${ROLE_LABEL[m.role].toLowerCase()} turn`}
                disabled={disabled}
                onClick={() => remove(i)}
                className="shrink-0 rounded p-1 text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-neutral-200 px-2.5 py-2 text-[11px] text-neutral-400">
          This agent works on a conversation. Add the turns that came before
          your message to test how it handles context and follow-ups.
        </p>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={add}
      >
        <MessageSquarePlus className="size-3.5" />
        Add turn
      </Button>
    </div>
  )
}

/** Click to flip a turn between the person and the agent. */
function RoleToggle({
  role,
  disabled,
  onToggle,
}: {
  role: AgentPreviewMessage['role']
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      title="Switch who said this"
      className={cn(
        'w-16 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        role === 'user'
          ? 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
          : 'bg-violet-50 text-violet-700 hover:bg-violet-100',
      )}
    >
      {ROLE_LABEL[role]}
    </button>
  )
}

/** The turns a past run was given, read-only, for its history card. */
export function ConversationTranscript({
  messages,
}: {
  messages: AgentPreviewMessage[]
}) {
  if (messages.length === 0) return null
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        Conversation
      </div>
      <ul className="space-y-1 rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-2 text-xs">
        {messages.map((m, i) => (
          <li key={i} className="flex gap-2">
            <span
              className={cn(
                'w-12 shrink-0 font-medium',
                m.role === 'user' ? 'text-neutral-500' : 'text-violet-600',
              )}
            >
              {ROLE_LABEL[m.role]}
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-words text-neutral-700">
              {m.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
