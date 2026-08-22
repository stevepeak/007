import {
  Bot,
  Brain,
  CircleCheck,
  CircleDot,
  Cog,
  FileText,
  GitBranch,
  Repeat,
  User,
  Users,
  Wrench,
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { AgentNodeMeta, WfRunStepDTO } from '../server/protocol'

import { cn } from './cn'
import { formatDurationMs, formatTokens, formatUsd } from './cost'
import { DataView } from './data-view'
import { NoteMarkdown } from './editor/note-markdown'
import { BrandMark, inferModelBrand } from './evals/shared'
import { useTools } from './hooks'
import { type IterationMeta, readIterationMeta } from './run-activity-tree'
import { firstLine, previewLine } from './text-preview'
import { toolChip } from './tool-appearance'
import { ToolIcon } from './tool-icon'
import { Tooltip } from './tooltip'

// The Logs view renders a step's execution as an AI-style vertical timeline:
//   Input → thinking → tool call → … → Output.
// For an agent step the head of that timeline is what the model was SENT (its
// system prompt and messages, from `meta`), never the node's incoming input —
// an edge is sequencing and a source for bindings, not content, so captioning
// it as the user's message would be a lie about what the model read.
// Only agent (AI) steps get the "thinking" (Brain) nodes. Tool calls and other
// node kinds share the SAME timeline without thinking — just Input, whatever the
// node did, and Output. Every row is a one-line entry you expand to inspect, and
// a tool call expands into its OWN Input → logs → Output sub-timeline (step-into
// depth). The rows are strung down a connector rail so the flow reads top-down.

type Tone =
  | 'input'
  | 'system'
  | 'user'
  | 'thinking'
  | 'tool'
  | 'output'
  | 'response'
  | 'branch'
  | 'iteration'

const toneRing: Record<Tone, string> = {
  input: 'border-neutral-300 bg-white text-neutral-500',
  system: 'border-neutral-300 bg-neutral-50 text-neutral-500',
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
      <span className="truncate font-medium text-neutral-700">
        {step.title}
      </span>
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
        <div className="flex items-center gap-2 py-0.5 text-xs">{header}</div>
        {step.body ? <div className="mt-1.5">{step.body}</div> : null}
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

// The agent's effective system prompt — `${…}` variables already substituted
// from the run's promptVariables. Most agents are system-only (their user turn
// is empty), so this is where the real input lives; surfacing it explains what
// the agent actually received.
function systemStep(prompt: string): LogStep {
  return {
    tone: 'system',
    icon: <Cog className="size-3.5" />,
    title: 'System prompt',
    body: (
      <div className="text-sm text-neutral-700">
        <NoteMarkdown text={prompt} />
      </div>
    ),
  }
}

// One message the model was actually sent. This used to render the step's INPUT
// — the incoming edge's payload — which was only ever the message because the
// engine implicitly stringified it into one. It doesn't any more, so showing the
// edge here would caption data the model never saw as "the user's message".
// Now it renders `meta.messages`, recorded at the point of the call.
function messageStep(m: { role: string; text: string }): LogStep {
  const assistant = m.role === 'assistant'
  return {
    tone: assistant ? 'response' : 'user',
    icon: assistant ? (
      <Bot className="size-3.5" />
    ) : (
      <User className="size-3.5" />
    ),
    title: firstLine(m.text) || (assistant ? 'Assistant' : 'Message'),
    subtitle: m.role,
    body: (
      <div className="text-sm whitespace-pre-wrap text-neutral-700">
        {m.text}
      </div>
    ),
  }
}

// Fallback for steps recorded before `meta.messages` existed, where the input
// genuinely WAS the user turn.
function legacyUserStep(value: unknown): LogStep {
  return {
    tone: 'user',
    icon: <User className="size-3.5" />,
    title: previewLine(value) || 'Message',
    subtitle: 'from the incoming edge (legacy run)',
    body: <DataView value={value} />,
  }
}

function responseStep(value: unknown): LogStep {
  return {
    tone: 'response',
    icon: <Bot className="size-3.5" />,
    title: previewLine(value) || 'Response',
    body: <DataView value={value} />,
  }
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

// ── Agent stat cards ──────────────────────────────────────────────────────────
// The header on an agent step: model, tokens, speed, cost, and the tools it
// called as compact cards. Cost comes from the server (token usage × catalog
// price); speed is derived from the step's recorded start/finish window; the
// tool tally is rolled up from the step's own trace.

function StatCard({
  label,
  value,
  sub,
  icon,
  className,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5',
        className,
      )}
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <div className="min-w-0">
        <div className="text-[10px] font-medium tracking-wide text-neutral-400 uppercase">
          {label}
        </div>
        <div className="truncate text-xs font-semibold text-neutral-800">
          {value}
        </div>
        {sub ? (
          <div className="truncate text-[10px] text-neutral-400">{sub}</div>
        ) : null}
      </div>
    </div>
  )
}

// Tally this step's tool calls by tool. The recorded `toolName` IS the tool's
// registry id, so it resolves straight against the tool catalog for the icon
// and the human-readable name (same mapping the agent editor's call list uses).
function countToolCalls(meta: AgentNodeMeta): { toolId: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const s of meta.steps ?? []) {
    for (const tc of s.toolCalls ?? []) {
      if (!tc.toolName) continue
      counts.set(tc.toolName, (counts.get(tc.toolName) ?? 0) + 1)
    }
  }
  return [...counts]
    .map(([toolId, count]) => ({ toolId, count }))
    .sort((a, b) => b.count - a.count || a.toolId.localeCompare(b.toolId))
}

// The tools this step called, each as an icon + name chip with its call count.
// A synthesized delegation tool (`spawn_*` / `await_subagents`) isn't in the
// catalog, so it gets the sub-agent look instead of a missing-tool fallback.
function ToolCallsCard({ meta }: { meta: AgentNodeMeta }) {
  const { data: tools } = useTools()
  const calls = countToolCalls(meta)
  if (calls.length === 0) return null
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5">
      <div className="text-[10px] font-medium tracking-wide text-neutral-400 uppercase">
        Tools
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {calls.map((call) => {
          const tool = tools?.find((t) => t.id === call.toolId)
          const delegation =
            !tool &&
            (call.toolId.startsWith('spawn_') ||
              call.toolId.endsWith('_subagents'))
          const label = tool?.name ?? call.toolId
          return (
            <Tooltip
              key={call.toolId}
              content={`${label} · called ${call.count} ${call.count === 1 ? 'time' : 'times'}`}
            >
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5',
                  delegation
                    ? 'bg-indigo-50 text-indigo-500'
                    : toolChip(tool?.color ?? null),
                )}
              >
                {delegation ? (
                  <Users className="size-3.5 shrink-0" />
                ) : (
                  <ToolIcon
                    icon={tool?.icon}
                    iconName={tool?.iconName}
                    className="size-3.5"
                  />
                )}
                <span className="max-w-[9rem] truncate text-[11px] font-semibold">
                  {label}
                </span>
                <span className="text-[11px] font-semibold tabular-nums opacity-70">
                  ×{call.count}
                </span>
              </span>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}

function AgentMetaBar({
  meta,
  step,
}: {
  meta: AgentNodeMeta
  step: WfRunStepDTO
}) {
  const inTok = meta.totalUsage.inputTokens
  const outTok = meta.totalUsage.outputTokens
  const total = inTok + outTok
  const durationMs =
    step.startedAt != null &&
    step.finishedAt != null &&
    step.finishedAt >= step.startedAt
      ? step.finishedAt - step.startedAt
      : null
  const tps =
    durationMs && durationMs > 0
      ? Math.round(total / (durationMs / 1000))
      : null
  // One "turn" is one model round-trip in the agent loop; the tool-call total
  // across those turns is what drove the extra ones.
  const turns = meta.steps?.length ?? 0
  const toolCalls = (meta.steps ?? []).reduce(
    (n, s) => n + (s.toolCalls?.length ?? 0),
    0,
  )
  return (
    <div className="mb-3 flex flex-wrap items-stretch gap-2">
      <StatCard
        label="Model"
        value={meta.model}
        icon={
          <BrandMark
            brand={inferModelBrand(meta.model)}
            fallback={meta.model}
          />
        }
        className="max-w-[15rem]"
      />
      <StatCard
        label="Tokens"
        value={formatTokens(total)}
        sub={`${formatTokens(inTok)} in · ${formatTokens(outTok)} out`}
      />
      <StatCard
        label="Speed"
        value={formatDurationMs(durationMs)}
        sub={tps != null ? `${tps.toLocaleString()} tok/s` : undefined}
      />
      <StatCard
        label="Turns"
        value={turns.toLocaleString()}
        sub={
          toolCalls > 0
            ? `${toolCalls.toLocaleString()} tool ${toolCalls === 1 ? 'call' : 'calls'}`
            : undefined
        }
      />
      <StatCard label="Cost" value={formatUsd(step.costUsd)} />
      <ToolCallsCard meta={meta} />
    </div>
  )
}

export function RunLog({ step }: { step: WfRunStepDTO }) {
  const agentMeta = asAgentMeta(step.meta)
  const iterMeta = readIterationMeta(step.meta)
  const branch = step.branchResult as {
    result?: string
    reasoning?: string
  } | null

  // Agent steps read as a chat: system prompt → user message → thinking/tool
  // calls → response. Everything else keeps the neutral Input → … → Output
  // framing.
  const steps: LogStep[] = agentMeta
    ? [
        ...(agentMeta.systemPrompt ? [systemStep(agentMeta.systemPrompt)] : []),
        ...(agentMeta.messages
          ? agentMeta.messages.map(messageStep)
          : [legacyUserStep(step.input)]),
      ]
    : [inputStep(step.input)]

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
    for (const s of agentMeta.steps) {
      if (s.reasoning) steps.push(thinkingStep(s.reasoning))
      if (s.text && s.text !== responseText) steps.push(thinkingStep(s.text))
      for (const tc of s.toolCalls) steps.push(toolStep(tc))
    }
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
      {agentMeta ? <AgentMetaBar meta={agentMeta} step={step} /> : null}
      {iterMeta ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
          <span className="inline-flex items-center gap-1 rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-600">
            <Repeat className="size-3" />
            concurrency {iterMeta.concurrency}
          </span>
          <span>
            · {iterMeta.total} items
            {iterMeta.limit === undefined ? '' : ` of max ${iterMeta.limit}`}
          </span>
          {iterMeta.stopOnError ? <span>· stop on error</span> : null}
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

function IterationTrace({ meta }: { meta: IterationMeta }) {
  const failed = meta.items.filter((i) => i.status === 'failed')
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-neutral-500">
        {meta.total} items · concurrency {meta.concurrency}
        {failed.length > 0 ? ` · ${failed.length} failed` : ''}
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

