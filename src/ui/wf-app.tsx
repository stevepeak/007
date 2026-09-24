import type { ReactNode } from 'react'

import { ActivityList } from './activity/activity-list'
import { AgentsList } from './agents-list'
import { cn } from './cn'
import { ComingSoon } from './coming-soon'
import { ConnectorDetail } from './connectors/connector-detail'
import { ConnectorsList } from './connectors/connectors-list'
import { WfDashboard } from './dashboard'
import { AgentEditor } from './editor/agent-editor'
import { WorkflowEditor } from './editor/workflow-editor'
import { EvalRunReport } from './evals/eval-run-report'
import { EvalSample } from './evals/eval-sample'
import { EvalSet } from './evals/eval-set'
import { EvalsList } from './evals/evals-list'
import { FeedbackDetail } from './feedback-detail'
import { FeedbackList } from './feedback-list'
import { useTools } from './hooks'
import { McpConnect } from './mcp/mcp-connect'
import { ModelsList } from './models-list'
import { useWfNav, WfNavProvider } from './nav'
import { RunPage } from './runs/run-page'
import { RunsExplorer } from './runs/runs-explorer'
import { WfShell, WfShellAssetProvider } from './shell'
import { toolText } from './tool-appearance'
import { ToolDetail } from './tool-detail'
import { ToolIcon } from './tool-icon'
import { ToolsList } from './tools-list'
import { UndoTabScope } from './undo/undo-context'
import { sectionCrumb } from './wf-crumbs'
import { DEFAULT_WF_SECTIONS, WfHub, type WfHubSection } from './wf-hub'
import { classifyAssetPath } from './wf-tab-routes'
import { WfTabStrip } from './wf-tab-strip'
import { HOME_TAB_ID, useWfTabs, WfTabsProvider } from './wf-tabs'
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
  /**
   * Show the operational dashboard (run volume, spend, failures, feedback queue)
   * on the home tab above the section cards. Default true; set false for a host
   * that wants the hub as a bare launcher.
   */
  dashboard?: boolean
  /**
   * Route the host mounted the read-only MCP endpoint at, shown on the MCP
   * section. Defaults to `/api/mcp`; the write endpoint is that path plus
   * `/write`.
   */
  mcpPath?: string
}

export function WfApp({
  basePath,
  path,
  navigate,
  sections = DEFAULT_WF_SECTIONS,
  dashboard = true,
  mcpPath,
}: WfAppProps) {
  return (
    <WfNavProvider basePath={basePath} path={path} navigate={navigate}>
      <WfTabsProvider path={path} navigate={navigate}>
        <WfTabbedShell
          sections={sections}
          dashboard={dashboard}
          mcpPath={mcpPath}
        />
      </WfTabsProvider>
    </WfNavProvider>
  )
}

// Renders the tab strip plus a keep-alive stack: the Home surface and every open
// asset tab are all mounted at once; inactive ones are hidden (display:none) so
// their in-memory state persists. Only the active pane is visible.
function WfTabbedShell({
  sections,
  dashboard,
  mcpPath,
}: {
  sections: WfHubSection[]
  dashboard: boolean
  mcpPath?: string
}) {
  const { tabs, activeId, homePath } = useWfTabs()

  return (
    <div className="flex h-full min-w-0 flex-col">
      <WfTabStrip />
      <div className="relative min-h-0 flex-1">
        <TabPane active={activeId === HOME_TAB_ID}>
          <HomeRoutes
            path={homePath}
            sections={sections}
            dashboard={dashboard}
            mcpPath={mcpPath}
          />
        </TabPane>
        {tabs.map((tab) => (
          <TabPane key={tab.id} active={activeId === tab.id} tabId={tab.id}>
            <AssetRoutes path={tab.path} />
          </TabPane>
        ))}
      </div>
    </div>
  )
}

// Inactive panes stay MOUNTED (that is the whole point of keep-alive), so
// `active` has to be published to anything that cares which surface is really in
// front. Undo is the first: without this every open editor would answer the same
// Cmd+Z.
function TabPane({
  active,
  tabId,
  children,
}: {
  active: boolean
  /** Null for Home, which holds no editor and so can never be unsaved. */
  tabId?: string | null
  children: ReactNode
}) {
  return (
    <div className={cn('h-full', !active && 'hidden')}>
      <UndoTabScope active={active} tabId={tabId}>
        {children}
      </UndoTabScope>
    </div>
  )
}

// Home tab: the hub + all section browsing. Never opens a tab of its own — every
// asset link inside here changes the URL, which the tabs provider turns into an
// asset tab. Unknown paths fall back to the hub.
function HomeRoutes({
  path,
  sections,
  dashboard,
  mcpPath,
}: {
  path: string
  sections: WfHubSection[]
  dashboard: boolean
  mcpPath?: string
}) {
  const { navigate } = useWfNav()
  // Split path from any query string, then into segments.
  const [pathname, queryString = ''] = path.split('?', 2)
  const parts = pathname.split('/').filter(Boolean)

  // Hub root.
  if (parts.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <WfHub sections={sections} onOpen={(key) => navigate(key)}>
          {dashboard ? <WfDashboard /> : null}
        </WfHub>
      </div>
    )
  }

  // Top-level sections.
  if (parts.length === 1) {
    const [key] = parts
    if (key === 'workflows') {
      return (
        <WfShell crumbs={[sectionCrumb('workflows', { current: true })]} scroll>
          <WorkflowsList />
        </WfShell>
      )
    }
    if (key === 'runs') {
      // Optional `?workflow=<id>` pre-selects the workflow filter (e.g. the
      // "View runs" button on a workflow row deep-links here).
      const workflow = new URLSearchParams(queryString).get('workflow')
      return (
        <WfShell crumbs={[sectionCrumb('runs', { current: true })]}>
          <RunsExplorer
            className="h-full"
            initialWorkflowId={workflow ?? undefined}
          />
        </WfShell>
      )
    }
    if (key === 'agents') {
      return (
        <WfShell crumbs={[sectionCrumb('agents', { current: true })]} scroll>
          <AgentsList />
        </WfShell>
      )
    }
    if (key === 'tools') {
      return (
        <WfShell crumbs={[sectionCrumb('tools', { current: true })]} scroll>
          <ToolsList />
        </WfShell>
      )
    }
    if (key === 'evals') {
      return (
        <WfShell crumbs={[sectionCrumb('evals', { current: true })]} scroll>
          <EvalsList />
        </WfShell>
      )
    }
    if (key === 'models') {
      return (
        <WfShell crumbs={[sectionCrumb('models', { current: true })]} scroll>
          <ModelsList />
        </WfShell>
      )
    }
    if (key === 'activity') {
      return (
        <WfShell crumbs={[sectionCrumb('activity', { current: true })]} scroll>
          <ActivityList className="mx-auto max-w-4xl p-6" />
        </WfShell>
      )
    }
    if (key === 'feedback') {
      return (
        <WfShell crumbs={[sectionCrumb('feedback', { current: true })]} scroll>
          <FeedbackList />
        </WfShell>
      )
    }
    if (key === 'connectors') {
      // `?connected=<id>` / `?connector_error=<msg>` are set by the OAuth
      // callback redirect — the only way the round trip can report itself, since
      // the browser comes back from a server we don't control.
      const params = new URLSearchParams(queryString)
      return (
        <WfShell
          crumbs={[sectionCrumb('connectors', { current: true })]}
          scroll
        >
          <ConnectorsList
            connectedId={params.get('connected')}
            errorMessage={params.get('connector_error')}
          />
        </WfShell>
      )
    }
    if (key === 'mcp') {
      return (
        <WfShell crumbs={[sectionCrumb('mcp', { current: true })]} scroll>
          <McpConnect mcpPath={mcpPath} />
        </WfShell>
      )
    }
    const section = sections.find((s) => s.key === key)
    if (section) {
      return (
        <WfShell crumbs={[{ label: section.title }]} scroll>
          <ComingSoon title={section.title} description={section.description} />
        </WfShell>
      )
    }
  }

  // Unknown path → fall back to the hub.
  return (
    <div className="h-full overflow-y-auto">
      <WfHub sections={sections} onOpen={(key) => navigate(key)}>
        {dashboard ? <WfDashboard /> : null}
      </WfHub>
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
  const query = new URLSearchParams(path.split('?', 2)[1] ?? '')

  switch (asset.type) {
    case 'run': {
      // Optional `?node=<nodeId>[&item=<i>]` opens the run with that node
      // already selected and inspected — how the agent editor's "Recent calls"
      // hands an investigation over, instead of dropping you on a run and
      // making you find the agent in it again.
      const rawItem = query.get('item')
      const item = rawItem == null ? NaN : Number(rawItem)
      return (
        <RunPage
          runId={asset.runId}
          initialNodeId={query.get('node')}
          initialItemIndex={
            Number.isSafeInteger(item) && item >= 0 ? item : null
          }
          className="h-full"
        />
      )
    }
    case 'agent':
      // Stay on the editor after publishing — the editor shows an inline
      // "Published" confirmation rather than navigating back to the list.
      return <AgentEditor agentId={asset.agentId} className="h-full" />

    case 'tool':
      return <ToolDetailPage toolId={asset.toolId} />
    case 'connector':
      return <ConnectorDetail connectorId={asset.connectorId} />
    case 'evalRun':
      return (
        <EvalRunReport
          key={asset.evalRunId}
          evalRunId={asset.evalRunId}
          className="h-full"
        />
      )
    case 'evalSample': {
      // Optional `?check=<i>` opens the sample with that check already
      // expanded — how a run report's per-check row hands an investigation
      // over, instead of dropping you on the sample and making you find the
      // check in it again.
      const rawCheck = query.get('check')
      const check = rawCheck == null ? NaN : Number(rawCheck)
      return (
        <EvalSample
          key={asset.sampleId}
          setId={asset.setId}
          sampleId={asset.sampleId}
          initialCheckIndex={
            Number.isSafeInteger(check) && check >= 0 ? check : null
          }
          className="h-full"
        />
      )
    }
    case 'evalSet':
      return (
        <EvalSet key={asset.setId} setId={asset.setId} className="h-full" />
      )
    case 'workflow':
      // The workflow editor keeps its own richer bottom dock (Data/Issues).
      return (
        <WorkflowEditor
          workflowId={asset.workflowId}
          className="h-full"
          onArchived={() => navigate('workflows')}
        />
      )
    case 'feedbackItem':
      return <FeedbackDetail subjectId={asset.subjectId} />
  }
}

// Tool detail wrapped in its own breadcrumb shell, with the real tool name as
// the leaf crumb (the tool registry is small, so we resolve it from the list).
function ToolDetailPage({ toolId }: { toolId: string }) {
  const { data } = useTools()
  const tool = data?.find((t) => t.id === toolId)
  return (
    <WfShell
      crumbs={[{ label: tool?.name ?? 'Tool' }]}
      titleIcon={
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center',
            toolText(tool?.color),
          )}
        >
          <ToolIcon
            icon={tool?.icon}
            iconName={tool?.iconName}
            iconUrl={tool?.iconUrl}
            className="size-5"
          />
        </span>
      }
      description={tool?.description}
      scroll
    >
      <ToolDetail toolId={toolId} />
    </WfShell>
  )
}
