import {
  ITERATION_ITEM_TRIGGER_KIND,
  MANUAL_TRIGGER_KIND,
  PERIODIC_TRIGGER_KIND,
  type CalleeExecution,
  type WfEngine,
} from '../../engine'
import { AgentSelect } from '../agent-select'
import { useWfComponents } from '../context'
import { useAgents, useTools, useTriggerEvents, useWorkflows } from '../hooks'
import { MarkdownHint } from './markdown-hint'
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

// What each engine actually means for the author, in their terms — the trade is
// durability/resumability against latency, and picking wrong is invisible until
// something fails halfway through.
const ENGINE_HELP: Record<WfEngine, string> = {
  durable:
    'Every step is checkpointed. Survives restarts, retries failed steps, and a failed run can be resumed from where it stopped. Slower to start. Best for long background work like document processing.',
  inline:
    'Runs in one process with no checkpoints. Starts faster and writes far less, but there are no step retries and a failed run cannot be resumed. Best for interactive work someone is waiting on, like chat.',
}

export function TriggerInspector({ node, onChange }: NodeInspectorProps) {
  const { Input, Label, Select } = useWfComponents()
  const triggerEvents = useTriggerEvents()
  if (node.kind !== 'trigger') return null
  // An iteration subgraph's `Item` bookend is not a startable trigger — its
  // subgraph runs inside whatever host the parent run chose — so it gets no
  // engine picker.
  const isIterationItem =
    node.config.triggerKind === ITERATION_ITEM_TRIGGER_KIND
  const engine: WfEngine = node.config.engine ?? 'durable'
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
      {isIterationItem ? null : (
        <div className={field}>
          <Label>Engine</Label>
          <Select
            value={engine}
            onChange={(e) =>
              onChange({
                ...node,
                config: {
                  ...node.config,
                  engine: e.target.value as WfEngine,
                },
              })
            }
          >
            <option value="durable">Durable (checkpointed)</option>
            <option value="inline">Inline (fast, no checkpoints)</option>
          </Select>
          <p className="text-muted-foreground text-xs">{ENGINE_HELP[engine]}</p>
        </div>
      )}
    </div>
  )
}

export function AgentInspector({ node, onChange }: NodeInspectorProps) {
  const agents = useAgents()
  const agentOptions = agents.data ?? []
  if (node.kind !== 'agent') return null
  // Just the agent picker, headed directly by the panel title. The shared
  // inspector renders the "Inform user" and "Needs" sections around it (and the
  // "Open in new tab" shortcut in the title row); the "Expose thinking" toggle
  // lives with the Progress note it supersedes.
  return (
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
  )
}

export function ToolInspector({ node, onChange }: NodeInspectorProps) {
  const tools = useTools()
  // A tool node runs a tool deterministically with bound args, so it offers
  // every registered tool — both `function` tools (built for tool nodes, e.g.
  // update_document / extract_text) and the `ai-tool` tools an agent can call.
  const toolOptions = tools.data ?? []
  if (node.kind !== 'tool') return null
  // Just the tool picker, headed directly by the panel title. The shared
  // inspector renders the surrounding "Inform user" and "Needs" sections.
  return (
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
  )
}

// The same durability-vs-overhead trade an iteration's item execution makes, at
// the scale of a whole called workflow — so a small helper workflow stays cheap
// and a real pipeline stops being all-or-nothing.
const CALLEE_EXECUTION_HELP: Record<CalleeExecution, string> = {
  inline:
    'The called workflow runs inside this one step. Cheapest, and right for a small helper — but it is all-or-nothing: if it fails partway it repeats from its first step, and its own steps’ timeout and retry settings do not apply.',
  durable:
    'The called workflow runs as its own checkpointed run, with its own trace you can open. Every one of its steps retries and times out on its own terms, and this workflow simply waits — waiting costs nothing. Right for a callee that does real work.',
}

export function WorkflowInspector({
  node,
  onChange,
  currentWorkflowId,
}: NodeInspectorProps) {
  const { Label, Select } = useWfComponents()
  const workflows = useWorkflows()
  // A workflow can call any OTHER workflow. Exclude itself — a direct self-call
  // is always a reference cycle (deeper cycles are caught at run start).
  const workflowOptions = (workflows.data ?? []).filter(
    (w) => w.id !== currentWorkflowId,
  )
  if (node.kind !== 'workflow') return null
  return (
    <div className="space-y-3">
      <div className={field}>
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
        <p className="text-muted-foreground text-xs">
          Runs the selected workflow's latest published version and waits for its
          result, which becomes this node's output. The upstream input is passed
          straight through as the called workflow's trigger input.
        </p>
      </div>
      <div className={field}>
        <Label>Execution</Label>
        <Select
          value={node.config.calleeExecution}
          onChange={(e) =>
            onChange({
              ...node,
              config: {
                ...node.config,
                calleeExecution: e.target.value as CalleeExecution,
              },
            })
          }
        >
          <option value="inline">Inline (as one step)</option>
          <option value="durable">Durable (as its own run)</option>
        </Select>
        <p className="text-muted-foreground text-xs">
          {CALLEE_EXECUTION_HELP[node.config.calleeExecution]}
        </p>
      </div>
    </div>
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
      upstreams keep running, but their results are ignored. Connect inputs that
      produce the same shape of result.
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
      {/* No `${variables}` here: a note is read by people on the canvas, never
      rendered into a prompt. */}
      <MarkdownHint variables={false} />
      <p className="text-muted-foreground text-xs">
        A sticky note for the canvas — it never affects the workflow. The Label
        field is the note’s title.
      </p>
    </div>
  )
}
