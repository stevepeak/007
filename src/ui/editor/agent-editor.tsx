import { AlertTriangle, Archive, Loader2, Play, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { inferPromptVariables, type AgentConfig } from '../../engine'
import type { AgentPreviewResult, JsonSchema } from '../../server/protocol'
import { WfAutoForm } from '../autoform/wf-auto-form'
import {
  AGENT_COLORS,
  AGENT_ICONS,
  agentColor,
  agentIcon,
  DEFAULT_AGENT_COLOR,
} from '../agent-appearance'
import { cn } from '../cn'
import { useWfClient, useWfComponents } from '../context'
import { HoldButton } from '../hold-button'
import {
  useAgent,
  useAgentReferences,
  useArchiveAgent,
  usePublishAgent,
  useRunAgentPreview,
  useSaveAgentDraft,
  useTools,
  useUpdateAgentMeta,
} from '../hooks'
import { useOpenAsset, useWfNav } from '../nav'
import { WfShell } from '../shell'
import { Tooltip } from '../tooltip'
import { AgentOutputEditor } from './agent-output-editor'
import { ModelSelect } from './model-select'
import { PromptBodyEditor } from './prompt-body-editor'
import { ToolPicker } from './tool-picker'

// The agent editor — same draft/version lifecycle as the prompt editor, but
// over the whole AgentConfig (model, prompt, tools, expected output, advanced),
// plus the entity's appearance (icon + color) which saves immediately. A
// disabled Playground panel previews where isolated test runs will live.

export type AgentEditorProps = {
  agentId: string
  className?: string
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}

export function AgentEditor({
  agentId,
  className,
  onPublished,
}: AgentEditorProps) {
  const { data, isLoading, error } = useAgent(agentId)

  if (isLoading) {
    return (
      <div className={cn('p-4 text-sm text-neutral-500', className)}>
        Loading…
      </div>
    )
  }
  if (error) {
    return (
      <div className={cn('p-4 text-sm text-red-600', className)}>
        {(error as Error).message}
      </div>
    )
  }
  const initialConfig = data?.draft?.config ?? data?.currentVersion?.config
  if (!data || !initialConfig) {
    return (
      <div className={cn('p-4 text-sm text-neutral-500', className)}>
        Agent has no configuration yet.
      </div>
    )
  }

  return (
    <AgentEditorInner
      agentId={agentId}
      initialConfig={initialConfig}
      initialName={data.agent.name}
      initialIcon={data.agent.icon ?? AGENT_ICONS[0].name}
      initialColor={data.agent.color ?? DEFAULT_AGENT_COLOR}
      className={className}
      onPublished={onPublished}
    />
  )
}

function AgentEditorInner({
  agentId,
  initialConfig,
  initialName,
  initialIcon,
  initialColor,
  className,
  onPublished,
}: {
  agentId: string
  initialConfig: AgentConfig
  initialName: string
  initialIcon: string
  initialColor: string
  className?: string
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}) {
  const { Button, Label, Input } = useWfComponents()
  const tools = useTools()
  const aiTools = (tools.data ?? []).filter((t) => t.kind === 'ai-tool')

  const [config, setConfig] = useState<AgentConfig>(initialConfig)
  const [name, setName] = useState(initialName)
  const [icon, setIcon] = useState(initialIcon)
  const [color, setColor] = useState(initialColor)
  const [savedConfig, setSavedConfig] = useState<AgentConfig>(initialConfig)
  const [savedName, setSavedName] = useState(initialName)
  const [showPublish, setShowPublish] = useState(false)
  const [showArchive, setShowArchive] = useState(false)

  const saveDraft = useSaveAgentDraft()
  const publish = usePublishAgent()
  const updateMeta = useUpdateAgentMeta()
  const { navigate } = useWfNav()

  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig)
  const saveError =
    (saveDraft.error as Error | null)?.message ??
    (publish.error as Error | null)?.message ??
    null

  function patch(next: Partial<AgentConfig>) {
    setConfig((c) => ({ ...c, ...next }))
  }

  function commitRename() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === savedName) {
      setName(savedName)
      return
    }
    setName(trimmed)
    setSavedName(trimmed)
    updateMeta.mutate({ agentId, name: trimmed })
  }

  // Appearance saves immediately (it's entity metadata, not versioned).
  function selectIcon(next: string) {
    setIcon(next)
    updateMeta.mutate({ agentId, icon: next })
  }
  function selectColor(next: string) {
    setColor(next)
    updateMeta.mutate({ agentId, color: next })
  }

  function onSaveDraft() {
    saveDraft.mutate(
      { agentId, config },
      { onSuccess: () => setSavedConfig(config) },
    )
  }

  function onPublish(changeNote: string) {
    publish.mutate(
      { agentId, config, changeNote: changeNote.trim() || undefined },
      {
        onSuccess: (result) => {
          setSavedConfig(config)
          setShowPublish(false)
          onPublished?.(result)
        },
      },
    )
  }

  return (
    <>
      <WfShell
        className={className}
        scroll
        titleIcon={(() => {
          const Icon = agentIcon(icon)
          return (
            <span
              className={cn(
                'flex size-7 items-center justify-center rounded-md',
                agentColor(color).chip,
              )}
            >
              <Icon className="size-4" />
            </span>
          )
        })()}
        assetLabel="Agent"
        crumbs={[
          {
            editable: {
              value: name,
              onChange: setName,
              onCommit: commitRename,
              ariaLabel: 'Agent name',
            },
          },
        ]}
        actions={
          <>
            <Tooltip
              side="bottom"
              content={
                dirty
                  ? 'You have unsaved changes'
                  : 'All configuration changes saved'
              }
            >
              <span
                className={cn(
                  'flex items-center gap-1.5 text-xs',
                  dirty ? 'text-amber-600' : 'text-neutral-400',
                )}
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    dirty ? 'bg-amber-500' : 'bg-neutral-300',
                  )}
                />
                {dirty ? 'Unsaved' : 'Saved'}
              </span>
            </Tooltip>
            {saveError ? (
              <span className="text-xs text-red-600">{saveError}</span>
            ) : null}
            <Tooltip content="Archive" side="bottom">
              <button
                type="button"
                aria-label="Archive"
                onClick={() => setShowArchive(true)}
                className="inline-flex size-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
              >
                <Archive className="size-4" />
              </button>
            </Tooltip>
            <Button
              variant="outline"
              size="sm"
              onClick={onSaveDraft}
              disabled={saveDraft.isPending}
            >
              {saveDraft.isPending ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              size="sm"
              onClick={() => setShowPublish(true)}
              disabled={publish.isPending}
            >
              Publish
            </Button>
          </>
        }
      >
        <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_20rem]">
          {/* Left: configuration */}
          <div className="space-y-6">
            {/* Appearance */}
            <section className="space-y-2">
              <Label>Appearance</Label>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex flex-wrap gap-1.5">
                  {AGENT_ICONS.map(({ name: iconName, Icon }) => (
                    <button
                      key={iconName}
                      type="button"
                      aria-label={iconName}
                      onClick={() => selectIcon(iconName)}
                      className={cn(
                        'flex size-9 items-center justify-center rounded-md border transition',
                        icon === iconName
                          ? cn('border-transparent', agentColor(color).chip)
                          : 'border-neutral-200 text-neutral-500 hover:border-neutral-300',
                      )}
                    >
                      <Icon className="size-4" />
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {AGENT_COLORS.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      aria-label={c.key}
                      onClick={() => selectColor(c.key)}
                      className={cn(
                        'size-6 rounded-full transition',
                        c.swatch,
                        color === c.key
                          ? 'ring-2 ring-neutral-900 ring-offset-2'
                          : 'opacity-70 hover:opacity-100',
                      )}
                    />
                  ))}
                </div>
              </div>
            </section>

            {/* Model */}
            <section className="space-y-1">
              <Label>Model</Label>
              <ModelSelect
                value={config.modelId}
                onChange={(modelId) => patch({ modelId })}
                // Gate the picker on what THIS agent needs: a tool-calling model
                // when tools are attached, and structured output for object output.
                requirements={{
                  tools: config.toolIds.length > 0,
                  structuredOutput: config.output.kind === 'object',
                }}
              />
            </section>

            {/* Prompt */}
            <section className="space-y-1">
              <Label>Prompt</Label>
              <PromptBodyEditor
                initialBody={initialConfig.prompt}
                onChange={(body) => patch({ prompt: body })}
              />
            </section>

            {/* Tools */}
            <section className="space-y-1">
              <Label>Tools</Label>
              <ToolPicker
                tools={aiTools}
                selectedIds={config.toolIds}
                onChange={(toolIds) => patch({ toolIds })}
              />
            </section>

            {/* Expected output */}
            <section className="space-y-1">
              <Label>Expected output</Label>
              <AgentOutputEditor
                value={config.output}
                onChange={(output) => patch({ output })}
              />
            </section>

            {/* Settings */}
            <section className="space-y-4">
              <Label>Settings</Label>
              <div className="space-y-4 border-l-2 border-neutral-100 pl-4">
                <div className="space-y-1">
                  <Label>Max turns</Label>
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    className="max-w-[8rem]"
                    value={config.maxTurns}
                    onChange={(e) =>
                      patch({
                        maxTurns: Number.parseInt(e.target.value, 10) || 1,
                      })
                    }
                  />
                  <p className="text-xs text-neutral-400">
                    How many turns the agent may take before it must give a
                    final answer. Each turn is one round of calling tools and
                    reading their results; a higher limit lets the agent do more
                    research but costs more and runs longer. Defaults to 5.
                  </p>
                </div>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
                    <input
                      type="checkbox"
                      checked={config.exposeThinking}
                      onChange={(e) =>
                        patch({ exposeThinking: e.target.checked })
                      }
                    />
                    Expose thinking to user
                  </label>
                  <p className="text-xs text-neutral-400">
                    Stream the agent's step-by-step reasoning to the user as it
                    works, instead of only showing the final answer. Useful for
                    transparency, but exposes intermediate notes.
                  </p>
                </div>
              </div>
            </section>
          </div>

          {/* Right: playground — runs the live draft config in isolation */}
          <PlaygroundPanel config={config} />
        </div>
      </WfShell>

      {showPublish ? (
        <PublishAgentDialog
          agentId={agentId}
          publishing={publish.isPending}
          error={(publish.error as Error | null)?.message ?? null}
          onCancel={() => setShowPublish(false)}
          onConfirm={onPublish}
        />
      ) : null}

      {showArchive ? (
        <ArchiveAgentDialog
          agentId={agentId}
          agentName={name}
          onClose={() => setShowArchive(false)}
          onArchived={() => {
            setShowArchive(false)
            navigate('agents')
          }}
        />
      ) : null}
    </>
  )
}

// Archive flow — before letting the user retire an agent, check whether any
// workflow still references it (in its draft or latest published version). If so
// we BLOCK archiving and list those workflows so the user can go disconnect the
// agent first; only a truly unreferenced agent can be hold-to-archived.
function ArchiveAgentDialog({
  agentId,
  agentName,
  onClose,
  onArchived,
}: {
  agentId: string
  agentName: string
  onClose: () => void
  onArchived: () => void
}) {
  const { Button } = useWfComponents()
  const openAsset = useOpenAsset()
  const refs = useAgentReferences(agentId, true)
  const archive = useArchiveAgent()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const workflows = refs.data?.workflows ?? []
  const blocked = workflows.length > 0
  const archiveError = (archive.error as Error | null)?.message ?? null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Archive className="size-4 text-neutral-500" />
            Archive agent
          </h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="text-neutral-400 transition hover:text-neutral-700"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="px-5 py-4 text-sm leading-relaxed text-neutral-600">
          {refs.isLoading ? (
            <span className="flex items-center gap-2 text-neutral-500">
              <Loader2 className="size-4 animate-spin" />
              Checking for workflows using this agent…
            </span>
          ) : refs.error ? (
            <span className="text-red-600">
              {(refs.error as Error).message}
            </span>
          ) : blocked ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  <strong>{agentName || 'This agent'}</strong> is used by{' '}
                  <strong>
                    {workflows.length} workflow
                    {workflows.length === 1 ? '' : 's'}
                  </strong>
                  . Disconnect it from each before archiving.
                </span>
              </div>
              <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
                {workflows.map((wf) => (
                  <li key={wf.id}>
                    <button
                      type="button"
                      onClick={() => openAsset(`${wf.id}/edit`)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50"
                    >
                      <span className="min-w-0 truncate text-neutral-800">
                        {wf.name || 'Untitled workflow'}
                      </span>
                      <span className="shrink-0 text-xs text-neutral-400">
                        Open →
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <span>
              Archive <strong>{agentName || 'this agent'}</strong>? It'll be
              removed from your agents list and can no longer be added to
              workflows. Existing runs are unaffected.
            </span>
          )}
          {archiveError ? (
            <p className="mt-2 text-xs text-red-600">{archiveError}</p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            {blocked ? 'Close' : 'Cancel'}
          </Button>
          {!refs.isLoading && !refs.error && !blocked ? (
            <HoldButton
              size="md"
              tone="danger"
              title="Hold to archive"
              onHold={() => archive.mutate(agentId, { onSuccess: onArchived })}
            >
              <Archive className="size-4" />
              Hold to archive
            </HoldButton>
          ) : null}
        </div>
      </div>
    </div>
  )
}

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

function PlaygroundPanel({ config }: { config: AgentConfig }) {
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
    </aside>
  )
}

// Renders one completed playground run: the final answer, an optional
// step-by-step trace (thinking text + tool calls), and total token usage.
function PlaygroundResult({ result }: { result: AgentPreviewResult }) {
  const { output, meta } = result
  const finalText =
    'text' in output && typeof output.text === 'string'
      ? output.text
      : JSON.stringify(output, null, 2)
  const steps = meta.steps.filter((s) => s.text || s.toolCalls.length > 0)
  const totalTokens = meta.totalUsage.inputTokens + meta.totalUsage.outputTokens

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          Output
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-800">
          {finalText}
        </pre>
      </div>

      {steps.length > 0 ? (
        <details className="rounded-md border border-neutral-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-neutral-600">
            {steps.length} step{steps.length === 1 ? '' : 's'}
          </summary>
          <div className="space-y-2 border-t border-neutral-100 p-2.5">
            {steps.map((step) => (
              <div key={step.stepNumber} className="space-y-1">
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
      </div>
    </div>
  )
}

// Publish flow — warns how many workflows reference this agent (they float to
// the latest published version and update immediately).
function PublishAgentDialog({
  agentId,
  publishing,
  error,
  onCancel,
  onConfirm,
}: {
  agentId: string
  publishing: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (changeNote: string) => void
}) {
  const { Button, Textarea } = useWfComponents()
  const client = useWfClient()
  const [note, setNote] = useState('')
  const [refCount, setRefCount] = useState<number | null>(null)

  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void client
      .countAgentReferences(agentId)
      .then((r) => setRefCount(r.workflows))
      .catch(() => setRefCount(0))
  }, [client, agentId])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-xl">
        <h2 className="mb-1 text-base font-semibold text-neutral-900">
          Publish new version
        </h2>
        <p className="mb-3 text-sm text-neutral-500">
          Publishing makes this the live version. Add an optional note
          describing the change — it's saved with the version.
        </p>

        {refCount != null && refCount > 0 ? (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>
                {refCount} workflow{refCount === 1 ? '' : 's'}
              </strong>{' '}
              reference this agent and will use the new version immediately.
            </span>
          </div>
        ) : null}

        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Describe the changes in this version…"
          className="w-full"
        />

        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm(note)}
            disabled={publishing}
          >
            {publishing ? 'Publishing…' : 'Publish version'}
          </Button>
        </div>
      </div>
    </div>
  )
}
