import {
  Activity,
  BrushCleaning,
  FlaskConical,
  Goal,
  Home,
  Microscope,
  Target,
  ThumbsUp,
  Workflow as WorkflowIcon,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Fragment, useMemo, type ReactNode } from 'react'

import { agentColor, agentIcon } from './agent-appearance'
import { cn } from './cn'
import { describeCheck } from './evals/check-naming'
import { useAgent, useEvalSet, useRun, useTools, useWorkflow } from './hooks'
import { useFeedbackForSubjects } from './hooks-feedback'
import { WfLink } from './nav'
import { toolText } from './tool-appearance'
import { ToolIcon } from './tool-icon'
import { Tooltip } from './tooltip'
import {
  classifyAssetPath,
  groupTabs,
  WF_TAB_GROUP_LABELS,
  WF_TAB_GROUP_PATHS,
  type WfAsset,
} from './wf-tab-routes'
import { HOME_TAB_ID, useWfTabs, type WfTab } from './wf-tabs'

// The Chrome-style tab strip. A fixed, non-closable Home tab (hub + section
// browsing), then open asset tabs laid out as one labelled row per kind
// ("Workflows: […] […]") so a crowded strip stays scannable. Each tab shows the
// asset's icon + name and, on hover, its full breadcrumb trail. Identity is
// resolved per tab from live query data (name/icon fill in once loaded).

export function WfTabStrip() {
  const { tabs, activeId, activateTab, closeTab, closeAllTabs } = useWfTabs()
  const groups = useMemo(() => groupTabs(tabs), [tabs])
  // The sweep spares the tab in focus, so it's only offered when it would
  // actually close something — and it names what it will do.
  const closable = tabs.filter((t) => t.id !== activeId).length
  const sweepLabel =
    closable < tabs.length ? 'Close other tabs' : 'Close all tabs'

  return (
    // Tabs wrap (never scroll) so the strip stays a fixed height. A wide tab
    // row can still bleed horizontally, so `overflow-x-clip` contains that
    // bleed while leaving overflow-y visible — the hover tooltips drop *below*
    // the strip (portaled to <body>, so they add no layout) and still render in
    // full.
    <div className="flex items-start gap-1 overflow-x-clip border-b border-neutral-200 bg-neutral-50 px-2 py-1">
      {/* Two columns — row heading, then that row's wrapping tabs — so every
          row's tabs start at the same x regardless of heading width. Home sits
          in the heading column above the labels, icon-only, flush left. */}
      <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1">
        <div className="flex justify-start">
          <TabChrome
            icon={<Home className="size-4 text-neutral-500" />}
            label="Home"
            iconOnly
            trail={['Home']}
            active={activeId === HOME_TAB_ID}
            onSelect={() => activateTab(HOME_TAB_ID)}
          />
        </div>
        <span />
        {groups.map(({ group, tabs: rowTabs }) => (
          <Fragment key={group}>
            {/* The row heading doubles as a shortcut into that section's
                landing page (Home tab), so "Agents" isn't dead text. */}
            <Tooltip
              content={`Open ${WF_TAB_GROUP_LABELS[group]}`}
              side="bottom"
              className="justify-end"
            >
              <WfLink
                to={WF_TAB_GROUP_PATHS[group]}
                className="rounded py-1 text-right text-xs leading-5 font-medium text-neutral-500 hover:text-neutral-900 hover:underline"
              >
                {WF_TAB_GROUP_LABELS[group]}
              </WfLink>
            </Tooltip>
            <div className="flex flex-wrap items-stretch gap-1">
              {rowTabs.map((tab) => (
                <TabItem
                  key={tab.id}
                  tab={tab}
                  active={activeId === tab.id}
                  onSelect={() => activateTab(tab.id)}
                  onClose={() => closeTab(tab.id)}
                />
              ))}
            </div>
          </Fragment>
        ))}
      </div>
      {closable > 0 ? (
        <Tooltip content={sweepLabel} side="bottom">
          <button
            type="button"
            aria-label={sweepLabel}
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
  /** Render the icon alone; `label` still names the tab for screen readers. */
  iconOnly?: boolean
  /** Breadcrumb segments shown in the hover tooltip (section → … → leaf). */
  trail: string[]
  active: boolean
  onSelect: () => void
  onClose?: () => void
}

function TabChrome({
  icon,
  label,
  iconOnly,
  trail,
  active,
  onSelect,
  onClose,
}: TabChromeProps) {
  return (
    // The wrapper draws the pill (border/fill/rounding) but owns no padding:
    // its two buttons tile the whole interior, so every pixel that *looks*
    // clickable is. Spacing that used to live on the wrapper now lives inside
    // the buttons, keeping the rendered geometry identical.
    <Tooltip content={<TrailTooltip trail={trail} />} side="bottom">
      <div
        className={cn(
          'group/tab flex max-w-[12rem] items-stretch rounded-md border text-sm',
          active
            ? 'border-neutral-200 bg-white font-medium text-neutral-900 shadow-sm'
            : 'border-transparent text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800',
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-label={iconOnly ? label : undefined}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-2',
            // The close button supplies the rest of the right inset.
            onClose ? 'pr-1.5' : 'pr-2',
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            {icon}
          </span>
          {iconOnly ? null : <span className="truncate">{label}</span>}
        </button>
        {onClose ? (
          <button
            type="button"
            aria-label={`Close ${label}`}
            onClick={onClose}
            className="group/close flex shrink-0 items-center rounded-md py-1 pr-2 pl-0 opacity-0 group-hover/tab:opacity-100"
          >
            {/* The glyph's hover square is driven by the button, not itself, so
                it lights up across the whole (larger) target. */}
            <span className="flex size-4 items-center justify-center rounded text-neutral-400 group-hover/close:bg-neutral-200 group-hover/close:text-neutral-700">
              <X className="size-3" />
            </span>
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
    case 'evalCheck':
      return <EvalCheckTab asset={asset} {...common} />
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
      icon={<Icon className={cn('size-4', agentColor(data?.agent.color).text)} />}
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
      // Color lives on the wrapper so the lucide icon inherits it (see
      // `toolText`), matching how the tool's card/chip renders elsewhere.
      icon={
        <span
          className={cn(
            'flex size-4 items-center justify-center',
            toolText(tool?.color),
          )}
        >
          <ToolIcon
            icon={tool?.icon}
            iconName={tool?.iconName}
            className="size-4"
          />
        </span>
      }
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

function EvalCheckTab({ asset, ...rest }: KindProps<'evalCheck'>) {
  const { data } = useEvalSet(asset.setId)
  const setName = data?.set.name || 'Goal'
  const row = data?.rows.find((r) => r.id === asset.sampleId)
  const sampleName = row?.name || 'Sample'
  // A Check is addressed by its index within the row's check tree.
  const index = Number(asset.checkId)
  const checkName = describeCheck(
    row && Number.isInteger(index) ? row.checks.checks[index] : undefined,
  )
  return (
    <TabChrome
      icon={sectionIcon(FlaskConical, 'text-rose-500')}
      label={checkName}
      trail={[setName, sampleName, checkName]}
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
