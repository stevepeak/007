import {
  ITERATION_ITEM_TRIGGER_KIND,
  MANUAL_TRIGGER_KIND,
  PERIODIC_TRIGGER_KIND,
  type WfEngine,
} from '../../engine'
import { AgentSelect } from '../agent-select'
import { useWfComponents } from '../context'
import { useAgents, useTools, useTriggerEvents, useWorkflows } from '../hooks'

import { MarkdownField } from './markdown-hint'
import {
  field,
  ToolSelect,
  WorkflowSelect,
  type NodeInspectorProps,
} from './node-inspector-shared'
import {
  PROMPT_EDITOR_COMPACT_HEIGHT,
  PromptBodyEditor,
} from './prompt-body-editor'

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
          <p className="text-muted-foreground text-xs">
            This is the only place it is decided: it applies whether this
            workflow is started on its own or called by another one.
          </p>
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

export function WorkflowInspector({
  node,
  onChange,
  currentWorkflowId,
}: NodeInspectorProps) {
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
        <p className="text-muted-foreground text-xs">
          It gets a run of its own — its own trace, nested under this one, on
          whichever engine that workflow's own trigger is set to. Nothing to
          choose here: how a workflow executes belongs to that workflow.
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

// The Text inspector. A Text node is the deterministic half of what an agent
// does: the author writes the wording, `${variables}` pull in values from
// earlier steps, and the filled-in string is the node's output. Reuses the
// prompt body editor because the surface is identical — Markdown with variable
// chips — and an author who has written a prompt already knows this box.
export function TextInspector({ node, onChange }: NodeInspectorProps) {
  const { Label } = useWfComponents()
  if (node.kind !== 'text') return null
  return (
    <div className={field}>
      <Label>Text</Label>
      <PromptBodyEditor
        // Remount when the selection moves. The editor seeds its document once
        // from `initialBody` and owns it from then on, so a reused instance
        // would keep showing the previously selected node's text.
        key={node.id}
        initialBody={node.config.body}
        minHeightClass={PROMPT_EDITOR_COMPACT_HEIGHT}
        placeholder={
          'Write the text… use Markdown to format and ${variable} to pull in a value from an earlier step.'
        }
        onChange={(body) =>
          onChange({ ...node, config: { ...node.config, body } })
        }
      />
      <p className="text-muted-foreground text-xs">
        Every <code>{'${name}'}</code> you write appears under “Needs” below —
        link each one to an earlier step’s result. No model runs here, so the
        same inputs always produce the same text.
      </p>
    </div>
  )
}

export function NoteInspector({ node, onChange }: NodeInspectorProps) {
  const { Label, Textarea } = useWfComponents()
  if (node.kind !== 'note') return null
  return (
    <div className={field}>
      <Label>Markdown</Label>
      {/* No `${variables}` here: a note is read by people on the canvas, never
      rendered into a prompt. */}
      <MarkdownField variables={false}>
        <Textarea
          rows={12}
          className="pr-9 font-mono text-xs"
          value={node.config.text}
          placeholder={'# Title\n\nNotes with **bold**, `code`, and\n- lists'}
          onChange={(e) =>
            onChange({
              ...node,
              config: { ...node.config, text: e.target.value },
            })
          }
        />
      </MarkdownField>
      <p className="text-muted-foreground text-xs">
        A sticky note for the canvas — it never affects the workflow. The Label
        field is the note’s title.
      </p>
    </div>
  )
}
