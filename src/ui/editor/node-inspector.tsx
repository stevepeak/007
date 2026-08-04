import { ExternalLink, MessageSquareText, type LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'

import { isBookendKind, type WorkflowNode } from '../../engine'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { WfLink } from '../nav'
import { NodeInputsPanel } from './node-data-panel'
import {
  BranchInspector,
  IterationInspector,
  OutputInspector,
  PassthroughInspector,
  SwitchInspector,
} from './node-inspector-control-flow'
import {
  AgentInspector,
  AggregateInspector,
  FeatureRequestInspector,
  NoteInspector,
  RaceInspector,
  ToolInspector,
  TriggerInspector,
  WorkflowInspector,
} from './node-inspector-sections'
import {
  InspectorSection,
  SectionHeader,
  type NodeInspectorProps,
} from './node-inspector-shared'

export type { NodeInspectorProps } from './node-inspector-shared'

// Per-kind config editor for the selected node. Uses injected primitives so it
// themes with the host; model/tool choices come from the data client. Advanced
// fields (agent outputSchema, tool arg bindings) are left as-is on the node and
// round-trip unchanged — a later pass can add rich editors for them.

// Per-kind inspector dispatch, mirroring `NODE_TYPES` in node-renderers.tsx:
// each `node.kind` maps to the component that edits it. Kinds with no editable
// config (e.g. `note`) are absent, so the dispatcher renders just the shared
// header for them — the same no-op the old inlined conditional produced.
const NODE_INSPECTORS: Partial<
  Record<WorkflowNode['kind'], ComponentType<NodeInspectorProps>>
> = {
  trigger: TriggerInspector,
  agent: AgentInspector,
  tool: ToolInspector,
  branch: BranchInspector,
  switch: SwitchInspector,
  output: OutputInspector,
  iteration: IterationInspector,
  workflow: WorkflowInspector,
  'feature-request': FeatureRequestInspector,
  passthrough: PassthroughInspector,
  race: RaceInspector,
  aggregate: AggregateInspector,
  note: NoteInspector,
}

// How a step reports progress to the user: off (nothing), static (a fixed
// message, may embed ${run variables}), or dynamic (agent only — stream the
// model's live reasoning/tool activity).
type InformMode = 'off' | 'static' | 'dynamic'

// A compact segmented control — a nicer multi-choice than a checkbox for
// "this OR that" toggles. Renders a pill track with the active segment lifted.
function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; icon?: LucideIcon }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="bg-muted inline-flex w-full gap-0.5 rounded-md p-0.5">
      {options.map((opt) => {
        const active = opt.value === value
        const Icon = opt.icon
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2.5 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon ? <Icon className="size-3.5" /> : null}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export function NodeInspector(props: NodeInspectorProps) {
  const { node, onChange, graph, itemSchema } = props
  const { Input } = useWfComponents()

  const Inspector = NODE_INSPECTORS[node.kind]
  // The step's "inform user" mode, decoded from the node: dynamic ⇢ an agent
  // with `config.exposeThinking`; static ⇢ a defined `progressNote` (possibly
  // ""); off ⇢ neither. Only agents offer the dynamic (live-reasoning) mode.
  const isAgent = node.kind === 'agent'
  const informMode: InformMode =
    isAgent && node.config.exposeThinking
      ? 'dynamic'
      : node.progressNote != null
        ? 'static'
        : 'off'
  const informOptions: { value: InformMode; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'static', label: 'Static' },
    ...(isAgent ? [{ value: 'dynamic' as const, label: 'Dynamic' }] : []),
  ]
  const setInformMode = (mode: InformMode) => {
    if (node.kind === 'agent') {
      // Dynamic keeps any stored static note (runtime ignores it while dynamic)
      // so it returns if the author switches back.
      if (mode === 'dynamic') {
        onChange({ ...node, config: { ...node.config, exposeThinking: true } })
        return
      }
      onChange({
        ...node,
        progressNote: mode === 'static' ? (node.progressNote ?? '') : undefined,
        config: { ...node.config, exposeThinking: false },
      })
      return
    }
    onChange({
      ...node,
      progressNote: mode === 'static' ? (node.progressNote ?? '') : undefined,
    })
  }

  return (
    <div className="flex h-full w-80 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      {/* Panel title: the node's type. It heads the primary config directly —
          no divider, no repeated kind name below it. An agent shows a shortcut
          to open its definition on the right. */}
      <div className="flex items-center justify-between gap-2">
        <SectionHeader>{node.kind}</SectionHeader>
        {node.kind === 'agent' && node.config.agentId ? (
          <WfLink
            to={`agents/${node.config.agentId}/edit`}
            newTab
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline"
          >
            <ExternalLink className="size-3" /> Open in new tab
          </WfLink>
        ) : null}
      </div>

      {/* Primary config for this kind — which agent / tool / workflow, the
          branch condition, etc. Comes first, headed directly by the title. */}
      {Inspector ? <Inspector {...props} /> : null}

      {/* The step's display name on the canvas. */}
      <InspectorSection>
        <SectionHeader>Internal label</SectionHeader>
        <Input
          value={node.label}
          onChange={(e) => onChange({ ...node, label: e.target.value })}
        />
      </InspectorSection>

      {/* What the USER sees while this step runs — off / static / dynamic.
          Agents get all three (dynamic streams the model's live thinking); other
          node kinds get off / static only. Bookends (trigger/output/note) never
          run, so they don't get this section. */}
      {isBookendKind(node) ? null : (
        <InspectorSection>
          <SectionHeader icon={MessageSquareText}>Inform user</SectionHeader>

          <SegmentedToggle
            value={informMode}
            onChange={setInformMode}
            options={informOptions}
          />

          {informMode === 'dynamic' ? (
            <p className="text-muted-foreground text-xs">
              The agent streams its live reasoning and tool activity to the user
              as it works.
            </p>
          ) : informMode === 'static' ? (
            <div className="space-y-1">
              <Input
                value={node.progressNote ?? ''}
                placeholder="Searching client documents…"
                onChange={(e) =>
                  onChange({ ...node, progressNote: e.target.value })
                }
              />
              <p className="text-muted-foreground text-xs">
                Shown to the user while this step runs. Use{' '}
                <code>{'${var}'}</code> for run variables.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              This step reports nothing to the user.
            </p>
          )}
        </InspectorSection>
      )}

      {/* What this step consumes — renders its own "Needs" section, and is a
          no-op for every kind but agent/tool. */}
      <NodeInputsPanel
        node={node}
        graph={graph}
        onChange={onChange}
        itemSchema={itemSchema}
      />
    </div>
  )
}
