import type { WfAssistantContext } from '../context'
import { classifyAssetPath } from '../wf-tab-routes'

// Maps "where the user currently is" (the active tab's path) to the copilot's
// view context. This is the single source of truth the persistent right-rail
// panel reads to ground each turn on the asset in focus — it replaces the old
// per-surface `<ChatDock subject=…>` wiring. Because only the ACTIVE tab's path
// is passed in, keep-alive (several surfaces mounted but hidden) never races:
// the focused view alone defines context.
//
// The mapping mirrors the old `WithChatDock` / `ChatView` subjects exactly, so
// the copilot grounds identically to before — just from one place. A home /
// browsing route (hub, section lists) with no asset resolves to the `system`
// subject: the copilot answers platform-wide instead of about one asset.
export function deriveCopilotContext(
  activePath: string | null,
): WfAssistantContext {
  const asset = activePath ? classifyAssetPath(activePath) : null
  if (!asset) return { subject: 'system' }

  switch (asset.type) {
    case 'workflow':
      return { subject: 'workflow', subjectId: asset.workflowId }
    case 'agent':
      return { subject: 'agent', subjectId: asset.agentId }
    case 'tool':
      return { subject: 'tool', subjectId: asset.toolId }
    case 'run':
      return { subject: 'run', runId: asset.runId }
    case 'evalRun':
      return { subject: 'eval', runId: asset.evalRunId }
    case 'evalSet':
    case 'evalSample':
    case 'evalTest':
      return { subject: 'eval', subjectId: asset.setId }
    case 'feedbackItem':
      return { subject: 'feedback', subjectId: asset.subjectId }
  }
}
