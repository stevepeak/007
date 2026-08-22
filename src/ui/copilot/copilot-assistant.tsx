'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { Check, ChevronDown, Sparkles, SquarePen, Wrench } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { ModelCapabilities, ModelOption } from '../../engine/config'
import { cn } from '../cn'
import { useCopilotEndpoint, type WfAssistantContext } from '../context'
import { useModels } from '../hooks'
import { REQUIREMENT_REASON, unmetRequirements } from '../model-capabilities'
import { Popover } from '../popover'

import { registerCopilotSeed } from './ask'

// The copilot runs an agentic tool-calling loop server-side (see
// `handleCopilotRequest` → `runCopilot`), so a model without tool support can't
// drive it — picking one leaves broken tool parts in the thread that later fail
// `ModelMessage` validation. Gate the picker to tool-capable models; models with
// unknown capabilities (the pre-refresh static list) stay selectable.
const COPILOT_REQUIREMENTS: ModelCapabilities = { tools: true }

// The SDK's built-in System Copilot — the concrete chat the persistent
// right-rail panel (`CopilotPanel`) mounts once for the whole workflow app. It
// streams from the host-mounted copilot endpoint (a read-only agentic loop, see
// `handleCopilotRequest`) as ONE continuous conversation that survives
// navigation: the conversation lives in this single component's state, and the
// `context` prop (what the user is currently viewing, derived from the active
// tab) rides on every request so each turn is grounded in the current frame.
// The model, prompt, and tools are owned server-side; the ONE thing the user
// steers here is WHICH model runs inference — picked from the platform's enabled
// (tool-capable) models and carried on every request.

const GREETINGS: Record<string, string> = {
  agent: 'Ask how to improve this agent — its prompt, tools, or model.',
  tool: 'Ask what this tool does or how agents use it.',
  workflow: 'Ask how this workflow is wired or how to improve it.',
  run: 'Ask why this run produced its output, or what went wrong.',
  feedback:
    'Ask why this answer fell short and how to improve the agents, tools, or prompts behind it.',
  system:
    'Ask about the agents, tools, workflows, runs, and feedback behind this platform.',
}

// Remember the last-picked model across dock opens / page loads.
const MODEL_STORAGE_KEY = 'wf-copilot-model'

function readStoredModel(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return window.localStorage.getItem(MODEL_STORAGE_KEY) ?? undefined
}

export function CopilotAssistant({
  subject,
  subjectId,
  runId,
}: WfAssistantContext) {
  const endpoint = useCopilotEndpoint()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Enabled models (the Models page set). The picker offers these; the chosen id
  // rides on every request so the server resolves inference through it.
  const modelsQuery = useModels()
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data])
  // Only tool-capable (or unknown-capability) models can drive the copilot.
  const selectable = useMemo(
    () =>
      models.filter(
        (m) => unmetRequirements(m, COPILOT_REQUIREMENTS).length === 0,
      ),
    [models],
  )
  const [modelId, setModelId] = useState<string | undefined>(readStoredModel)

  // Default to the first tool-capable model once the list loads (and heal a
  // stored id that's gone or now known-incompatible). Never overrides a
  // still-valid explicit choice.
  useEffect(() => {
    if (selectable.length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- heal a stored model id once the list loads; never overrides a valid choice
    setModelId((current) => {
      if (current && selectable.some((m) => m.id === current)) return current
      return selectable[0]?.id
    })
  }, [selectable])

  const selectModel = (id: string) => {
    setModelId(id)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MODEL_STORAGE_KEY, id)
    }
  }

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: endpoint,
        body: {
          subject,
          subjectId,
          runId,
          modelId,
          // On the feedback surface the subjectId IS the rated message id.
          feedbackSubjectId: subject === 'feedback' ? subjectId : undefined,
        },
      }),
    [endpoint, subject, subjectId, runId, modelId],
  )

  // ONE continuous thread that follows the user as they navigate the workflow
  // app (the persistent right-rail panel mounts this once). The `id` is a fixed
  // session key — NOT scoped to the asset — so changing the focused view (or the
  // model) rebuilds the transport WITHOUT dropping the conversation; the new
  // view context simply rides on subsequent turns via the transport body.
  const { messages, sendMessage, status, setMessages } = useChat({
    id: 'copilot:session',
    transport,
  })

  const busy = status === 'submitted' || status === 'streaming'

  // Accept a pre-written question from elsewhere in the app (see `ask.ts`) — the
  // Transform inspector's "have the Copilot write this expression" link is the
  // first caller. It lands in the composer rather than being sent: the user
  // reads and edits it, and chooses to spend the turn.
  useEffect(
    () =>
      registerCopilotSeed((prompt) => {
        setInput(prompt)
        // The rail may be expanding in the same commit, so focus on the next
        // frame — the textarea isn't laid out yet. Put the caret at the end so
        // the user can keep typing.
        requestAnimationFrame(() => {
          const el = inputRef.current
          if (!el) return
          el.focus()
          el.setSelectionRange(prompt.length, prompt.length)
        })
      }),
    [],
  )

  // Auto-grow the composer to fit its content, up to a cap (then it scrolls).
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [input])

  const submit = () => {
    const text = input.trim()
    if (!text || busy || !modelId) return
    setInput('')
    void sendMessage({ text })
    // Scroll to the bottom on the next frame once the new message lands.
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    })
  }

  // Start a fresh thread — clear the one continuous conversation's context. We
  // keep a single thread (no history of past chats), so this just empties it.
  const clearChat = () => {
    setMessages([])
    setInput('')
  }

  const selectedLabel =
    models.find((m) => m.id === modelId)?.label ?? 'Select model'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-1"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <div className="flex size-9 items-center justify-center rounded-full bg-violet-100">
              <Sparkles className="size-4 text-violet-500" />
            </div>
            <p className="max-w-sm text-xs text-neutral-500">
              {GREETINGS[subject] ??
                'Ask about the agents, tools, workflows, and runs behind this system.'}
            </p>
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
        {busy ? (
          <p className="px-2 text-xs italic text-neutral-400">Thinking…</p>
        ) : null}
      </div>

      <div className="space-y-2 border-t border-neutral-200 p-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder="Ask about this agent, tool, run, or the platform…"
          className="max-h-40 min-h-[36px] w-full resize-none overflow-y-auto rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        <div className="flex items-center gap-2">
          <ModelPicker
            models={models}
            selectedId={modelId}
            selectedLabel={selectedLabel}
            loading={modelsQuery.isLoading}
            onSelect={selectModel}
          />
          <div className="flex-1" />
          <button
            type="button"
            onClick={clearChat}
            disabled={busy || (messages.length === 0 && !input.trim())}
            title="Clear the conversation and start a new chat"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2.5 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-50 disabled:pointer-events-none disabled:opacity-50"
          >
            <SquarePen className="size-3.5" />
            New
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !input.trim() || !modelId}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:pointer-events-none disabled:opacity-50"
          >
            <Sparkles className="size-3.5" />
            Ask
          </button>
        </div>
      </div>
    </div>
  )
}

// A compact model pill for the dock footer: shows the current model and opens a
// dropdown of the platform's enabled models. Switching updates every subsequent
// turn (the chosen id rides on the request body).
function ModelPicker({
  models,
  selectedId,
  selectedLabel,
  loading,
  onSelect,
}: {
  models: ModelOption[]
  selectedId: string | undefined
  selectedLabel: string
  loading: boolean
  onSelect: (id: string) => void
}) {
  return (
    <Popover
      className="relative"
      panelClassName="absolute bottom-full left-0 z-50 mb-1 max-h-72 w-64 overflow-y-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Model used for inference"
          onClick={toggle}
          className="inline-flex h-9 max-w-[9rem] items-center gap-1 rounded-md border border-neutral-300 bg-white px-2 text-xs text-neutral-600 outline-none transition hover:bg-neutral-50 focus:border-neutral-500"
        >
          <Sparkles className="size-3 shrink-0 text-violet-500" />
          <span className="min-w-0 flex-1 truncate text-left">
            {loading && models.length === 0 ? 'Loading…' : selectedLabel}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-neutral-400" />
        </button>
      )}
    >
      {({ close }) =>
        models.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-neutral-500">
            No models enabled. Enable one on the Models page.
          </div>
        ) : (
          models.map((m) => {
            // A model KNOWN to lack tool calling can't drive the copilot's
            // agentic loop — shown greyed with the reason, not selectable.
            const unmet = unmetRequirements(m, COPILOT_REQUIREMENTS)
            const disabledReason =
              unmet.length > 0
                ? unmet.map((k) => REQUIREMENT_REASON[k]).join(', ')
                : undefined
            const disabled = disabledReason != null
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={m.id === selectedId}
                aria-disabled={disabled}
                disabled={disabled}
                title={disabledReason}
                onClick={() => {
                  onSelect(m.id)
                  close()
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition',
                  disabled
                    ? 'cursor-not-allowed opacity-50'
                    : m.id === selectedId
                      ? 'bg-neutral-100'
                      : 'hover:bg-neutral-50',
                )}
              >
                <span className="min-w-0 flex-1 truncate text-neutral-800">
                  {m.label}
                </span>
                {disabled ? (
                  <span className="shrink-0 text-xs text-amber-600">
                    {disabledReason}
                  </span>
                ) : (
                  <Check
                    className={cn(
                      'size-4 shrink-0 text-neutral-900',
                      m.id === selectedId ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                )}
              </button>
            )
          })
        )
      }
    </Popover>
  )
}

type UIMessageLike = {
  id: string
  role: string
  parts: Array<{ type: string; text?: string; toolName?: string }>
}

function MessageBubble({ message }: { message: UIMessageLike }) {
  const isUser = message.role === 'user'
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          isUser
            ? 'max-w-[85%] rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white'
            : 'max-w-[95%] space-y-1.5 text-sm text-neutral-800'
        }
      >
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return (
              <p key={i} className="whitespace-pre-wrap">
                {part.text}
              </p>
            )
          }
          if (part.type === 'reasoning' && part.text) {
            return (
              <p
                key={i}
                className="whitespace-pre-wrap text-xs italic text-neutral-400"
              >
                {part.text}
              </p>
            )
          }
          // Tool call parts stream in as `tool-<name>` (or `dynamic-tool`). Show
          // a compact affordance so staff see what the copilot inspected.
          if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
            const name =
              part.toolName ??
              (part.type.startsWith('tool-')
                ? part.type.slice('tool-'.length)
                : 'tool')
            return (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[11px] font-medium text-neutral-500"
              >
                <Wrench className="size-3" />
                {name}
              </span>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}
