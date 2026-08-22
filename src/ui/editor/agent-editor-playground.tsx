import {
  AlertTriangle,
  Blocks,
  Brain,
  Check,
  ChevronDown,
  Copy,
  History,
  Layers,
  Loader2,
  Play,
  Wrench,
} from 'lucide-react'
import { useState } from 'react'

import type { AgentConfig } from '../../engine'
import type {
  AgentPreviewResult,
  ToolContextField,
} from '../../server/protocol'
import { WfAutoForm } from '../autoform/wf-auto-form'
import { cn } from '../cn'
import { formatRelative, formatTimestamp } from '../cost'
import { highlightJson } from '../data-view'
import { useModels, useToolContextFields, useTools } from '../hooks'
import { ContextField } from '../tool-context-field'
import { Tooltip } from '../tooltip'

import { changedFields } from './agent-config-diff'
import {
  ConversationBuilder,
  ConversationTranscript,
} from './agent-editor-conversation'
import { ToolModeList } from './agent-editor-tool-modes'
import { NoteMarkdown } from './note-markdown'
import { usePlaygroundRuns, type PlaygroundRun } from './use-playground-runs'

// Playground — runs the editor's live draft config in isolation (no graph, no
// persistence) and shows the final answer plus the per-step thinking/tool-call
// trace. Runs the *draft*, so unsaved edits are testable without publishing.
//
// An agent's inputs are the `${…}` variables in its prompt (inferred live), so
// the form renders one field per variable — e.g. a classifier reading
// `${title}`/`${text}` gets a field for each. An agent with no variables gets a
// single free-form message box instead. Both are expressed as a JSON Schema and
// rendered through the same AutoForm playground as tools.
export function PlaygroundPanel({
  config,
  onRestore,
}: {
  config: AgentConfig
  /** Load a run's frozen config back into the editor. */
  onRestore?: (config: AgentConfig) => void
}) {
  const pg = usePlaygroundRuns(config)

  return (
    <div className="space-y-3">
      <aside className="h-fit space-y-3 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
        {/* Toy blocks, not a play button. The Play glyph is spoken for twice
            over in this panel — the "Run agent" submit and every run's status —
            so as a heading it read as another control rather than a name.
            Blocks says what the panel is FOR: snap the agent together, knock it
            down, try it again, nothing here is permanent. It also keeps the
            right column's two headers legible apart at a glance — the evals
            goal above is a target you either hit or miss, this is the sandbox. */}
        <div className="flex items-center gap-2 text-sm font-medium text-neutral-700">
          <Blocks className="size-4 text-violet-500" />
          Playground
        </div>
        <p className="text-xs text-neutral-500">
          Run this agent in isolation and watch its output — without wiring it
          into a workflow. Uses your current unsaved edits, and every run keeps
          the configuration it ran on so you can go back to it.
        </p>
        {pg.conversational ? (
          <ConversationBuilder
            messages={pg.history}
            onChange={pg.setHistory}
            disabled={pg.pending}
          />
        ) : null}
        <ToolModeList
          tools={pg.attachedTools}
          live={pg.liveTools}
          contextFields={pg.contextFields}
          unmetContext={new Set(pg.missing.map((f) => f.key))}
          disabled={pg.pending}
          onToggle={(toolId, isLive) =>
            pg.setToolModes((m) => ({ ...m, [toolId]: isLive }))
          }
        />
        {config.subAgents.targets.length > 0 && pg.attachedTools.length > 0 ? (
          <p className="text-[11px] text-neutral-400">
            These switches cover this agent&rsquo;s own tools. Anything a
            sub-agent calls is always simulated.
          </p>
        ) : null}

        <PlaygroundContext
          fields={pg.neededContext}
          values={pg.context}
          missing={pg.missing}
          disabled={pg.pending}
          onChange={(key, value) =>
            pg.setContext((c) => ({ ...c, [key]: value }))
          }
        />

        <WfAutoForm
          schema={pg.schema}
          disabled={pg.pending}
          pending={pg.pending}
          submitLabel="Run agent"
          submitIcon={<Play className="size-3.5" />}
          submitDisabled={pg.missing.length > 0}
          submitTitle={
            pg.missing.length > 0
              ? `Provide ${pg.missing.map((f) => f.label).join(', ')} first`
              : undefined
          }
          onSubmit={pg.onRun}
        />
      </aside>

      {pg.runs.map((r) => (
        <PlaygroundRunCard
          key={r.id}
          run={r}
          number={r.id}
          expanded={pg.expandedId === r.id}
          onToggle={() =>
            pg.setExpandedId(pg.expandedId === r.id ? null : r.id)
          }
          changed={changedFields(r.config, config)}
          onRestore={onRestore ? () => onRestore(r.config) : undefined}
        />
      ))}
    </div>
  )
}

/**
 * The ambient run scope for whatever is running live. Rendered only when a live
 * tool actually declares a need, so an all-simulated run never sees it — the
 * form appears and disappears with the tool switches above it.
 */
function PlaygroundContext({
  fields,
  values,
  missing,
  disabled,
  onChange,
}: {
  fields: ToolContextField[]
  values: Record<string, string>
  missing: ToolContextField[]
  disabled?: boolean
  onChange: (key: string, value: string) => void
}) {
  if (fields.length === 0) return null

  return (
    <div className="overflow-hidden rounded-lg border border-indigo-200 bg-indigo-50/40">
      <div className="border-b border-indigo-100 bg-indigo-50/60 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Layers className="size-3.5 text-indigo-500" />
          <span className="text-xs font-semibold text-indigo-900">Context</span>
        </div>
        <p className="mt-0.5 text-[11px] text-indigo-700/70">
          The run scope your live tools filter by — supplied by the environment
          in a real run, never chosen by the agent.
        </p>
      </div>
      <div className="space-y-3 p-3">
        {fields.map((f) => (
          <ContextField
            key={f.key}
            field={f}
            required
            value={values[f.key] ?? ''}
            disabled={disabled}
            onChange={(v) => onChange(f.key, v)}
          />
        ))}
        {missing.length > 0 ? (
          <p className="text-[11px] text-indigo-700/70">
            Provide{' '}
            <span className="font-medium">
              {missing.map((f) => f.label).join(', ')}
            </span>{' '}
            to run. Without it a live tool filters on nothing and reports an
            empty result, which reads exactly like a bad answer.
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One run in the history: its status, what it was given, what came back, and
 * the configuration it ran on — restorable in one click.
 */
function PlaygroundRunCard({
  run,
  number,
  expanded,
  onToggle,
  changed,
  onRestore,
}: {
  run: PlaygroundRun
  number: number
  expanded: boolean
  onToggle: () => void
  changed: string[]
  onRestore?: () => void
}) {
  const isCurrent = changed.length === 0

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-neutral-50"
      >
        <StatusDot status={run.status} />
        <span className="text-sm font-medium text-neutral-800">
          Run {number}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-400">
          {summarizeInput(run.input)}
        </span>
        <Tooltip content={formatTimestamp(run.startedAt)}>
          <span className="shrink-0 text-[11px] text-neutral-400">
            {formatRelative(run.startedAt)}
          </span>
        </Tooltip>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-neutral-400 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-neutral-100 p-3">
          <ConversationTranscript messages={run.messages} />

          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              {run.messages.length > 0 ? 'New message' : 'Input'}
            </div>
            <dl className="space-y-1 rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-2 text-xs">
              {Object.entries(run.input).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="shrink-0 font-medium text-neutral-500">{k}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words text-neutral-700">
                    {v || <span className="text-neutral-400">(empty)</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <RunToolModes run={run} />

          <RunContextValues run={run} />

          {run.status === 'running' ? (
            <div className="flex items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 text-xs text-neutral-400">
              <Loader2 className="size-3.5 animate-spin" />
              Waiting for the agent…
            </div>
          ) : null}

          {run.error ? (
            <div className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{run.error}</span>
            </div>
          ) : null}

          {run.result ? (
            <PlaygroundResult
              result={run.result}
              liveToolIds={run.liveToolIds}
              attachedToolIds={run.config.toolIds}
            />
          ) : null}

          {onRestore ? (
            <div className="flex items-center gap-2 border-t border-neutral-100 pt-2.5">
              <Tooltip
                content={
                  isCurrent
                    ? 'This run used exactly the configuration in the editor right now'
                    : `Load this run's configuration back into the editor — changes ${changed.join(', ')}`
                }
                side="top"
              >
                <button
                  type="button"
                  onClick={onRestore}
                  disabled={isCurrent}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                    isCurrent
                      ? 'cursor-default border-neutral-200 text-neutral-400'
                      : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50',
                  )}
                >
                  <History className="size-3.5" />
                  {isCurrent ? 'Matches current draft' : 'Restore this version'}
                </button>
              </Tooltip>
              {!isCurrent ? (
                <span className="min-w-0 truncate text-[11px] text-neutral-400">
                  differs: {changed.join(', ')}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/**
 * Which tools were real in this run. Worth a line of its own in the record: the
 * same agent, the same input and the same prompt can answer differently
 * depending on whether its search actually ran.
 */
function RunToolModes({ run }: { run: PlaygroundRun }) {
  const tools = useTools().data
  const attached = run.config.toolIds
  if (attached.length === 0) return null
  const name = (id: string) => tools?.find((t) => t.id === id)?.name ?? id
  const liveNames = run.liveToolIds.filter((id) => attached.includes(id))

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        Tools
      </div>
      <p className="text-xs text-neutral-600">
        {liveNames.length === 0 ? (
          <span className="text-neutral-400">
            All {attached.length} simulated — nothing real ran.
          </span>
        ) : (
          <>
            <span className="font-medium text-emerald-700">Live:</span>{' '}
            {liveNames.map(name).join(', ')}
            {liveNames.length < attached.length ? (
              <span className="text-neutral-400">
                {' · '}
                {attached.length - liveNames.length} simulated
              </span>
            ) : null}
          </>
        )}
      </p>
    </div>
  )
}

/** The scope a run's live tools filtered by, as part of its record. */
function RunContextValues({ run }: { run: PlaygroundRun }) {
  const fields = useToolContextFields().data ?? []
  const entries = Object.entries(run.context)
  if (entries.length === 0) return null
  const label = (key: string) => fields.find((f) => f.key === key)?.label ?? key

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        Context
      </div>
      <dl className="space-y-1 rounded-md border border-indigo-100 bg-indigo-50/40 px-2.5 py-2 text-xs">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <dt className="shrink-0 font-medium text-indigo-700/80">
              {label(key)}
            </dt>
            <dd className="min-w-0 truncate font-mono text-[11px] text-neutral-600">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function StatusDot({ status }: { status: PlaygroundRun['status'] }) {
  if (status === 'running') {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-amber-500" />
  }
  return (
    <span
      className={cn(
        'block size-2 shrink-0 rounded-full',
        status === 'error' ? 'bg-red-500' : 'bg-emerald-500',
      )}
    />
  )
}

/** The collapsed card's one-line reminder of what this run was given. */
function summarizeInput(input: Record<string, string>): string {
  const values = Object.values(input).filter(Boolean)
  if (values.length === 0) return '(no input)'
  const joined = values.join(' · ').replaceAll(/\s+/g, ' ')
  return joined.length > 80 ? `${joined.slice(0, 80)}…` : joined
}

// A short boolean-ish answer (what a yes/no classifier emits) — `yes`/`no`/
// `true`/`false`, ignoring case and trailing punctuation. Rendered as a coloured
// token, not markdown, so a verdict reads at a glance.
const VERDICTS: Record<string, boolean> = {
  yes: true,
  no: false,
  true: true,
  false: false,
}
function asVerdict(text: string): { label: string; truthy: boolean } | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')
  return Object.hasOwn(VERDICTS, t)
    ? { label: text.trim(), truthy: VERDICTS[t] }
    : null
}

// Blended-price cost of a run, USD. Tiny for a single preview, so keep enough
// precision to be non-zero — 4 decimals under a dollar, a floor below that.
function formatCost(usd: number): string {
  if (usd <= 0) return '$0'
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

// Renders one completed playground run's final answer: structured output and
// yes/no verdicts are syntax-highlighted (JSON tokens / a coloured verdict),
// while free-form prose is parsed as markdown. Plus an optional step-by-step
// trace and total token usage/cost.
function PlaygroundResult({
  result,
  liveToolIds,
  attachedToolIds,
}: {
  result: AgentPreviewResult
  /** The tools this run executed for real — everything else was faked. */
  liveToolIds: readonly string[]
  /** The agent's own tools, to tell them from synthesized delegation tools. */
  attachedToolIds: readonly string[]
}) {
  const { output, meta } = result
  const models = useModels().data
  const textOutput =
    'text' in output && typeof output.text === 'string' ? output.text : null
  const verdict = textOutput != null ? asVerdict(textOutput) : null
  const [copied, setCopied] = useState(false)

  // Copy the raw output — the prose/verdict text as-is, or the pretty-printed
  // JSON for structured output (mirrors what's rendered above).
  const copyText =
    textOutput != null ? textOutput : JSON.stringify(output, null, 2)
  const copy = () => {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  const steps = meta.steps.filter(
    (s) => s.text || s.reasoning || s.toolCalls.length > 0,
  )
  const totalTokens = meta.totalUsage.inputTokens + meta.totalUsage.outputTokens

  const costPerMTok = models?.find((m) => m.id === meta.model)?.costPerMTok
  const cost =
    costPerMTok != null ? (totalTokens / 1_000_000) * costPerMTok : null

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            Output
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={copy}
            aria-label="Copy output to clipboard"
            className="inline-flex items-center gap-1 rounded p-1 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
          >
            {copied ? (
              <Check className="size-3.5 text-green-600" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="max-h-64 overflow-auto rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-800">
          {textOutput == null ? (
            // Structured output → syntax-highlighted JSON.
            <pre className="whitespace-pre-wrap break-words font-mono">
              {highlightJson(JSON.stringify(output, null, 2))}
            </pre>
          ) : verdict != null ? (
            // Yes/no verdict → a coloured token (green truthy, rose falsy).
            <span
              className={cn(
                'font-mono font-semibold',
                verdict.truthy ? 'text-green-700' : 'text-rose-700',
              )}
            >
              {verdict.label}
            </span>
          ) : (
            // Free-form text → markdown.
            <NoteMarkdown text={textOutput} />
          )}
        </div>
      </div>

      {steps.length > 0 ? (
        <details className="rounded-md border border-neutral-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-neutral-600">
            {steps.length} step{steps.length === 1 ? '' : 's'}
          </summary>
          <div className="space-y-2 border-t border-neutral-100 p-2.5">
            {steps.map((step) => (
              <div key={step.stepNumber} className="space-y-1">
                {step.reasoning?.trim() ? (
                  <div className="border-l-2 border-violet-200 pl-2">
                    <div className="mb-0.5 flex items-center gap-1 text-[9px] font-medium uppercase tracking-wide text-violet-400">
                      <Brain className="size-2.5" />
                      Reasoning
                    </div>
                    <p className="whitespace-pre-wrap break-words text-[11px] italic text-neutral-500">
                      {step.reasoning.trim()}
                    </p>
                  </div>
                ) : null}
                {step.text ? (
                  <p className="whitespace-pre-wrap break-words text-xs text-neutral-600">
                    {step.text}
                  </p>
                ) : null}
                {step.toolCalls.map((tc) => (
                  <ToolCallLine
                    key={tc.toolCallId}
                    call={tc}
                    mode={toolCallMode(
                      tc.toolName,
                      liveToolIds,
                      attachedToolIds,
                    )}
                  />
                ))}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <div className="text-[11px] text-neutral-400">
        {meta.model} · {totalTokens.toLocaleString()} tokens
        {cost != null ? ` · ${formatCost(cost)}` : null}
      </div>
    </div>
  )
}

/**
 * Whether this trace line's tool actually ran. A playground run freezes the
 * modes it was launched with, so the answer is a lookup, not a guess — and it
 * has to be shown per call: the trace used to badge EVERY call `simulated`,
 * which quietly told authors their live tool had been faked.
 *
 * A name that is neither live nor one of the agent's own tools is a synthesized
 * delegation tool (spawn/await a sub-agent). Those aren't part of the live /
 * simulated split, so they get no badge rather than a wrong one.
 */
function toolCallMode(
  toolName: string,
  liveToolIds: readonly string[],
  attachedToolIds: readonly string[],
): 'live' | 'simulated' | 'other' {
  if (liveToolIds.includes(toolName)) return 'live'
  if (attachedToolIds.includes(toolName)) return 'simulated'
  return 'other'
}

// A tool result can be an entire extracted document; render enough to judge it
// and say what was cut rather than pushing megabytes into the DOM.
const MAX_RESULT_CHARS = 4000

/**
 * One tool call in the step trace: what was called, whether it ran for real, the
 * arguments the agent chose, and what came back. The result is the evidence that
 * a live tool really executed — a simulated one returns the model's invention,
 * and side by side the difference is obvious.
 */
function ToolCallLine({
  call,
  mode,
}: {
  call: { toolName: string; input: unknown; output: unknown }
  mode: 'live' | 'simulated' | 'other'
}) {
  const output =
    call.output == null ? null : JSON.stringify(call.output, null, 2)
  const clipped = output != null && output.length > MAX_RESULT_CHARS

  return (
    <div className="rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px] text-neutral-500">
      <div className="flex items-start gap-1.5">
        <Wrench className="mt-0.5 size-3 shrink-0" />
        <span className="break-words">
          <span className="font-medium text-neutral-700">{call.toolName}</span>
          {mode === 'other' ? null : (
            <span
              className={cn(
                'ml-1 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide',
                mode === 'live'
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-amber-100 text-amber-700',
              )}
            >
              {mode}
            </span>
          )}
          {call.input != null ? ` ${JSON.stringify(call.input)}` : null}
        </span>
      </div>
      {output != null ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-neutral-400">
            result
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-white px-2 py-1 font-mono text-[10px] text-neutral-600">
            {highlightJson(
              clipped ? `${output.slice(0, MAX_RESULT_CHARS)}…` : output,
            )}
          </pre>
          {clipped ? (
            <p className="mt-0.5 text-[10px] text-neutral-400">
              Truncated — {output.length.toLocaleString()} characters in full.
            </p>
          ) : null}
        </details>
      ) : null}
    </div>
  )
}
