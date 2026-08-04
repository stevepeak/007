import { useMemo, type ReactNode } from 'react'

import { AgentsList } from './agents-list'
import { cn } from './cn'
import { ComingSoon } from './coming-soon'
import { CopilotPanel } from './copilot/copilot-panel'
import { deriveCopilotContext } from './copilot/view-context'
import { AgentEditor } from './editor/agent-editor'
import { WorkflowEditor } from './editor/workflow-editor'
import { EvalRunReport } from './evals/eval-run-report'
import { EvalSample } from './evals/eval-sample'
import { EvalSet } from './evals/eval-set'
import { EvalTest } from './evals/eval-test'
import { EvalsList } from './evals/evals-list'
import { FeedbackDetail } from './feedback-detail'
import { FeedbackList } from './feedback-list'
import { useTools } from './hooks'
import { ModelsList } from './models-list'
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
}

export function WfApp({
  basePath,
  path,
  navigate,
  sections = DEFAULT_WF_SECTIONS,
}: WfAppProps) {
  return (
    <WfNavProvider basePath={basePath} path={path} navigate={navigate}>
      <WfTabsProvider path={path} navigate={navigate}>
        <WfTabbedShell sections={sections} />
      </WfTabsProvider>
    </WfNavProvider>
  )
}

// Renders the tab strip plus a keep-alive stack: the Home surface and every open
// asset tab are all mounted at once; inactive ones are hidden (display:none) so
// their in-memory state persists. Only the active pane is visible.
function WfTabbedShell({ sections }: { sections: WfHubSection[] }) {
  const { tabs, activeId, homePath } = useWfTabs()

  // The path of whatever tab is active — the Home tab's browse path, or the
  // focused asset tab's path. This is what grounds the persistent Copilot: only
  // the ACTIVE surface defines context (hidden keep-alive tabs never leak in).
  const activePath =
    activeId === HOME_TAB_ID
      ? homePath
      : (tabs.find((t) => t.id === activeId)?.path ?? homePath)
  const copilotContext = useMemo(
    () => deriveCopilotContext(activePath),
    [activePath],
  )

  return (
    <div className="flex h-full">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <WfTabStrip />
        <div className="relative min-h-0 flex-1">
          <TabPane active={activeId === HOME_TAB_ID}>
            <HomeRoutes path={homePath} sections={sections} />
          </TabPane>
          {tabs.map((tab) => (
            <TabPane key={tab.id} active={activeId === tab.id}>
              <AssetRoutes path={tab.path} />
            </TabPane>
          ))}
        </div>
      </div>
      {/* Persistent right rail — mounted once, survives all navigation above. */}
      <CopilotPanel context={copilotContext} />
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
}: {
  path: string
  sections: WfHubSection[]
}) {
  const { navigate } = useWfNav()
  // Split path from any query string, then into segments.
  const [pathname, queryString = ''] = path.split('?', 2)
  const parts = pathname.split('/').filter(Boolean)

  // Hub root.
  if (parts.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <WfHub sections={sections} onOpen={(key) => navigate(key)} />
      </div>
    )
  }

  // Top-level sections.
  if (parts.length === 1) {
    const [key] = parts
    if (key === 'workflows') {
      return (
        <WfShell
          crumbs={[sectionCrumb('workflows', { current: true })]}
          scroll
        >
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
        <WfShell
          crumbs={[sectionCrumb('agents', { current: true })]}
          scroll
        >
          <AgentsList />
        </WfShell>
      )
    }
    if (key === 'tools') {
      return (
        <WfShell
          crumbs={[sectionCrumb('tools', { current: true })]}
          scroll
        >
          <ToolsList />
        </WfShell>
      )
    }
    if (key === 'evals') {
      return (
        <WfShell
          crumbs={[sectionCrumb('evals', { current: true })]}
          scroll
        >
          <EvalsList />
        </WfShell>
      )
    }
    if (key === 'models') {
      return (
        <WfShell
          crumbs={[sectionCrumb('models', { current: true })]}
          scroll
        >
          <ModelsList />
        </WfShell>
      )
    }
    if (key === 'feedback') {
      return (
        <WfShell
          crumbs={[sectionCrumb('feedback', { current: true })]}
          scroll
        >
          <FeedbackList />
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

  // The copilot for each surface now lives in the persistent right rail (see
  // `CopilotPanel` in `WfTabbedShell`), grounded on the active tab — so these
  // surfaces render plainly, with no per-asset chat dock.
  switch (asset.type) {
    case 'run':
      return <RunPage runId={asset.runId} className="h-full" />
    case 'agent':
      return (
        <AgentEditor
          agentId={asset.agentId}
          className="h-full"
          onPublished={() => navigate('agents')}
        />
      )
    case 'tool':
      return <ToolDetailPage toolId={asset.toolId} />
    case 'evalTest':
      return (
        <EvalTest
          key={asset.testId}
          setId={asset.setId}
          sampleId={asset.sampleId}
          testId={asset.testId}
          className="h-full"
        />
      )
    case 'evalRun':
      return (
        <EvalRunReport
          key={asset.evalRunId}
          evalRunId={asset.evalRunId}
          className="h-full"
        />
      )
    case 'evalSample':
      return (
        <EvalSample
          key={asset.sampleId}
          setId={asset.setId}
          sampleId={asset.sampleId}
          className="h-full"
        />
      )
    case 'evalSet':
      return <EvalSet key={asset.setId} setId={asset.setId} className="h-full" />
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
      titleIcon={<ToolIcon icon={tool?.icon} className="size-5" />}
      description={tool?.description}
      scroll
    >
      <ToolDetail toolId={toolId} />
    </WfShell>
  )
}
