import {
  Bot,
  Brain,
  ChevronRight,
  CircleCheck,
  CircleDot,
  FileText,
  GitBranch,
  Repeat,
  User,
  Wrench,
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { AgentNodeMeta, WfRunStepDTO } from '../server/protocol'
import { cn } from './cn'
import { DataView } from './data-view'
import { NoteMarkdown } from './editor/note-markdown'

// The Logs view renders a step's execution as an AI-style vertical timeline:
//   Input → thinking → tool call → … → Output.
// Only agent (AI) steps get the "thinking" (Brain) nodes. Tool calls and other
// node kinds share the SAME timeline without thinking — just Input, whatever the
// node did, and Output. Every row is a one-line entry you expand to inspect, and
// a tool call expands into its OWN Input → logs → Output sub-timeline (step-into
// depth). The rows are strung down a connector rail so the flow reads top-down.

type Tone =
  | 'input'
  | 'user'
  | 'thinking'
  | 'tool'
  | 'output'
  | 'response'
  | 'branch'
  | 'iteration'

const toneRing: Record<Tone, string> = {
  input: 'border-neutral-300 bg-white text-neutral-500',
  user: 'border-neutral-300 bg-neutral-100 text-neutral-600',
  thinking: 'border-violet-200 bg-violet-50 text-violet-600',
  tool: 'border-sky-200 bg-sky-50 text-sky-600',
  output: 'border-green-200 bg-green-50 text-green-600',
  response: 'border-green-200 bg-green-50 text-green-600',
  branch: 'border-amber-200 bg-amber-50 text-amber-600',
  iteration: 'border-neutral-300 bg-neutral-50 text-neutral-600',
}

// A node in the timeline. `body` is the expandable detail — a DataView, markdown,
// or a NESTED <Timeline/> for step-into depth. Rows without a body aren't
// expandable.
type LogStep = {
  tone: Tone
  icon: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  body?: ReactNode
}

function TimelineRow({ step, last }: { step: LogStep; last: boolean }) {
  const header = (
    <>
      <span className="truncate font-medium text-neutral-700">{step.title}</span>
      {step.subtitle ? (
        <span className="shrink-0 text-[11px] text-neutral-400">
          {step.subtitle}
        </span>
      ) : null}
    </>
  )
  return (
    <div className="relative flex gap-3 pb-3 last:pb-0">
      {/* Connector rail down to the next node's icon. */}
      {!last ? (
        <span className="absolute top-6 bottom-0 left-[11px] w-px bg-neutral-200" />
      ) : null}
      <span
        className={cn(
          'z-10 flex size-6 shrink-0 items-center justify-center rounded-full border',
          toneRing[step.tone],
        )}
      >
        {step.icon}
      </span>
      <div className="min-w-0 flex-1">
        {step.body ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 py-0.5 text-xs [&::-webkit-details-marker]:hidden">
              {header}
              <ChevronRight className="ml-auto size-3 shrink-0 text-neutral-400 transition-transform group-open:rotate-90" />
            </summary>
            <div className="mt-1.5">{step.body}</div>
          </details>
        ) : (
          <div className="flex items-center gap-2 py-0.5 text-xs">{header}</div>
        )}
      </div>
    </div>
  )
}

function Timeline({ steps }: { steps: LogStep[] }) {
  return (
    <div>
      {steps.map((s, i) => (
        <TimelineRow key={i} step={s} last={i === steps.length - 1} />
      ))}
    </div>
  )
}

// ── Node builders ─────────────────────────────────────────────────────────────

function inputStep(value: unknown): LogStep {
  return {
    tone: 'input',
    icon: <CircleDot className="size-3.5" />,
    title: 'Input',
    body: <DataView value={value} />,
  }
}

function outputStep(value: unknown): LogStep {
  return {
    tone: 'output',
    icon: <CircleCheck className="size-3.5" />,
    title: 'Output',
    body: <DataView value={value} />,
  }
}

// Chat framing for agent (AI) steps: the incoming Input reads as the user's
// message and the final Output as the model's reply. Both keep the full payload
// one click away in the expandable body.
function userStep(value: unknown): LogStep {
  return {
    tone: 'user',
    icon: <User className="size-3.5" />,
    title: previewText(value) || 'Message',
    body: <DataView value={value} />,
  }
}

function responseStep(value: unknown): LogStep {
  return {
    tone: 'response',
    icon: <Bot className="size-3.5" />,
    title: previewText(value) || 'Response',
    body: <DataView value={value} />,
  }
}

// Best-effort one-line preview of a message/response payload. Handles chat
// triggers (`{messages: [...]}`), agent output (`{text}`), plain strings, and
// falls back to a compact JSON glimpse for anything else.
function previewText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return firstLine(value)
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.text === 'string') return firstLine(obj.text)
    if (Array.isArray(obj.messages) && obj.messages.length) {
      const last = obj.messages[obj.messages.length - 1] as {
        parts?: Array<{ type?: string; text?: string }>
        content?: unknown
      }
      const partText = last.parts?.find(
        (p) => p.type === 'text' && typeof p.text === 'string',
      )?.text
      if (partText) return firstLine(partText)
      if (typeof last.content === 'string') return firstLine(last.content)
    }
  }
  return firstLine(JSON.stringify(value))
}

// A tool call is itself a mini run: Input → (any logs) → Output. Nesting a
// Timeline in the body gives the "step-into depth" — expand the call, then
// expand its input or output.
function toolStep(tc: {
  toolName: string
  input: unknown
  output: unknown
}): LogStep {
  return {
    tone: 'tool',
    icon: <Wrench className="size-3.5" />,
    title: tc.toolName,
    subtitle: 'tool call',
    body: <Timeline steps={[inputStep(tc.input), outputStep(tc.output)]} />,
  }
}

// One-line summary of a thinking block: its first non-empty line, trimmed.
function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  return line.length > 100 ? `${line.slice(0, 100)}…` : line
}

function thinkingStep(text: string): LogStep {
  return {
    tone: 'thinking',
    icon: <Brain className="size-3.5" />,
    title: firstLine(text) || 'Thinking',
    body: (
      <div className="text-sm text-neutral-700">
        <NoteMarkdown text={text} />
      </div>
    ),
  }
}

export function RunLog({ step }: { step: WfRunStepDTO }) {
  const agentMeta = asAgentMeta(step.meta)
  const iterMeta = asIterationMeta(step.meta)
  const branch = step.branchResult as {
    result?: string
    reasoning?: string
  } | null

  // Agent steps read as a chat: user message → thinking/tool calls → response.
  // Everything else keeps the neutral Input → … → Output framing.
  const steps: LogStep[] = [
    agentMeta ? userStep(step.input) : inputStep(step.input),
  ]

  // AI steps only: the model's thinking + tool calls between the message and
  // the response. Two things read as "thinking": the model's real reasoning
  // (`reasoning`), and any assistant `text` that ISN'T the final answer — i.e.
  // the model narrating its plan before a tool call. The final step's text is
  // the response we render at the end, so we skip it here to avoid showing the
  // same text as both a Brain row and the Bot row.
  if (agentMeta) {
    const responseText =
      step.output && typeof step.output === 'object'
        ? (step.output as { text?: unknown }).text
        : step.output
    agentMeta.steps.forEach((s) => {
      if (s.reasoning) steps.push(thinkingStep(s.reasoning))
      if (s.text && s.text !== responseText) steps.push(thinkingStep(s.text))
      s.toolCalls.forEach((tc) => steps.push(toolStep(tc)))
    })
  }

  // Branch decision.
  if (branch?.result) {
    steps.push({
      tone: 'branch',
      icon: <GitBranch className="size-3.5" />,
      title: `Decision: ${branch.result}`,
      body: branch.reasoning ? (
        <div className="text-xs text-neutral-600">{branch.reasoning}</div>
      ) : undefined,
    })
  }

  // Iteration summary with its per-item grid.
  if (iterMeta) {
    steps.push({
      tone: 'iteration',
      icon: <Repeat className="size-3.5" />,
      title: `Iteration · ${iterMeta.total} items`,
      body: <IterationTrace meta={iterMeta} />,
    })
  }

  // Any other captured meta we don't have a bespoke view for.
  if (!agentMeta && !iterMeta && step.meta) {
    steps.push({
      tone: 'tool',
      icon: <FileText className="size-3.5" />,
      title: 'Details',
      body: <DataView value={step.meta} />,
    })
  }

  steps.push(agentMeta ? responseStep(step.output) : outputStep(step.output))

  return (
    <div>
      {agentMeta ? (
        <div className="mb-2 text-[11px] text-neutral-500">
          <span className="font-medium text-neutral-600">{agentMeta.model}</span>{' '}
          ·{' '}
          {agentMeta.totalUsage.inputTokens + agentMeta.totalUsage.outputTokens}{' '}
          tokens
        </div>
      ) : null}
      {step.error ? (
        <div className="mb-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs whitespace-pre-wrap text-red-700">
          {step.error}
        </div>
      ) : null}
      <Timeline steps={steps} />
    </div>
  )
}

// ── Iteration ─────────────────────────────────────────────────────────────────

type IterationMeta = {
  total: number
  concurrency: number
  stopOnError: boolean
  items: Array<{ index: number; status: string; error?: string }>
}

function IterationTrace({ meta }: { meta: IterationMeta }) {
  const failed = meta.items.filter((i) => i.status === 'failed')
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-neutral-500">
        {meta.total} items · concurrency {meta.concurrency}
        {failed.length ? ` · ${failed.length} failed` : ''}
      </div>
      <div className="flex flex-wrap gap-1">
        {meta.items.map((i) => (
          <span
            key={i.index}
            title={i.error ? `#${i.index}: ${i.error}` : `#${i.index}`}
            className={cn(
              'inline-flex size-5 items-center justify-center rounded text-[10px] font-medium',
              i.status === 'completed'
                ? 'bg-green-100 text-green-700'
                : i.status === 'failed'
                  ? 'bg-red-100 text-red-700'
                  : 'bg-neutral-100 text-neutral-500',
            )}
          >
            {i.index}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Narrowing helpers for the untyped `meta` JSON column ───────────────────────

function asAgentMeta(meta: unknown): AgentNodeMeta | null {
  if (
    meta &&
    typeof meta === 'object' &&
    Array.isArray((meta as { steps?: unknown }).steps) &&
    'totalUsage' in meta
  ) {
    return meta as AgentNodeMeta
  }
  return null
}

function asIterationMeta(meta: unknown): IterationMeta | null {
  if (
    meta &&
    typeof meta === 'object' &&
    Array.isArray((meta as { items?: unknown }).items) &&
    typeof (meta as { total?: unknown }).total === 'number'
  ) {
    return meta as IterationMeta
  }
  return null
}
