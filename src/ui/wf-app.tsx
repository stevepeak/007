import { type ReactNode } from 'react'

import { AgentsList, type AgentTemplate } from './agents-list'
import { cn } from './cn'
import { ComingSoon } from './coming-soon'
import { AgentEditor } from './editor/agent-editor'
import { ChatDock } from './editor/bottom-dock'
import { WorkflowEditor } from './editor/workflow-editor'
import { EvalRunReport } from './evals/eval-run-report'
import { EvalSample } from './evals/eval-sample'
import { EvalSet } from './evals/eval-set'
import { EvalTest } from './evals/eval-test'
import { EvalsList } from './evals/evals-list'
import { useTools } from './hooks'
import { useWfNav, WfNavProvider } from './nav'
import { RunPage } from './run-page'
import { RunsExplorer } from './runs-explorer'
import { WfShell, WfShellAssetProvider } from './shell'
import { ToolDetail } from './tool-detail'
import { ToolIcon } from './tool-icon'
import { ToolsList } from './tools-list'
import { classifyAssetPath } from './wf-tab-routes'
import { WfTabStrip } from './wf-tab-strip'
import { HOME_TAB_ID, useWfTabs, WfTabsProvider } from './wf-tabs'
import { sectionCrumb } from './wf-crumbs'
import { DEFAULT_WF_SECTIONS, WfHub, type WfHubSection } from './wf-hub'
import { WorkflowsList } from './workflows-list'

// The whole workflow interface behind one component. The host mounts this at a
// catch-all route and injects the current location (`path`, relative to
// `basePath`) plus a `navigate` callback. On top of that single-location
// contract, `WfApp` layers a browser-style tab strip: a fixed Home tab (hub +
// section browsing) plus one closable tab per open asset. Open asset tabs stay
// mounted (keep-alive) so scroll/undo/unsaved state survive tab switches; only
// the active tab is visible. The `<WfSdkProvider>` (data client + primitives)
// must wrap this — usually alongside the host's mount.

export type WfAppProps = {
  /** Absolute mount point in the host app, e.g. `/wf`. */
  basePath: string
  /** Current location relative to `basePath` — no leading slash. `''` = hub. */
  path: string
  /** Navigate to a path relative to `basePath` (may include a query string). */
  navigate: (to: string) => void
  /** Override the hub's section cards. */
  sections?: WfHubSection[]
  /** Host-injected starting points for the "New agent" flow. */
  agentTemplates?: AgentTemplate[]
}

export function WfApp({
  basePath,
  path,
  navigate,
  sections = DEFAULT_WF_SECTIONS,
  agentTemplates,
}: WfAppProps) {
  return (
    <WfNavProvider basePath={basePath} path={path} navigate={navigate}>
      <WfTabsProvider path={path} navigate={navigate}>
        <WfTabbedShell sections={sections} agentTemplates={agentTemplates} />
      </WfTabsProvider>
    </WfNavProvider>
  )
}

// Renders the tab strip plus a keep-alive stack: the Home surface and every open
// asset tab are all mounted at once; inactive ones are hidden (display:none) so
// their in-memory state persists. Only the active pane is visible.
function WfTabbedShell({
  sections,
  agentTemplates,
}: {
  sections: WfHubSection[]
  agentTemplates?: AgentTemplate[]
}) {
  const { tabs, activeId, homePath } = useWfTabs()

  return (
    <div className="flex h-full flex-col">
      <WfTabStrip />
      <div className="relative min-h-0 flex-1">
        <TabPane active={activeId === HOME_TAB_ID}>
          <HomeRoutes
            path={homePath}
            sections={sections}
            agentTemplates={agentTemplates}
          />
        </TabPane>
        {tabs.map((tab) => (
          <TabPane key={tab.id} active={activeId === tab.id}>
            <AssetRoutes path={tab.path} />
          </TabPane>
        ))}
      </div>
    </div>
  )
}

function TabPane({ active, children }: { active: boolean; children: ReactNode }) {
  return <div className={cn('h-full', !active && 'hidden')}>{children}</div>
}

// Home tab: the hub + all section browsing. Never opens a tab of its own — every
// asset link inside here changes the URL, which the tabs provider turns into an
// asset tab. Unknown paths fall back to the hub.
function HomeRoutes({
  path,
  sections,
  agentTemplates,
}: {
  path: string
  sections: WfHubSection[]
  agentTemplates?: AgentTemplate[]
}) {
  const { navigate } = useWfNav()
  const parts = path.split('/').filter(Boolean)

  // Hub root.
  if (parts.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <WfHub sections={sections} onOpen={(key) => navigate(key)} />
      </div>
    )
  }

  // Workflow-scoped runs list: `<id>/runs`.
  if (parts.length === 2 && parts[1] === 'runs') {
    return (
      <WfShell
        crumbs={[{ home: true }, sectionCrumb('workflows'), { label: 'Runs' }]}
      >
        <RunsExplorer className="h-full" workflowId={parts[0]} />
      </WfShell>
    )
  }

  // Top-level sections.
  if (parts.length === 1) {
    const [key] = parts
    if (key === 'workflows') {
      return (
        <WfShell
          crumbs={[{ home: true }, sectionCrumb('workflows', { current: true })]}
          scroll
        >
          <WorkflowsList />
        </WfShell>
      )
    }
    if (key === 'runs') {
      return (
        <WfShell crumbs={[{ home: true }, sectionCrumb('runs', { current: true })]}>
          <RunsExplorer className="h-full" />
        </WfShell>
      )
    }
    if (key === 'agents') {
      return (
        <WfShell
          crumbs={[{ home: true }, sectionCrumb('agents', { current: true })]}
          scroll
        >
          <AgentsList templates={agentTemplates} />
        </WfShell>
      )
    }
    if (key === 'tools') {
      return (
        <WfShell
          crumbs={[{ home: true }, sectionCrumb('tools', { current: true })]}
          scroll
        >
          <ToolsList />
        </WfShell>
      )
    }
    if (key === 'evals') {
      return (
        <WfShell
          crumbs={[{ home: true }, sectionCrumb('evals', { current: true })]}
          scroll
        >
          <EvalsList />
        </WfShell>
      )
    }
    const section = sections.find((s) => s.key === key)
    if (section) {
      return (
        <WfShell crumbs={[{ home: true }, { label: section.title }]} scroll>
          <ComingSoon title={section.title} description={section.description} />
        </WfShell>
      )
    }
  }

  // Unknown path → fall back to the hub.
  return (
    <div className="h-full overflow-y-auto">
      <WfHub sections={sections} onOpen={(key) => navigate(key)} />
    </div>
  )
}

// Asset tab: renders exactly one editor/detail page for its path. Each pane is a
// distinct asset (workflow/agent editor, run, tool, eval set/sample/test/report)
// and renders its own breadcrumb shell.
function AssetRoutes({ path }: { path: string }) {
  return (
    <WfShellAssetProvider>
      <AssetRoute path={path} />
    </WfShellAssetProvider>
  )
}

function AssetRoute({ path }: { path: string }) {
  const { navigate } = useWfNav()
  const asset = classifyAssetPath(path)
  if (!asset) return null

  switch (asset.type) {
    case 'run':
      return <RunPage runId={asset.runId} className="h-full" />
    case 'agent':
      return (
        <WithChatDock subject="agent">
          <AgentEditor
            agentId={asset.agentId}
            className="h-full"
            onPublished={() => navigate('agents')}
          />
        </WithChatDock>
      )
    case 'tool':
      return (
        <WithChatDock subject="tool">
          <ToolDetailPage toolId={asset.toolId} />
        </WithChatDock>
      )
    case 'evalTest':
      return (
        <WithChatDock subject="eval">
          <EvalTest
            key={asset.testId}
            setId={asset.setId}
            sampleId={asset.sampleId}
            testId={asset.testId}
            className="h-full"
          />
        </WithChatDock>
      )
    case 'evalRun':
      return (
        <WithChatDock subject="eval">
          <EvalRunReport
            key={asset.evalRunId}
            evalRunId={asset.evalRunId}
            className="h-full"
          />
        </WithChatDock>
      )
    case 'evalSample':
      return (
        <WithChatDock subject="eval">
          <EvalSample
            key={asset.sampleId}
            setId={asset.setId}
            sampleId={asset.sampleId}
            className="h-full"
          />
        </WithChatDock>
      )
    case 'evalSet':
      return (
        <WithChatDock subject="eval">
          <EvalSet key={asset.setId} setId={asset.setId} className="h-full" />
        </WithChatDock>
      )
    case 'workflow':
      // The workflow editor has its own richer dock (Data/Issues/Chat).
      return (
        <WorkflowEditor
          workflowId={asset.workflowId}
          className="h-full"
          onArchived={() => navigate('workflows')}
        />
      )
  }
}

// Wraps an asset surface so its content fills the space above a collapsible Chat
// tray pinned to the bottom. The asset keeps its own `h-full` layout inside the
// flexing region; the tray sits below it. Surfaces with their own dock (the
// workflow editor) don't use this.
function WithChatDock({
  subject,
  children,
}: {
  subject: 'agent' | 'tool' | 'eval'
  children: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      <ChatDock subject={subject} />
    </div>
  )
}

// Tool detail wrapped in its own breadcrumb shell, with the real tool name as
// the leaf crumb (the tool registry is small, so we resolve it from the list).
function ToolDetailPage({ toolId }: { toolId: string }) {
  const { data } = useTools()
  const tool = data?.find((t) => t.id === toolId)
  return (
    <WfShell
      crumbs={[{ label: tool?.name ?? 'Tool' }]}
      titleIcon={<ToolIcon icon={tool?.icon} className="size-5" />}
      description={tool?.description}
      scroll
    >
      <ToolDetail toolId={toolId} />
    </WfShell>
  )
}
