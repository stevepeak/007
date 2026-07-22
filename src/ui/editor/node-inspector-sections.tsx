import { MANUAL_TRIGGER_KIND, PERIODIC_TRIGGER_KIND } from '../../engine'
import { AgentSelect } from '../agent-select'
import { useWfComponents } from '../context'
import { useAgents, useTools, useTriggerEvents, useWorkflows } from '../hooks'
import { NodeInputsPanel } from './node-data-panel'
import {
  field,
  ToolSelect,
  WorkflowSelect,
  type NodeInspectorProps,
} from './node-inspector-shared'

function triggerModeLabel(triggerKind: string): string {
  if (triggerKind === MANUAL_TRIGGER_KIND) return 'Manually'
  if (triggerKind === PERIODIC_TRIGGER_KIND) return 'On a schedule'
  return 'On an event'
}

export function TriggerInspector({ node, onChange }: NodeInspectorProps) {
  const { Input, Label } = useWfComponents()
  const triggerEvents = useTriggerEvents()
  if (node.kind !== 'trigger') return null
  return (
    <div className="space-y-3">
      <div className={field}>
        <Label>Starts</Label>
        <Input value={triggerModeLabel(node.config.triggerKind)} disabled />
      </div>
      {node.config.triggerKind === PERIODIC_TRIGGER_KIND ? (
        <div className={field}>
          <Label>Cron schedule</Label>
          <Input
            value={node.config.cron ?? ''}
            placeholder="0 9 * * *"
            onChange={(e) =>
              onChange({
                ...node,
                config: { ...node.config, cron: e.target.value },
              })
            }
          />
        </div>
      ) : node.config.triggerKind !== MANUAL_TRIGGER_KIND ? (
        <div className={field}>
          <Label>Event</Label>
          {/* Show the event's human description, never its internal kind. */}
          <Input
            value={
              triggerEvents.data?.find(
                (e) => e.kind === node.config.triggerKind,
              )?.description ?? 'Event'
            }
            disabled
          />
        </div>
      ) : null}
    </div>
  )
}

export function AgentInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Label } = useWfComponents()
  const agents = useAgents()
  const agentOptions = agents.data ?? []
  if (node.kind !== 'agent') return null
  return (
    <>
      <div className={field}>
        <Label>Agent</Label>
        <AgentSelect
          agents={agentOptions}
          value={{
            agentId: node.config.agentId,
            version: node.config.version ?? null,
          }}
          onChange={({ agentId, version }) =>
            onChange({
              ...node,
              config: { ...node.config, agentId, version },
            })
          }
        />
      </div>
      <div className="border-t border-border" />
      <NodeInputsPanel
        node={node}
        graph={graph}
        onChange={onChange}
        itemSchema={itemSchema}
      />
    </>
  )
}

export function ToolInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Label } = useWfComponents()
  const tools = useTools()
  // A tool node runs a tool deterministically with bound args, so it offers
  // every registered tool — both `function` tools (built for tool nodes, e.g.
  // update_document / extract_text) and the `ai-tool` tools an agent can call.
  const toolOptions = tools.data ?? []
  if (node.kind !== 'tool') return null
  return (
    <>
      <div className={field}>
        <Label>Tool</Label>
        <ToolSelect
          tools={toolOptions}
          value={node.config.toolId}
          onChange={(toolId) =>
            onChange({
              ...node,
              config: { ...node.config, toolId },
            })
          }
        />
      </div>
      <div className="border-t border-border" />
      <NodeInputsPanel
        node={node}
        graph={graph}
        onChange={onChange}
        itemSchema={itemSchema}
      />
    </>
  )
}

export function WorkflowInspector({
  node,
  onChange,
  currentWorkflowId,
}: NodeInspectorProps) {
  const { Label } = useWfComponents()
  const workflows = useWorkflows()
  // A workflow can call any OTHER workflow. Exclude itself — a direct self-call
  // is always a reference cycle (deeper cycles are caught at run start).
  const workflowOptions = (workflows.data ?? []).filter(
    (w) => w.id !== currentWorkflowId,
  )
  if (node.kind !== 'workflow') return null
  return (
    <>
      <div className={field}>
        <Label>Workflow</Label>
        <WorkflowSelect
          workflows={workflowOptions}
          value={node.config.workflowId}
          onChange={(workflowId) =>
            onChange({
              ...node,
              config: { ...node.config, workflowId },
            })
          }
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Runs the selected workflow's latest published version and waits for
        its result, which becomes this node's output. The upstream input is
        passed straight through as the called workflow's trigger input.
      </p>
    </>
  )
}

export function FeatureRequestInspector({ node, onChange }: NodeInspectorProps) {
  const { Label, Textarea } = useWfComponents()
  if (node.kind !== 'feature-request') return null
  return (
    <div className={field}>
      <Label>Description</Label>
      <Textarea
        rows={4}
        value={node.config.description}
        onChange={(e) =>
          onChange({
            ...node,
            config: { ...node.config, description: e.target.value },
          })
        }
      />
    </div>
  )
}

export function RaceInspector({ node }: NodeInspectorProps) {
  if (node.kind !== 'race') return null
  return (
    <p className="text-muted-foreground text-xs">
      A first-to-finish join. Wire several upstream nodes into it — whichever
      completes first wins, and its output flows through unchanged. The other
      upstreams keep running, but their results are ignored. Connect inputs
      that produce the same shape of result.
    </p>
  )
}

export function AggregateInspector({ node }: NodeInspectorProps) {
  if (node.kind !== 'aggregate') return null
  return (
    <p className="text-muted-foreground text-xs">
      A wait-for-all join. Wire several upstream nodes into it — once they all
      complete, their outputs are collected into a single ordered list (one
      element per upstream, in connection order). Feed that list to a sibling,
      such as an Iteration node, to process the results together.
    </p>
  )
}

export function NoteInspector({ node, onChange }: NodeInspectorProps) {
  const { Label, Textarea } = useWfComponents()
  if (node.kind !== 'note') return null
  return (
    <div className={field}>
      <Label>Markdown</Label>
      <Textarea
        rows={12}
        className="font-mono text-xs"
        value={node.config.text}
        placeholder={'# Title\n\nNotes with **bold**, `code`, and\n- lists'}
        onChange={(e) =>
          onChange({
            ...node,
            config: { ...node.config, text: e.target.value },
          })
        }
      />
      <p className="text-muted-foreground text-xs">
        A sticky note for the canvas — it never affects the workflow. The
        label above is the note’s title.
      </p>
    </div>
  )
}
