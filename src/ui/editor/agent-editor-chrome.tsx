import { useState, type ReactNode } from 'react'

import { AppearancePicker } from '../appearance-picker'
import { useWfNav } from '../nav'
import { WfShell } from '../shell'

import { ArchiveAgentDialog } from './agent-editor-archive'
import { AgentEditorHeaderActions } from './agent-editor-header-actions'
import { PublishAgentDialog } from './agent-editor-publish'
import type { useAgentDraft, useAgentMeta } from './use-agent-editor-state'
import type { useDecisionAgentDraft } from './use-decision-agent-editor-state'

// What every agent editor wraps its body in, whatever kind of config the body
// edits: the shell header (appearance picker, editable name and description,
// save/publish actions) and the publish and archive dialogs. The body is
// `children`.
export function AgentEditorChrome({
  agentId,
  meta,
  draft,
  assetLabel,
  publishBlockedReason,
  summarize,
  className,
  children,
}: {
  agentId: string
  meta: ReturnType<typeof useAgentMeta>
  draft:
    | ReturnType<typeof useAgentDraft>
    | ReturnType<typeof useDecisionAgentDraft>
  assetLabel: string
  /** Set when the draft would not run — Publish is disabled and this explains why. */
  publishBlockedReason?: string
  /** Whether the publish dialog asks for an AI summary. See `PublishAgentDialog`. */
  summarize?: boolean
  className?: string
  children: ReactNode
}) {
  const { navigate } = useWfNav()
  // The only dialog the draft hook doesn't own — nothing in the draft lifecycle
  // opens or closes it.
  const [showArchive, setShowArchive] = useState(false)

  return (
    <>
      <WfShell
        className={className}
        // Not `scroll`: the generation editor's body owns its own scroll region
        // so its call dock stays pinned to the bottom instead of riding down
        // with the content.
        titleIcon={
          <AppearancePicker
            icon={meta.icon}
            color={meta.color}
            onSelectIcon={meta.selectIcon}
            onSelectColor={meta.selectColor}
            label="Agent appearance"
          />
        }
        assetLabel={assetLabel}
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
            publishBlockedReason={publishBlockedReason}
          />
        }
      >
        {children}
      </WfShell>

      {draft.showPublish ? (
        <PublishAgentDialog
          agentId={agentId}
          config={draft.config}
          summarize={summarize}
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
