import { useState } from 'react'

import type { AgentConfig } from '../../engine'
import type { WfAgentCall } from '../../server/protocol'
import { ActivityList } from '../activity/activity-list'
import { AGENT_ICONS, DEFAULT_AGENT_COLOR } from '../agent-appearance'
import { AppearancePicker } from '../appearance-picker'
import { cn } from '../cn'
import { Tabs } from '../filters'
import { useAgent } from '../hooks'
import { useWfNav } from '../nav'
import { QueryState } from '../query-state'
import { WfShell } from '../shell'

import { ArchiveAgentDialog } from './agent-editor-archive'
import { AgentCallInspect } from './agent-editor-call-inspect'
import { AgentCallMetrics, AgentCallsList, callKey } from './agent-editor-calls'
import { AgentConfigPanel } from './agent-editor-config-panel'
import { AgentEvalsPanel } from './agent-editor-evals'
import { AgentEditorHeaderActions } from './agent-editor-header-actions'
import { PlaygroundPanel } from './agent-editor-playground'
import { PublishAgentDialog } from './agent-editor-publish'
import {
  useAgentDraft,
  useAgentMeta,
} from './use-agent-editor-state'

// The agent editor — same draft/version lifecycle as the prompt editor, but
// over the whole AgentConfig (model, prompt, tools, expected output, advanced),
// plus the entity's appearance (icon + color), which lives in the header popover
// behind the title icon and saves immediately. The right-hand column is the
// evidence half: the agent's eval goals and an isolated Playground, both running
// the live DRAFT so a change can be judged before it is published.


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
            initialDescription={data.agent.description ?? ''}
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

type EditorTab = 'editor' | 'calls' | 'activity'

const EDITOR_TABS = [
  { key: 'editor', label: 'Editor' },
  { key: 'calls', label: 'Recent calls' },
  { key: 'activity', label: 'Activity' },
]

function AgentEditorInner({
  agentId,
  initialConfig,
  initialName,
  initialDescription,
  initialIcon,
  initialColor,
  className,
  onPublished,
}: {
  agentId: string
  initialConfig: AgentConfig
  initialName: string
  initialDescription: string
  initialIcon: string
  initialColor: string
  className?: string
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}) {
  const { navigate } = useWfNav()

  // Two hooks, because an agent has two lifecycles: metadata saves on blur,
  // configuration is drafted and published. See `use-agent-editor-state.ts`.
  const meta = useAgentMeta({
    agentId,
    initialName,
    initialDescription,
    initialIcon,
    initialColor,
  })
  const draft = useAgentDraft({ agentId, initialConfig, onPublished })

  // Which half of the page you're on: authoring the agent (config + playground)
  // or inspecting what it has actually been doing.
  const [tab, setTab] = useState<EditorTab>('editor')
  // The call site open in the bottom dock, selected from the Recent calls list.
  // Kept while you flip back to the Editor tab, so returning to the list picks
  // up the investigation where you left it.
  const [inspectedCall, setInspectedCall] = useState<WfAgentCall | null>(null)
  // The only dialog the draft hook doesn't own — nothing in the draft lifecycle
  // opens or closes it.
  const [showArchive, setShowArchive] = useState(false)

  return (
    <>
      <WfShell
        className={className}
        // Not `scroll`: the page owns its own scroll region so the call dock can
        // stay pinned to the bottom instead of riding down with the content.
        titleIcon={
          <AppearancePicker
            icon={meta.icon}
            color={meta.color}
            onSelectIcon={meta.selectIcon}
            onSelectColor={meta.selectColor}
            label="Agent appearance"
          />
        }
        assetLabel="Agent"
        crumbs={[
          {
            editable: {
              value: meta.name,
              onChange: meta.setName,
              onCommit: meta.commitRename,
              ariaLabel: 'Agent name',
            },
          },
        ]}
        descriptionEditable={{
          value: meta.description,
          onChange: meta.setDescription,
          onCommit: meta.commitDescription,
          ariaLabel: 'Agent description',
          placeholder: 'Add a description…',
        }}
        actions={
          <AgentEditorHeaderActions
            draft={draft}
            onArchive={() => setShowArchive(true)}
          />
        }
      >
        {/* Full-bleed, in bands — the first three scroll together, the dock is
            pinned under them:
              1. the agent's key metrics — averages over its real calls, which is
                 what you're tuning against, so they stay visible on both tabs;
              2. the tabs;
              3. the pane. Editor = configuration alongside the playground, an
                 even split so neither is the cramped one; Recent calls = the
                 call rows with the whole page width to spread into.
            The Editor pane stays MOUNTED while Recent calls is showing — the
            prompt editor seeds itself from `initialConfig` and the playground
            holds its last result, so unmounting would silently throw both
            away. */}
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="w-full space-y-6 p-6">
              <AgentCallMetrics agentId={agentId} />

              <Tabs
                active={tab}
                onChange={(k) => setTab(k as EditorTab)}
                tabs={EDITOR_TABS}
              />

              {tab === 'activity' ? (
                // The versions menu shows what was PUBLISHED; this shows
                // everything else — draft saves, renames, the archive — which is
                // most of what happens to an agent and none of what a version
                // records.
                <ActivityList
                  filter={{ entityKind: 'agent', entityId: agentId }}
                  emptyMessage="No changes recorded for this agent yet."
                />
              ) : null}

              {tab === 'calls' ? (
                <AgentCallsList
                  agentId={agentId}
                  selectedKey={inspectedCall ? callKey(inspectedCall) : null}
                  onSelect={setInspectedCall}
                />
              ) : null}

              <div
                className={cn(
                  'grid grid-cols-1 gap-6 lg:grid-cols-2',
                  tab !== 'editor' && 'hidden',
                )}
              >
                {/* Left: configuration */}
                <AgentConfigPanel
                  agentId={agentId}
                  agentName={meta.name}
                  agentDescription={meta.description}
                  config={draft.config}
                  initialConfig={initialConfig}
                  zodSource={draft.zodSource}
                  editZodSource={draft.editZodSource}
                  patch={draft.patch}
                  registerSetBody={draft.registerSetBody}
                  registerSetUserPrompt={draft.registerSetUserPrompt}
                />

                {/* Right: the evidence. Neither of these is a setting, so both
                stay out of the configuration column — and at half the page the
                playground finally has room for a real transcript.

                Evals sit above the playground because they are the stronger of
                the two answers to "did my edit work?": the playground shows one
                answer to one input you just made up, while a goal grades every
                sample you have written checks for. Both run the same unsaved
                draft, so neither asks you to publish to find out. */}
                <div className="space-y-6">
                  <AgentEvalsPanel
                    agentId={agentId}
                    agentName={meta.name}
                    config={draft.config}
                    onRestore={draft.restoreConfig}
                  />
                  <PlaygroundPanel
                    config={draft.config}
                    onRestore={draft.restoreConfig}
                  />
                </div>
              </div>
            </div>
          </div>
          {/* Band 4, and only while a call is selected: that call site's steps,
              in the same dock the workflow editor and run viewer use. Reading
              what the agent DID stays on this page, so the prompt above (and
              the playground's last result) survive the trip. */}
          {tab === 'calls' && inspectedCall ? (
            <AgentCallInspect
              call={inspectedCall}
              onClose={() => setInspectedCall(null)}
            />
          ) : null}
        </div>
      </WfShell>

      {draft.showPublish ? (
        <PublishAgentDialog
          agentId={agentId}
          config={draft.config}
          publishing={draft.publishing}
          error={draft.publishError}
          onCancel={() => draft.setShowPublish(false)}
          onConfirm={draft.onPublish}
        />
      ) : null}

      {showArchive ? (
        <ArchiveAgentDialog
          agentId={agentId}
          agentName={meta.name}
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
