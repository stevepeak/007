import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  Copy,
  History,
  Loader2,
  Play,
  Wrench,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { inferPromptVariables, type AgentConfig } from '../../engine'
import type { AgentPreviewResult, JsonSchema } from '../../server/protocol'
import { WfAutoForm } from '../autoform/wf-auto-form'
import { cn } from '../cn'
import { formatRelative, formatTimestamp } from '../cost'
import { highlightJson } from '../data-view'
import { useModels, useRunAgentPreview } from '../hooks'
import { Tooltip } from '../tooltip'
import { NoteMarkdown } from './note-markdown'

// Playground — runs the editor's live draft config in isolation (no graph, no
// persistence) and shows the final answer plus the per-step thinking/tool-call
// trace. Runs the *draft*, so unsaved edits are testable without publishing.
//
// An agent's inputs are the `${…}` variables in its prompt (inferred live), so
// the form renders one field per variable — e.g. a classifier reading
// `${title}`/`${text}` gets a field for each. An agent with no variables gets a
// single free-form message box instead. Both are expressed as a JSON Schema and
// rendered through the same AutoForm playground as tools.
function agentInputSchema(variables: string[]): JsonSchema {
  const names = variables.length > 0 ? variables : ['input']
  return {
    type: 'object',
    required: names,
    properties: Object.fromEntries(
      names.map((name) => [
        name,
        {
          type: 'string',
          title: variables.length > 0 ? name : 'Test input',
          format: 'textarea',
        },
      ]),
    ),
  }
}

/** One playground run, kept in the editor's history until the page is left. */
type PlaygroundRun = {
  id: number
  startedAt: number
  status: 'running' | 'done' | 'error'
  /**
   * The exact draft this run executed, frozen. `config` is only ever replaced
   * wholesale by the editor's `patch`, so holding the reference IS the snapshot
   * — and it's what makes a run restorable: a result is only evidence if you can
   * get back to the configuration that produced it.
   */
  config: AgentConfig
  /** What was submitted — one entry per prompt variable, or `input`. */
  input: Record<string, string>
  result: AgentPreviewResult | null
  error: string | null
}

// The fields a restore actually moves, in the order the editor shows them.
// Used to tell you what a run's snapshot would change before you take it.
const CONFIG_FIELDS: { key: keyof AgentConfig; label: string }[] = [
  { key: 'modelId', label: 'model' },
  { key: 'prompt', label: 'prompt' },
  { key: 'toolIds', label: 'tools' },
  { key: 'subAgents', label: 'sub-agents' },
  { key: 'output', label: 'output' },
  { key: 'maxTurns', label: 'max turns' },
  { key: 'toolTokenBudget', label: 'token budget' },
  { key: 'answerReservePercent', label: 'answer reserve' },
  { key: 'requireToolFirstTurn', label: 'tool-first' },
  { key: 'acceptsConversation', label: 'conversation' },
]

function changedFields(a: AgentConfig, b: AgentConfig): string[] {
  return CONFIG_FIELDS.filter(
    (f) => JSON.stringify(a[f.key]) !== JSON.stringify(b[f.key]),
  ).map((f) => f.label)
}

export function PlaygroundPanel({
  config,
  onRestore,
}: {
  config: AgentConfig
  /** Load a run's frozen config back into the editor. */
  onRestore?: (config: AgentConfig) => void
}) {
  const variables = useMemo(
    () => inferPromptVariables(config.prompt),
    [config.prompt],
  )
  const hasVars = variables.length > 0
  const schema = useMemo(() => agentInputSchema(variables), [variables])

  const run = useRunAgentPreview()
  // Every run this session, newest first. Each keeps its own status, result and
  // config, so comparing two prompts is "run, edit, run" and both answers stay
  // on screen — the previous behaviour showed only the latest, which made the
  // comparison the whole panel exists for impossible.
  const [runs, setRuns] = useState<PlaygroundRun[]>([])
  // Accordion: a new run opens itself and collapses the rest, so the column
  // doesn't grow without bound as runs pile up.
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const nextId = useRef(1)
  const pending = runs.some((r) => r.status === 'running')

  function onRun(values: Record<string, unknown>) {
    const input: Record<string, string> = hasVars
      ? Object.fromEntries(
          variables.map((v) => [v, String(values[v] ?? '').trim()]),
        )
      : { input: String(values.input ?? '').trim() }

    const id = nextId.current++
    const snapshot = config
    setRuns((prev) => [
      {
        id,
        startedAt: Date.now(),
        status: 'running',
        config: snapshot,
        input,
        result: null,
        error: null,
      },
      ...prev,
    ])
    setExpandedId(id)

    // `mutateAsync` rather than `mutate` because the result has to land on THIS
    // run's card: the mutation object only ever holds the most recent call's
    // data, which a second run would overwrite.
    void run
      .mutateAsync(
        hasVars
          ? { config: snapshot, promptVariables: input }
          : { config: snapshot, input: input.input },
      )
      .then(
        (result) =>
          setRuns((prev) =>
            prev.map((r) =>
              r.id === id ? { ...r, status: 'done', result } : r,
            ),
          ),
        (err: unknown) =>
          setRuns((prev) =>
            prev.map((r) =>
              r.id === id
                ? {
                    ...r,
                    status: 'error',
                    error: err instanceof Error ? err.message : String(err),
                  }
                : r,
            ),
          ),
      )
  }

  return (
    <div className="space-y-3">
      <aside className="h-fit space-y-3 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-neutral-700">
          <Play className="size-4" />
          Playground
        </div>
        <p className="text-xs text-neutral-500">
          Run this agent in isolation and watch its output — without wiring it
          into a workflow. Uses your current unsaved edits, and every run keeps
          the configuration it ran on so you can go back to it.
        </p>
        {config.toolIds.length > 0 ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
            Tools are <strong>simulated</strong> here — the agent picks tools
            and arguments as normal, but results are faked by the model. Nothing
            real runs and no data is changed.
          </p>
        ) : null}

        <WfAutoForm
          schema={schema}
          disabled={pending}
          pending={pending}
          submitLabel="Run agent"
          submitIcon={<Play className="size-3.5" />}
          onSubmit={onRun}
        />
      </aside>

      {runs.map((r) => (
        <PlaygroundRunCard
          key={r.id}
          run={r}
          number={r.id}
          expanded={expandedId === r.id}
          onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
          changed={changedFields(r.config, config)}
          onRestore={onRestore ? () => onRestore(r.config) : undefined}
        />
      ))}
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
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              Input
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

          {run.result ? <PlaygroundResult result={run.result} /> : null}

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
  const joined = values.join(' · ').replace(/\s+/g, ' ')
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
  return t in VERDICTS ? { label: text.trim(), truthy: VERDICTS[t] } : null
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
function PlaygroundResult({ result }: { result: AgentPreviewResult }) {
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
    void navigator.clipboard?.writeText(copyText).then(() => {
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
                  <div
                    key={tc.toolCallId}
                    className="flex items-start gap-1.5 rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px] text-neutral-500"
                  >
                    <Wrench className="mt-0.5 size-3 shrink-0" />
                    <span className="break-words">
                      <span className="font-medium text-neutral-700">
                        {tc.toolName}
                      </span>
                      <span className="ml-1 rounded bg-amber-100 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-amber-700">
                        simulated
                      </span>
                      {tc.input != null ? ` ${JSON.stringify(tc.input)}` : null}
                    </span>
                  </div>
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
