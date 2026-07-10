import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

import type { WorkflowNode } from '../engine'
import type { AgentNodeMeta, WfRunStepDTO } from '../server/protocol'
import { useWfComponents } from './context'
import { cn } from './cn'

// The run viewer's bottom dock (DevTools-style, like the editor's Data/Issues
// dock): it focuses on ONE node — whichever is selected on the run graph — and
// shows that step's Input / Logs / Output. The graph itself is the node list, so
// there's no list here. Collapsible via the active tab or the chevron.

type DockTab = 'input' | 'logs' | 'output'

const statusBadge: Record<string, string> = {
  completed: 'bg-green-100 text-green-700 border-green-200',
  running: 'bg-blue-100 text-blue-700 border-blue-200',
  failed: 'bg-red-100 text-red-700 border-red-200',
  skipped: 'bg-neutral-100 text-neutral-500 border-neutral-200',
  queued: 'bg-amber-100 text-amber-700 border-amber-200',
}

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-neutral-400">—</span>
  }
  return (
    <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-xs text-neutral-700">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export type RunNodeDockProps = {
  /** The node selected on the run graph, or null when nothing is selected. */
  node: WorkflowNode | null
  /** The recorded step for that node, or null if it never executed (skipped). */
  step: WfRunStepDTO | null
}

export function RunNodeDock({ node, step }: RunNodeDockProps) {
  const { Badge } = useWfComponents()
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<DockTab>('input')

  const tabs: { id: DockTab; label: string }[] = [
    { id: 'input', label: 'Input' },
    { id: 'logs', label: 'Logs' },
    { id: 'output', label: 'Output' },
  ]

  return (
    <div className="flex shrink-0 flex-col border-t border-neutral-200 bg-white">
      <div className="flex items-center gap-1 px-2">
        {tabs.map((t) => {
          const active = t.id === tab
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                // Clicking the active tab toggles the body, like DevTools.
                if (active) setOpen((o) => !o)
                else {
                  setTab(t.id)
                  setOpen(true)
                }
              }}
              className={cn(
                'border-b-2 px-2 py-1.5 text-xs font-medium transition-colors',
                active && open
                  ? 'border-neutral-800 text-neutral-800'
                  : 'border-transparent text-neutral-500 hover:text-neutral-700',
              )}
            >
              {t.label}
            </button>
          )
        })}
        <div className="flex-1" />
        {node ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[11px] text-neutral-400">
              {node.label}
            </span>
            {step ? (
              <Badge className={cn('border', statusBadge[step.status])}>
                {step.status}
              </Badge>
            ) : (
              <span className="text-[11px] text-neutral-400">not run</span>
            )}
          </span>
        ) : null}
        <button
          type="button"
          aria-label={open ? 'Collapse panel' : 'Expand panel'}
          onClick={() => setOpen((o) => !o)}
          className="ml-1 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
        >
          <ChevronDown
            className={cn('size-4 transition-transform', !open && 'rotate-180')}
          />
        </button>
      </div>

      {open ? (
        <div className="h-56 overflow-y-auto border-t border-neutral-100 p-3">
          {!node ? (
            <p className="text-xs text-neutral-500">
              Select a node on the graph to inspect its run.
            </p>
          ) : !step ? (
            <p className="text-xs text-neutral-500">
              This node didn&apos;t run — the branch it&apos;s on wasn&apos;t
              taken, or the run stopped before reaching it.
            </p>
          ) : tab === 'input' ? (
            <Json value={step.input} />
          ) : tab === 'output' ? (
            <Json value={step.output} />
          ) : (
            <LogsView step={step} />
          )}
        </div>
      ) : null}
    </div>
  )
}

// "Logs" for a step: whatever execution detail we captured — the error first,
// then a branch/judge decision, an agent's turn-by-turn trace, an iteration's
// per-item results, and finally any remaining meta as JSON.
function LogsView({ step }: { step: WfRunStepDTO }) {
  const branch = step.branchResult as {
    result?: string
    reasoning?: string
  } | null
  const agentMeta = asAgentMeta(step.meta)
  const iterMeta = asIterationMeta(step.meta)

  const hasAny =
    step.error || branch?.result || agentMeta || iterMeta || step.meta

  if (!hasAny) {
    return <p className="text-xs text-neutral-500">No logs for this step.</p>
  }

  return (
    <div className="space-y-3">
      {step.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs whitespace-pre-wrap text-red-700">
          {step.error}
        </div>
      ) : null}

      {branch?.result ? (
        <div className="text-xs">
          <span className="font-medium text-neutral-700">Decision:</span>{' '}
          <span className="font-mono">{branch.result}</span>
          {branch.reasoning ? (
            <span className="text-neutral-500"> — {branch.reasoning}</span>
          ) : null}
        </div>
      ) : null}

      {agentMeta ? <AgentTrace meta={agentMeta} /> : null}
      {iterMeta ? <IterationTrace meta={iterMeta} /> : null}

      {!agentMeta && !iterMeta && step.meta ? (
        <div>
          <div className="mb-1 text-[11px] font-medium text-neutral-500">
            Details
          </div>
          <Json value={step.meta} />
        </div>
      ) : null}
    </div>
  )
}

function AgentTrace({ meta }: { meta: AgentNodeMeta }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-neutral-500">
        <span className="font-medium text-neutral-600">{meta.model}</span> ·{' '}
        {meta.totalUsage.inputTokens + meta.totalUsage.outputTokens} tokens
      </div>
      {meta.steps.map((s) => (
        <div
          key={s.stepNumber}
          className="rounded-md border border-neutral-200 p-2"
        >
          <div className="mb-1 text-[11px] font-medium text-neutral-500">
            Turn {s.stepNumber + 1}
            {s.finishReason ? ` · ${s.finishReason}` : ''}
          </div>
          {s.text ? (
            <p className="text-xs whitespace-pre-wrap text-neutral-700">
              {s.text}
            </p>
          ) : null}
          {s.toolCalls.map((tc) => (
            <div key={tc.toolCallId} className="mt-1.5">
              <div className="text-[11px] font-medium text-sky-700">
                {tc.toolName}
              </div>
              <Json value={tc.input} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

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

// Narrowing helpers for the untyped `meta` JSON column.
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
