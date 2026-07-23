import {
  Activity,
  BrushCleaning,
  FlaskConical,
  Goal,
  Microscope,
  Target,
  ThumbsUp,
  VenetianMask,
  Workflow as WorkflowIcon,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

import { agentIcon } from './agent-appearance'
import { cn } from './cn'
import { describeCheck } from './evals/shared'
import { useAgent, useEvalSet, useRun, useTools, useWorkflow } from './hooks'
import { useFeedbackForSubjects } from './hooks-feedback'
import { ToolIcon } from './tool-icon'
import { Tooltip } from './tooltip'
import { classifyAssetPath, type WfAsset } from './wf-tab-routes'
import { HOME_TAB_ID, useWfTabs, type WfTab } from './wf-tabs'

// The Chrome-style tab strip. A fixed, non-closable Home tab (hub + section
// browsing) followed by one closable tab per open asset. Each tab shows the
// asset's icon + name and, on hover, its full breadcrumb trail. Identity is
// resolved per tab from live query data (name/icon fill in once loaded).

export function WfTabStrip() {
  const { tabs, activeId, activateTab, closeTab, closeAllTabs } = useWfTabs()

  return (
    // Tabs wrap (never scroll) so the strip stays a fixed height. Each tab's
    // hover tooltip is an always-mounted, absolutely-positioned bubble (hidden
    // via opacity, not display) — so it still counts toward scroll width even
    // when idle, and a right-edge tab's bubble would push the whole page into
    // horizontal scroll. `overflow-x-clip` contains that horizontal bleed while
    // leaving overflow-y visible, so the tooltips (which drop *below* the strip)
    // still render in full.
    <div className="flex items-start gap-1 overflow-x-clip border-b border-neutral-200 bg-neutral-50 px-2 py-1">
      <div className="flex flex-1 flex-wrap items-stretch gap-1">
        <TabChrome
          icon={<VenetianMask className="size-4 text-neutral-500" />}
          label="007"
          trail={['007']}
          active={activeId === HOME_TAB_ID}
          onSelect={() => activateTab(HOME_TAB_ID)}
        />
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={activeId === tab.id}
            onSelect={() => activateTab(tab.id)}
            onClose={() => closeTab(tab.id)}
          />
        ))}
      </div>
      {tabs.length > 0 ? (
        <Tooltip content="Close all tabs" side="bottom">
          <button
            type="button"
            aria-label="Close all tabs"
            onClick={closeAllTabs}
            className="flex shrink-0 items-center justify-center rounded-md border border-transparent px-2 py-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
          >
            <BrushCleaning className="size-4" />
          </button>
        </Tooltip>
      ) : null}
    </div>
  )
}

// --- presentational chrome --------------------------------------------------

type TabChromeProps = {
  icon: ReactNode
  label: string
  /** Breadcrumb segments shown in the hover tooltip (section → … → leaf). */
  trail: string[]
  active: boolean
  onSelect: () => void
  onClose?: () => void
}

function TabChrome({ icon, label, trail, active, onSelect, onClose }: TabChromeProps) {
  return (
    <Tooltip content={<TrailTooltip trail={trail} />} side="bottom">
      <div
        className={cn(
          'group/tab flex max-w-[12rem] items-center gap-1.5 rounded-md border px-2 py-1 text-sm',
          active
            ? 'border-neutral-200 bg-white font-medium text-neutral-900 shadow-sm'
            : 'border-transparent text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800',
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 items-center gap-1.5"
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            {icon}
          </span>
          <span className="truncate">{label}</span>
        </button>
        {onClose ? (
          <button
            type="button"
            aria-label={`Close ${label}`}
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className="flex size-4 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-neutral-700 group-hover/tab:opacity-100"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
    </Tooltip>
  )
}

function TrailTooltip({ trail }: { trail: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {trail.map((seg, i) => (
        <Fragment key={i}>
          {i > 0 ? <span className="text-neutral-500">/</span> : null}
          <span>{seg}</span>
        </Fragment>
      ))}
    </span>
  )
}

/** A colored section icon (workflow / run / evals). */
function sectionIcon(Icon: LucideIcon, className: string) {
  return <Icon className={cn('size-4', className)} />
}

// --- per-kind identity resolvers -------------------------------------------
//
// Each renders exactly one data hook, so the hooks stay unconditional. `TabItem`
// picks the branch by the (stable-per-tab) asset kind.

function TabItem({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: WfTab
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const asset = classifyAssetPath(tab.path)
  const common = { active, onSelect, onClose }
  if (!asset) {
    // Shouldn't happen (only asset paths become tabs) — render a safe fallback.
    return <TabChrome icon={sectionIcon(WorkflowIcon, 'text-neutral-400')} label={tab.id} trail={[tab.id]} {...common} />
  }
  switch (asset.type) {
    case 'workflow':
      return <WorkflowTab asset={asset} {...common} />
    case 'agent':
      return <AgentTab asset={asset} {...common} />
    case 'run':
      return <RunTab asset={asset} {...common} />
    case 'tool':
      return <ToolTab asset={asset} {...common} />
    case 'evalSet':
      return <EvalSetTab asset={asset} {...common} />
    case 'evalSample':
      return <EvalSampleTab asset={asset} {...common} />
    case 'evalTest':
      return <EvalTestTab asset={asset} {...common} />
    case 'evalRun':
      return <EvalRunTab asset={asset} {...common} />
    case 'feedbackItem':
      return <FeedbackTab asset={asset} {...common} />
  }
}

type KindProps<T extends WfAsset['type']> = {
  asset: Extract<WfAsset, { type: T }>
  active: boolean
  onSelect: () => void
  onClose: () => void
}

function WorkflowTab({ asset, ...rest }: KindProps<'workflow'>) {
  const { data } = useWorkflow(asset.workflowId)
  const name = data?.workflow.name || 'Workflow'
  return (
    <TabChrome
      icon={sectionIcon(WorkflowIcon, 'text-indigo-500')}
      label={name}
      trail={[name]}
      {...rest}
    />
  )
}

function AgentTab({ asset, ...rest }: KindProps<'agent'>) {
  const { data } = useAgent(asset.agentId)
  const name = data?.agent.name || 'Agent'
  const Icon = agentIcon(data?.agent.icon)
  return (
    <TabChrome
      icon={<Icon className="size-4 text-violet-500" />}
      label={name}
      trail={[name]}
      {...rest}
    />
  )
}

function RunTab({ asset, ...rest }: KindProps<'run'>) {
  const { data } = useRun(asset.runId)
  const name = data?.run.workflowName || 'Run'
  return (
    <TabChrome
      icon={sectionIcon(Activity, 'text-sky-500')}
      label={name}
      trail={[name]}
      {...rest}
    />
  )
}

function ToolTab({ asset, ...rest }: KindProps<'tool'>) {
  const { data } = useTools()
  const tool = data?.find((t) => t.id === asset.toolId)
  const name = tool?.name || 'Tool'
  return (
    <TabChrome
      icon={<ToolIcon icon={tool?.icon} className="size-4" />}
      label={name}
      trail={[name]}
      {...rest}
    />
  )
}

function EvalSetTab({ asset, ...rest }: KindProps<'evalSet'>) {
  const { data } = useEvalSet(asset.setId)
  const name = data?.set.name || 'Goal'
  return (
    <TabChrome
      icon={sectionIcon(Goal, 'text-rose-500')}
      label={name}
      trail={[name]}
      {...rest}
    />
  )
}

function EvalSampleTab({ asset, ...rest }: KindProps<'evalSample'>) {
  const { data } = useEvalSet(asset.setId)
  const setName = data?.set.name || 'Goal'
  const sampleName =
    data?.rows.find((r) => r.id === asset.sampleId)?.name || 'Sample'
  return (
    <TabChrome
      icon={sectionIcon(Microscope, 'text-rose-500')}
      label={sampleName}
      trail={[setName, sampleName]}
      {...rest}
    />
  )
}

function EvalTestTab({ asset, ...rest }: KindProps<'evalTest'>) {
  const { data } = useEvalSet(asset.setId)
  const setName = data?.set.name || 'Goal'
  const row = data?.rows.find((r) => r.id === asset.sampleId)
  const sampleName = row?.name || 'Sample'
  // A test is addressed by its index within the row's check tree.
  const index = Number(asset.testId)
  const testName = describeCheck(
    row && Number.isInteger(index) ? row.checks.checks[index] : undefined,
  )
  return (
    <TabChrome
      icon={sectionIcon(FlaskConical, 'text-rose-500')}
      label={testName}
      trail={[setName, sampleName, testName]}
      {...rest}
    />
  )
}

function EvalRunTab({ asset: _asset, ...rest }: KindProps<'evalRun'>) {
  // The report is self-describing; its label stays a stable "Run report".
  return (
    <TabChrome
      icon={sectionIcon(Target, 'text-rose-500')}
      label="Run report"
      trail={['Run report']}
      {...rest}
    />
  )
}

function FeedbackTab({ asset, ...rest }: KindProps<'feedbackItem'>) {
  const { data } = useFeedbackForSubjects([asset.subjectId])
  const name = data?.[0]?.raterLabel || 'Feedback'
  return (
    <TabChrome
      icon={sectionIcon(ThumbsUp, 'text-teal-500')}
      label={name}
      trail={['Feedback', name]}
      {...rest}
    />
  )
}
