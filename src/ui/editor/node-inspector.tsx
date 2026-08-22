import {
  Brain,
  ExternalLink,
  MessageSquareText,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { ComponentType } from 'react'

import { isBookendKind, type InformUser, type WorkflowNode } from '../../engine'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { WfLink } from '../nav'

import { NodeInputsPanel } from './node-data-panel'
import {
  BranchInspector,
  IterationInspector,
  OutputInspector,
  PassthroughInspector,
  TransformInspector,
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
  transform: TransformInspector,
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
  disabled,
}: {
  value: T
  options: { value: T; label: string; icon?: LucideIcon }[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div
      className={cn(
        'bg-muted inline-flex w-full gap-0.5 rounded-md p-0.5',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value
        const Icon = opt.icon
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2.5 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground',
              !disabled && !active && 'hover:text-foreground',
              disabled && 'cursor-not-allowed',
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

// A labeled on/off row: a leading icon + title over a short description, with a
// checkbox at the trailing edge. Used for the dynamic "Inform user" sub-toggles
// that pick what the agent surfaces to the user (tool activity, reasoning).
function ToggleRow({
  icon: Icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: LucideIcon
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const { Checkbox } = useWfComponents()
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block text-sm font-medium">
          {title}
        </span>
        <span className="text-muted-foreground mt-0.5 block text-xs">
          {description}
        </span>
      </span>
      <Checkbox
        className="mt-0.5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

export function NodeInspector(props: NodeInspectorProps) {
  const { node, onChange, graph, itemSchema, insideIteration } = props
  const { Input } = useWfComponents()

  const Inspector = NODE_INSPECTORS[node.kind]
  // The step's "inform user" mode IS the node's `informUser` field — no decoding.
  // Only agents offer the dynamic (live-streaming) mode.
  const isAgent = node.kind === 'agent'
  const inform = node.informUser
  // Inside an iteration nothing a step emits reaches the user, so the control is
  // disabled and pinned to Off. We display Off rather than the stored value so a
  // legacy `static`/`dynamic` never reads as a mode that does something — but we
  // never write it back, because merely selecting a node must not dirty the graph.
  const informMode: InformMode = insideIteration ? 'off' : inform.mode
  const informOptions: { value: InformMode; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'static', label: 'Static' },
    ...(isAgent ? [{ value: 'dynamic' as const, label: 'Dynamic' }] : []),
  ]
  // Switching modes replaces the whole `informUser` value. We preserve the prior
  // mode's settings (the static note, the dynamic sub-toggles) so flipping away
  // and back restores the author's choice — the union makes leaked/stale fields
  // structurally impossible, so there's nothing to reset.
  const setInformMode = (mode: InformMode) => {
    const next: InformUser =
      mode === 'static'
        ? { mode: 'static', note: inform.mode === 'static' ? inform.note : '' }
        : mode === 'dynamic'
          ? {
              mode: 'dynamic',
              reasoning: inform.mode === 'dynamic' ? inform.reasoning : false,
              tools: inform.mode === 'dynamic' ? inform.tools : true,
            }
          : { mode: 'off' }
    onChange({ ...node, informUser: next })
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
            disabled={insideIteration}
          />

          {insideIteration ? (
            <p className="text-muted-foreground text-xs">
              Steps inside an iteration can&rsquo;t message the end user —
              anything they report is dropped. Set the note on the iteration
              step itself instead.
            </p>
          ) : inform.mode === 'dynamic' ? (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs">
                The agent streams its live activity to the user as it works.
                Choose what to surface:
              </p>
              <ToggleRow
                icon={Wrench}
                title="Tool calling"
                description="Announce which tool the agent is calling as it works."
                checked={inform.tools}
                onChange={(tools) =>
                  onChange({
                    ...node,
                    informUser: { ...inform, tools },
                  })
                }
              />
              <ToggleRow
                icon={Brain}
                title="Reasoning"
                description="Stream the model's thinking as it reasons toward the answer."
                checked={inform.reasoning}
                onChange={(reasoning) =>
                  onChange({
                    ...node,
                    informUser: { ...inform, reasoning },
                  })
                }
              />
            </div>
          ) : inform.mode === 'static' ? (
            <div className="space-y-1">
              <Input
                value={inform.note}
                placeholder="Searching client documents…"
                onChange={(e) =>
                  onChange({
                    ...node,
                    informUser: { mode: 'static', note: e.target.value },
                  })
                }
              />
              <p className="text-muted-foreground text-xs">
                Shown to the user while this step runs. Use{' '}
                <code>{'${var}'}</code> for run variables.
                {node.kind === 'iteration' ? (
                  <>
                    {' '}
                    <code>{'${n}'}</code> is the number of items in the list —
                    the note is shown once, before the per-item lines.
                  </>
                ) : null}
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
          no-op for every kind but agent/tool/workflow. */}
      <NodeInputsPanel
        node={node}
        graph={graph}
        onChange={onChange}
        itemSchema={itemSchema}
      />
    </div>
  )
}
