import { AlertTriangle, Layers, Play, SlidersHorizontal } from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  ToolContextField,
  ToolOption,
  WfToolInvocation,
} from '../server/protocol'
import { cn } from './cn'
import { useWfComponents } from './context'
import { DataView } from './data-view'
import {
  useRunToolPreview,
  useToolContextFields,
  useToolInvocations,
  useTools,
} from './hooks'
import { useWfNav } from './nav'
import { ToolForm } from './tool-form'
import { ToolIcon } from './tool-icon'

// The tool detail page: one tool's identity, a real-execution playground, and
// its recent calls pulled from run history. Reached by clicking a card on the
// tools list (`tools/<toolId>`).
//
// The playground runs the ACTUAL tool with the host's live deps — it is not a
// simulation. That's a deliberate, clearly-flagged action (see the warning
// banner): a real call can hit external services, cost money, and mutate data.

const stepStatusClass: Record<string, string> = {
  completed: 'bg-green-100 text-green-700 border-green-200',
  running: 'bg-blue-100 text-blue-700 border-blue-200',
  failed: 'bg-red-100 text-red-700 border-red-200',
  skipped: 'bg-neutral-100 text-neutral-500 border-neutral-200',
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export type ToolDetailProps = {
  toolId: string
  className?: string
}

export function ToolDetail({ toolId, className }: ToolDetailProps) {
  const { data: tools, isLoading, error } = useTools()
  const tool = tools?.find((t) => t.id === toolId)

  if (isLoading) {
    return <div className="p-6 text-sm text-neutral-500">Loading…</div>
  }
  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {(error as Error).message}
        </div>
      </div>
    )
  }
  if (!tool) {
    return (
      <div className="p-6 text-sm text-neutral-500">
        Tool <span className="font-mono text-neutral-700">{toolId}</span> is not
        registered for this tenant.
      </div>
    )
  }

  return (
    <div className={cn('mx-auto max-w-3xl space-y-8 p-6', className)}>
      <ToolHeader tool={tool} />
      <Playground tool={tool} />
      <RecentCalls toolId={tool.id} />
    </div>
  )
}

function ToolHeader({ tool }: { tool: ToolOption }) {
  const { Badge } = useWfComponents()
  return (
    <div className="flex items-start gap-4">
      <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100">
        <ToolIcon icon={tool.icon} className="size-7" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-xl font-semibold text-neutral-900">
            {tool.name}
          </h1>
          <Badge className="border border-neutral-200 bg-neutral-50 text-neutral-500">
            {tool.kind === 'function' ? 'function' : 'AI tool'}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          {tool.description || 'No description yet.'}
        </p>
        <p className="mt-1 font-mono text-[11px] text-neutral-400">{tool.id}</p>
      </div>
    </div>
  )
}

function Playground({ tool }: { tool: ToolOption }) {
  const { Button } = useWfComponents()
  const [args, setArgs] = useState<Record<string, unknown> | null>({})
  const [context, setContext] = useState<Record<string, string>>({})
  const contextFields = useToolContextFields()
  const run = useRunToolPreview(tool.id)

  const fields = contextFields.data ?? []
  // Required context (e.g. which client to scope to) must be filled before a
  // real run — otherwise the tool would silently run against the wrong scope.
  const missingContext = useMemo(
    () => fields.filter((f) => f.required && !(context[f.key]?.trim())),
    [fields, context],
  )
  const canRun =
    !run.isPending && args !== null && missingContext.length === 0

  const submit = () => {
    if (!canRun || !args) return
    // Only send filled context keys — the host maps them into the run scope.
    const filled: Record<string, string> = {}
    for (const [k, v] of Object.entries(context)) {
      if (v.trim()) filled[k] = v
    }
    run.mutate({ toolId: tool.id, args, context: filled })
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-neutral-900">Playground</h2>
        <p className="text-sm text-neutral-500">
          Run this tool with arguments and context you supply.
        </p>
      </div>

      <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div>
          <span className="font-medium">This runs for real.</span> The actual
          tool executes with live credentials — it may call external services,
          incur cost, and read or modify real data. This is not a simulation.
        </div>
      </div>

      {/* Context — the ambient run scope. Its own card, tinted and left-barred
          to read as "injected by the environment, not typed by the agent". */}
      {fields.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-indigo-200 bg-indigo-50/40">
          <div className="border-b border-indigo-100 bg-indigo-50/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <Layers className="size-4 text-indigo-500" />
              <h3 className="text-sm font-semibold text-indigo-900">Context</h3>
            </div>
            <p className="mt-1 text-xs text-indigo-700/70">
              Injected by the run environment, not the agent. Scopes the tool
              (e.g. to a client) — an agent never sees or sets these.
            </p>
          </div>
          <div className="space-y-4 p-4">
            {fields.map((f) => (
              <ContextField
                key={f.key}
                field={f}
                value={context[f.key] ?? ''}
                disabled={run.isPending}
                onChange={(v) => setContext((c) => ({ ...c, [f.key]: v }))}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Arguments — what an agent/upstream node supplies. Plain card. */}
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <div className="border-b border-neutral-100 bg-neutral-50 px-4 py-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-neutral-400" />
            <h3 className="text-sm font-semibold text-neutral-900">Arguments</h3>
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            The inputs an agent (or an upstream node) passes to this tool.
          </p>
        </div>
        <div className="p-4">
          <ToolForm
            schema={tool.inputSchema}
            disabled={run.isPending}
            onArgsChange={setArgs}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={submit}
          disabled={!canRun}
          title={
            missingContext.length > 0
              ? `Provide ${missingContext.map((f) => f.label).join(', ')} first`
              : args === null
                ? 'Fix the highlighted argument before running'
                : undefined
          }
        >
          <Play className="size-4" />
          {run.isPending ? 'Running…' : 'Run tool for real'}
        </Button>
        {args === null ? (
          <span className="text-xs text-red-600">
            An argument isn&apos;t valid JSON yet.
          </span>
        ) : missingContext.length > 0 ? (
          <span className="text-xs text-neutral-500">
            Provide{' '}
            <span className="font-medium text-neutral-700">
              {missingContext.map((f) => f.label).join(', ')}
            </span>{' '}
            to run.
          </span>
        ) : null}
      </div>

      {run.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {(run.error as Error).message}
        </div>
      ) : null}

      {run.data ? (
        <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-900">Result</h3>
            <span className="text-xs text-neutral-400">
              {run.data.durationMs.toLocaleString()} ms
            </span>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium text-neutral-500">
              Arguments sent
            </div>
            <DataView value={run.data.args} />
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium text-neutral-500">
              Output
            </div>
            <DataView value={run.data.output} />
          </div>
        </div>
      ) : null}
    </section>
  )
}

function ContextField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ToolContextField
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const { Input, Label } = useWfComponents()
  const id = `tool-ctx-${field.key}`
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {field.label}
        {field.required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </Label>
      {field.description ? (
        <p className="text-xs text-neutral-500">{field.description}</p>
      ) : null}
      <Input
        id={id}
        value={value}
        disabled={disabled}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm"
      />
    </div>
  )
}

function RecentCalls({ toolId }: { toolId: string }) {
  const { data, isLoading, error } = useToolInvocations(toolId)

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-neutral-900">
          Recent calls
        </h2>
        <p className="text-sm text-neutral-500">
          The latest times this tool ran inside a workflow.
        </p>
      </div>

      {isLoading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {(error as Error).message}
        </div>
      ) : null}
      {data && data.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-200 p-6 text-center text-sm text-neutral-500">
          This tool hasn&apos;t been called in any run yet.
        </div>
      ) : null}

      <div className="space-y-2">
        {data?.map((inv, i) => <InvocationRow key={`${inv.runId}-${i}`} inv={inv} />)}
      </div>
    </section>
  )
}

function InvocationRow({ inv }: { inv: WfToolInvocation }) {
  const { Badge } = useWfComponents()
  const { navigate } = useWfNav()
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-xl border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-3 text-left"
      >
        <Badge className={cn('border', stepStatusClass[inv.status])}>
          {inv.status}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-700">
          {inv.workflowName ?? '(unknown workflow)'}
        </span>
        <span className="shrink-0 text-xs text-neutral-400">
          {inv.startedAt ? fmtTime(inv.startedAt) : '—'}
        </span>
        <span className="text-xs text-neutral-400">{open ? '▾' : '▸'}</span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-neutral-100 p-3">
          {inv.error ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {inv.error}
            </div>
          ) : null}
          <div>
            <div className="mb-1 text-[11px] font-medium text-neutral-500">
              Arguments
            </div>
            <DataView value={inv.args} />
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium text-neutral-500">
              Output
            </div>
            <DataView value={inv.output} />
          </div>
          <button
            type="button"
            onClick={() => navigate(`runs/${inv.runId}`)}
            className="text-xs font-medium text-neutral-600 underline-offset-2 hover:underline"
          >
            View full run →
          </button>
        </div>
      ) : null}
    </div>
  )
}
