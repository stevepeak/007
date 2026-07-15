import { AgentsList, type AgentTemplate } from './agents-list'
import { ComingSoon } from './coming-soon'
import { AgentEditor } from './editor/agent-editor'
import { WorkflowEditor } from './editor/workflow-editor'
import { EvalSample } from './evals/eval-sample'
import { EvalSet } from './evals/eval-set'
import { EvalTest } from './evals/eval-test'
import { EvalsList } from './evals/evals-list'
import { WfNavProvider } from './nav'
import { RunPage } from './run-page'
import { RunsExplorer } from './runs-explorer'
import { WfShell } from './shell'
import { ToolDetail } from './tool-detail'
import { ToolsList } from './tools-list'
import { DEFAULT_WF_SECTIONS, WfHub, type WfHubSection } from './wf-hub'
import { WorkflowsList } from './workflows-list'

// The whole workflow interface behind one component. The host mounts this at a
// catch-all route and injects the current location (`path`, relative to
// `basePath`) plus a `navigate` callback; `WfApp` owns every section and its
// internal routing. The `<WfSdkProvider>` (data client + primitives) must wrap
// this — usually alongside the host's mount.

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
      <div className="h-full">
        <WfAppRoutes
          navigate={navigate}
          sections={sections}
          path={path}
          agentTemplates={agentTemplates}
        />
      </div>
    </WfNavProvider>
  )
}

function WfAppRoutes({
  navigate,
  sections,
  path,
  agentTemplates,
}: {
  navigate: (to: string) => void
  sections: WfHubSection[]
  path: string
  agentTemplates?: AgentTemplate[]
}) {
  const parts = path.split('/').filter(Boolean)

  // Hub root.
  if (parts.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <WfHub sections={sections} onOpen={(key) => navigate(key)} />
      </div>
    )
  }

  // Single run, full-page: `runs/<runId>`. Self-contained (the run carries its
  // own graph + version), so it isn't nested under a workflow. Renders its own
  // breadcrumb shell (the last crumb is a friendly run label, not the UUID).
  if (parts.length === 2 && parts[0] === 'runs') {
    return <RunPage runId={parts[1]} className="h-full" />
  }

  // Agent editor, full-page: `agents/<id>/edit` (renders its own header).
  if (parts.length === 3 && parts[0] === 'agents' && parts[2] === 'edit') {
    return (
      <AgentEditor
        agentId={parts[1]}
        className="h-full"
        onPublished={() => navigate('agents')}
      />
    )
  }

  // Single tool detail, full-page: `tools/<toolId>` — recent calls + a
  // real-execution playground.
  if (parts.length === 2 && parts[0] === 'tools') {
    return (
      <WfShell
        crumbs={[
          { home: true },
          { label: 'Tools', to: 'tools' },
          { label: 'Tool' },
        ]}
        scroll
      >
        <ToolDetail toolId={parts[1]} />
      </WfShell>
    )
  }

  // Single test: `evals/<setId>/samples/<sampleId>/tests/<testId>` (own shell).
  if (
    parts.length === 6 &&
    parts[0] === 'evals' &&
    parts[2] === 'samples' &&
    parts[4] === 'tests'
  ) {
    return (
      <EvalTest
        key={parts[5]}
        setId={parts[1]}
        sampleId={parts[3]}
        testId={parts[5]}
        className="h-full"
      />
    )
  }

  // Single eval sample: `evals/<setId>/samples/<sampleId>` (renders own shell).
  if (parts.length === 4 && parts[0] === 'evals' && parts[2] === 'samples') {
    return (
      <EvalSample
        key={parts[3]}
        setId={parts[1]}
        sampleId={parts[3]}
        className="h-full"
      />
    )
  }

  // Eval set detail: `evals/<setId>` (renders own shell with the set name crumb).
  if (parts.length === 2 && parts[0] === 'evals') {
    return <EvalSet key={parts[1]} setId={parts[1]} className="h-full" />
  }

  // Workflow-scoped routes: `<id>/edit`, `<id>/runs`.
  if (parts.length === 2) {
    const [workflowId, leaf] = parts
    if (leaf === 'edit') {
      // The editor renders its own breadcrumb shell (the workflow name is an
      // editable crumb, and its toolbar buttons live in the shell's actions).
      return (
        <WorkflowEditor
          workflowId={workflowId}
          className="h-full"
          onPublished={({ versionId }) =>
            navigate(`${workflowId}/runs?v=${versionId}`)
          }
        />
      )
    }
    if (leaf === 'runs') {
      return (
        <WfShell
          crumbs={[
            { home: true },
            { label: 'Workflows', to: 'workflows' },
            { label: 'Runs' },
          ]}
        >
          <RunsExplorer className="h-full" workflowId={workflowId} />
        </WfShell>
      )
    }
  }

  // Top-level sections.
  if (parts.length === 1) {
    const [key] = parts
    if (key === 'workflows') {
      return (
        <WfShell crumbs={[{ home: true }, { label: 'Workflows' }]} scroll>
          <WorkflowsList />
        </WfShell>
      )
    }
    if (key === 'runs') {
      return (
        <WfShell crumbs={[{ home: true }, { label: 'Runs' }]}>
          <RunsExplorer className="h-full" />
        </WfShell>
      )
    }
    if (key === 'agents') {
      return (
        <WfShell crumbs={[{ home: true }, { label: 'Agents' }]} scroll>
          <AgentsList templates={agentTemplates} />
        </WfShell>
      )
    }
    if (key === 'tools') {
      return (
        <WfShell crumbs={[{ home: true }, { label: 'Tools' }]} scroll>
          <ToolsList />
        </WfShell>
      )
    }
    if (key === 'evals') {
      return (
        <WfShell crumbs={[{ home: true }, { label: 'Evals' }]} scroll>
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
