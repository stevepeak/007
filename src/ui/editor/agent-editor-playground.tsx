import { AlertTriangle, Brain, Loader2, Play, Wrench } from 'lucide-react'
import { useMemo } from 'react'

import { inferPromptVariables, type AgentConfig } from '../../engine'
import type { AgentPreviewResult, JsonSchema } from '../../server/protocol'
import { WfAutoForm } from '../autoform/wf-auto-form'
import { cn } from '../cn'
import { highlightJson } from '../data-view'
import { useModels, useRunAgentPreview } from '../hooks'
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

export function PlaygroundPanel({ config }: { config: AgentConfig }) {
  const variables = useMemo(
    () => inferPromptVariables(config.prompt),
    [config.prompt],
  )
  const hasVars = variables.length > 0
  const schema = useMemo(() => agentInputSchema(variables), [variables])

  const run = useRunAgentPreview()
  const result = run.data
  const error = (run.error as Error | null)?.message ?? null

  function onRun(values: Record<string, unknown>) {
    if (hasVars) {
      const promptVariables: Record<string, string> = {}
      for (const v of variables) {
        promptVariables[v] = String(values[v] ?? '').trim()
      }
      run.mutate({ config, promptVariables })
    } else {
      run.mutate({ config, input: String(values.input ?? '').trim() })
    }
  }

  return (
    <aside className="h-fit space-y-3 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-neutral-700">
        <Play className="size-4" />
        Playground
      </div>
      <p className="text-xs text-neutral-500">
        Run this agent in isolation and watch its output — without wiring it
        into a workflow. Uses your current unsaved edits.
      </p>
      {config.toolIds.length > 0 ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
          Tools are <strong>simulated</strong> here — the agent picks tools and
          arguments as normal, but results are faked by the model. Nothing real
          runs and no data is changed.
        </p>
      ) : null}

      <WfAutoForm
        schema={schema}
        disabled={run.isPending}
        pending={run.isPending}
        submitLabel="Run agent"
        submitIcon={<Play className="size-3.5" />}
        onSubmit={onRun}
      />

      {/* Breathing room between the Run button and the run output below it. */}
      <div className="space-y-3 pt-2">
        {error ? (
          <div className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {run.isPending && !result ? (
          <div className="flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-400">
            <Loader2 className="size-3.5 animate-spin" />
            Waiting for the agent…
          </div>
        ) : null}

        {result && !run.isPending && !error ? (
          <PlaygroundResult result={result} />
        ) : null}
      </div>
    </aside>
  )
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
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '')
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
        <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          Output
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
