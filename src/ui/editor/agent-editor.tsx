import { Archive } from 'lucide-react'
import { useState } from 'react'

import { type AgentConfig } from '../../engine'
import {
  AGENT_COLORS,
  AGENT_ICONS,
  agentColor,
  agentIcon,
  DEFAULT_AGENT_COLOR,
} from '../agent-appearance'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import {
  useAgent,
  useModels,
  usePublishAgent,
  useSaveAgentDraft,
  useTools,
  useUpdateAgentMeta,
} from '../hooks'
import { useWfNav } from '../nav'
import { QueryState } from '../query-state'
import { WfShell } from '../shell'
import { SaveStateBadge } from '../save-state-badge'
import { Tooltip } from '../tooltip'
import { AgentOutputEditor } from './agent-output-editor'
import { ArchiveAgentDialog } from './agent-editor-archive'
import { PlaygroundPanel } from './agent-editor-playground'
import { PublishAgentDialog } from './agent-editor-publish'
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
  const query = useAgent(agentId)

  return (
    <QueryState
      query={query}
      loading={
        <div className={cn('p-4 text-sm text-neutral-500', className)}>
          Loading…
        </div>
      }
      error={(error) => (
        <div className={cn('p-4 text-sm text-red-600', className)}>
          {error.message}
        </div>
      )}
      isEmpty={(data) => !(data?.draft?.config ?? data?.currentVersion?.config)}
      empty={
        <div className={cn('p-4 text-sm text-neutral-500', className)}>
          Agent has no configuration yet.
        </div>
      }
    >
      {(data) => {
        const initialConfig = data.draft?.config ?? data.currentVersion?.config
        return initialConfig ? (
          <AgentEditorInner
            agentId={agentId}
            initialConfig={initialConfig}
            initialName={data.agent.name}
            initialIcon={data.agent.icon ?? AGENT_ICONS[0].name}
            initialColor={data.agent.color ?? DEFAULT_AGENT_COLOR}
            className={className}
            onPublished={onPublished}
          />
        ) : null
      }}
    </QueryState>
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
  const { Button, Label, Input, Checkbox } = useWfComponents()
  const tools = useTools()
  const aiTools = (tools.data ?? []).filter((t) => t.kind === 'ai-tool')

  const [config, setConfig] = useState<AgentConfig>(initialConfig)
  // What the currently-selected model can do. The picker only offers models
  // that meet the agent's needs, so the inverse holds here: if the chosen model
  // is KNOWN to lack a capability, the editor sections that depend on it are
  // disabled. Capabilities are only gated when reported — a model with no
  // capability info (e.g. the pre-refresh static list) is treated as capable.
  const models = useModels()
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

  const selectedModel = (models.data ?? []).find((m) => m.id === config.modelId)
  const modelCaps = selectedModel?.capabilities
  // Only disable a section when the model is KNOWN to lack the capability (its
  // catalog reported one but not this flag). Unknown capabilities stay enabled.
  const modelLacksTools = modelCaps != null && !modelCaps.tools
  const modelLacksStructuredOutput =
    modelCaps != null && !modelCaps.structuredOutput

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
            <SaveStateBadge
              dirty={dirty}
              dirtyTooltip="You have unsaved changes"
              savedTooltip="All configuration changes saved"
            />
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
                // when tools are attached, and structured output for a Yes/No or
                // structured result (both go through `generateObject`).
                requirements={{
                  tools: config.toolIds.length > 0,
                  structuredOutput:
                    config.output.kind === 'object' ||
                    config.output.kind === 'boolean',
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
                disabled={modelLacksTools}
                disabledReason={`${selectedModel?.label ?? 'The selected model'} can’t call tools — pick a tool-calling model to attach tools.`}
              />
            </section>

            {/* Expected output */}
            <section className="space-y-1">
              <Label>Expected output</Label>
              <AgentOutputEditor
                value={config.output}
                onChange={(output) => patch({ output })}
                structuredDisabled={modelLacksStructuredOutput}
                structuredDisabledReason={`${selectedModel?.label ?? 'The selected model'} doesn’t support structured output — only a Text result is available.`}
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
                    <Checkbox
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
