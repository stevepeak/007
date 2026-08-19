import { AlertTriangle, Link2, Pencil, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import type {
  ArgBinding,
  JsonSchema,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import { useWfComponents } from '../context'
import { cn } from '../cn'
import {
  agentThreadSource,
  nodeRequires,
  type AccessibleNode,
  type NodeInput,
  type ThreadStatus,
} from './node-io'
import {
  bindingsOf,
  useAccessibleData,
  withBinding,
  withConversation,
} from './node-data-panel-shared'
import { BindingSourceNode } from './node-data-panel-picker'
import { InspectorSection, SectionHeader } from './node-inspector-shared'
import { useHoverHighlightSetter } from './node-renderers-shared'

export type NodeInputsPanelProps = {
  node: WorkflowNode
  graph: WorkflowGraph
  onChange: (next: WorkflowNode) => void
  /** Element schema of the enclosing loop's list, if this node is inside an
   * iteration — makes the `Item`'s fields bindable. */
  itemSchema?: JsonSchema
}

// The node's required inputs, each bindable to upstream data or a literal.
// Lives in the inspector (right rail); the accessible-data tree it binds from
// lives in the bottom dock (`AccessibleDataView`).
export function NodeInputsPanel({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInputsPanelProps) {
  const { accessible, maps } = useAccessibleData(node, graph, itemSchema)
  const requires = useMemo(() => nodeRequires(node, maps), [node, maps])
  // How the prior conversation reaches this agent: whether the AGENT declares it
  // takes a thread at all, and — if so — where this node links it from. Drives
  // the editable "conversation" field below. See `agentThreadSource`.
  const thread = useMemo(
    () =>
      node.kind === 'agent'
        ? agentThreadSource(graph, node.id, maps)
        : ({ status: 'none' } as ThreadStatus),
    [node, graph, maps],
  )
  const bindings = bindingsOf(node)
  if (node.kind !== 'agent' && node.kind !== 'tool') return null

  const conversation =
    node.kind === 'agent' ? (node.config.conversation ?? null) : null
  // The conversation input exists because the AGENT declares it takes a thread
  // ("Works on a conversation"), not because the editor spotted a message source
  // upstream — so the same agent shows the same inputs in every workflow. A
  // stale link on a non-accepting agent still shows (as `unsupported`) so it can
  // be seen and cleared.
  const showConversation = node.kind === 'agent' && thread.status !== 'none'
  const empty = conversationEmptyState(thread)
  const nothingToShow = requires.length === 0 && !showConversation

  // Group by required vs optional. The conversation link heads the REQUIRED
  // group: a conversation agent has no other source of messages, so an unbound
  // one fails the run rather than degrading it (see `buildAgentMessages`). Only
  // a stale link on a task agent (`unsupported`) is shown outside that group, to
  // be seen and cleared.
  const requiredInputs = requires.filter((i) => i.required)
  const optionalInputs = requires.filter((i) => !i.required)
  const hasOptional = optionalInputs.length > 0

  const renderInput = (input: NodeInput) => (
    <BindingField
      key={input.key}
      label={input.label}
      description={input.description}
      type={input.type}
      enumValues={input.enum}
      binding={bindings[input.key] ?? null}
      accessible={accessible}
      onSet={(b) => onChange(withBinding(node, input.key, b))}
    />
  )

  return (
    <InspectorSection>
      <SectionHeader>Needs</SectionHeader>
      {nothingToShow ? (
        <p className="text-muted-foreground text-xs">
          {node.kind === 'agent'
            ? 'This agent needs no variables.'
            : 'This tool takes no arguments.'}
        </p>
      ) : null}
      {requiredInputs.length > 0 || showConversation ? (
        <div className="space-y-1.5">
          <InputGroupLabel>Required</InputGroupLabel>
          <div className="space-y-1.5">
            {showConversation ? (
              <>
                <BindingField
                  label="conversation"
                  description="The chat thread this agent answers. It is the agent's only source of messages, so it must be linked — usually to the chat trigger's messages. A run with it unbound fails."
                  icon={
                    empty?.tone === 'warn' || thread.status === 'unsupported' ? (
                      <AlertTriangle className="size-3.5 shrink-0 text-rose-500" />
                    ) : undefined
                  }
                  emptyText={empty?.text}
                  emptyTone={empty?.tone}
                  binding={conversation}
                  accessible={accessible}
                  onSet={(b) => onChange(withConversation(node, b))}
                />
                {thread.status === 'unsupported' ? (
                  <p className="text-xs text-rose-600">
                    This is a Task agent, so this link is ignored. Switch the
                    agent to Conversation (and publish it), or clear the link.
                  </p>
                ) : null}
              </>
            ) : null}
            {requiredInputs.map(renderInput)}
          </div>
        </div>
      ) : null}
      {hasOptional ? (
        <div className="space-y-1.5">
          <InputGroupLabel>Optional</InputGroupLabel>
          <div className="space-y-1.5">{optionalInputs.map(renderInput)}</div>
        </div>
      ) : null}
    </InspectorSection>
  )
}

// A subordinate group heading ("Required" / "Optional") under the "Needs" header.
function InputGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground/70 text-[10px] font-semibold tracking-wide uppercase">
      {children}
    </div>
  )
}

// The label shown in the conversation field when it has no explicit binding.
// Both states are failures now, not degradations — the engine throws on an
// unbound thread — so both warn. `unlinked` can name the source to link;
// `idle` has nothing upstream to point at yet.
function conversationEmptyState(
  thread: ThreadStatus,
): { text: string; tone: 'muted' | 'warn' } | undefined {
  if (thread.status === 'unlinked') {
    return {
      text: `Not linked — the run will fail · link to ${thread.sourceLabel}`,
      tone: 'warn',
    }
  }
  if (thread.status === 'idle') {
    return { text: 'Not linked — the run will fail', tone: 'warn' }
  }
  return undefined
}

// The literal is typed into a single text box, but a tool arg / prompt variable
// can declare a non-string JSON type. Coerce the string to that declared type so
// a numeric input (e.g. `keepCount`) is stored as `0` (number), not `"0"` —
// otherwise the tool's Zod schema rejects it at run time. Unparseable input falls
// back to the raw string, so the schema still surfaces a clear validation error.
function coerceLiteral(raw: string, type?: string): unknown {
  switch (type) {
    case 'number':
    case 'integer': {
      const n = Number(raw)
      return raw.trim() !== '' && !Number.isNaN(n) ? n : raw
    }
    case 'boolean': {
      if (raw === 'true') return true
      if (raw === 'false') return false
      return raw
    }
    case 'object':
    case 'array': {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    }
    default:
      return raw
  }
}

// Describes one binding: unmapped, a literal, or a ref into an upstream node.
function describeBinding(
  binding: ArgBinding | null,
  accessible: AccessibleNode[],
): string {
  if (!binding) return 'Not mapped'
  if (binding.kind === 'literal') {
    const v = binding.value
    return `Literal: ${typeof v === 'string' ? v : JSON.stringify(v)}`
  }
  const src = accessible.find((n) => n.nodeId === binding.nodeId)
  const label = src?.label ?? binding.nodeId
  return binding.path ? `${label} · ${binding.path}` : `${label} · whole output`
}

function BindingField({
  label,
  description,
  type,
  enumValues,
  binding,
  accessible,
  onSet,
  icon,
  emptyText,
  emptyTone,
}: {
  label: string
  description?: string
  /** JSON Schema type of the input, used to coerce a typed literal. */
  type?: string
  /** Allowed values when the input is an enum — the literal editor becomes a
   * picker so a free-text value can't be entered. */
  enumValues?: unknown[]
  binding: ArgBinding | null
  accessible: AccessibleNode[]
  onSet: (binding: ArgBinding | null) => void
  /** Optional leading glyph (e.g. a chat icon for the conversation field). */
  icon?: ReactNode
  /** Text shown in place of "Not mapped" when unbound — used to describe an
   * implicit/inherited value that applies until the input is linked. */
  emptyText?: string
  /** Tone for `emptyText`: a neutral hint or a warning. */
  emptyTone?: 'muted' | 'warn'
}) {
  const { Input, Select } = useWfComponents()
  const setHovered = useHoverHighlightSetter()
  const [open, setOpen] = useState(false)
  const [literal, setLiteral] = useState(
    binding?.kind === 'literal' ? String(binding.value ?? '') : '',
  )
  const mapped = Boolean(binding)
  // The full (untruncated) text shown in the row — surfaced as the hover title so
  // a long ref like "Chat message · clientOrgName" is fully readable.
  const shown =
    !mapped && emptyText ? emptyText : describeBinding(binding, accessible)
  // The upstream node this binding refs, if any — hovering illuminates it on canvas.
  const refNodeId = binding?.kind === 'ref' ? binding.nodeId : null

  return (
    <div className="rounded-md border border-input">
      <div className="flex items-center gap-2 px-2 py-1.5">
        {icon}
        <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-xs font-medium text-foreground">
          {label}
        </code>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            !mapped && emptyTone === 'warn'
              ? 'text-rose-600'
              : 'text-muted-foreground',
          )}
          title={description ? `${shown} — ${description}` : shown}
          onMouseEnter={refNodeId ? () => setHovered(refNodeId) : undefined}
          onMouseLeave={refNodeId ? () => setHovered(null) : undefined}
        >
          {shown}
        </span>
        {mapped ? (
          <button
            type="button"
            aria-label="Clear mapping"
            onClick={() => {
              onSet(null)
              setLiteral('')
            }}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-muted-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Map input"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'shrink-0 rounded p-0.5 hover:bg-accent',
            open
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-muted-foreground',
          )}
        >
          <Link2 className="size-3.5" />
        </button>
      </div>

      {open ? (
        <div className="space-y-2 border-t border-neutral-100 p-2">
          {accessible.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No upstream data to map from yet.
            </p>
          ) : (
            <div className="space-y-1.5">
              {accessible.map((n) => (
                <BindingSourceNode
                  key={n.nodeId}
                  node={n}
                  onPick={(path) => {
                    onSet({ kind: 'ref', nodeId: n.nodeId, path })
                    setOpen(false)
                  }}
                />
              ))}
            </div>
          )}
          {enumValues && enumValues.length > 0 ? (
            // Enum input: pick from the allowed values — no free-text, so an
            // invalid literal can't be entered. Selecting sets it immediately.
            <div className="flex items-center gap-1.5 border-t border-neutral-100 pt-2">
              <Pencil className="size-3 shrink-0 text-muted-foreground" />
              <Select
                value={
                  binding?.kind === 'literal' ? String(binding.value ?? '') : ''
                }
                onChange={(e) => {
                  const picked = enumValues.find(
                    (v) => String(v) === e.target.value,
                  )
                  if (picked === undefined) return
                  onSet({ kind: 'literal', value: picked })
                  setOpen(false)
                }}
                className="h-7 flex-1 rounded border border-input bg-card px-1.5 text-xs text-foreground"
              >
                <option value="" disabled>
                  Select a value…
                </option>
                {enumValues.map((v) => (
                  <option key={String(v)} value={String(v)}>
                    {String(v)}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 border-t border-neutral-100 pt-2">
              <Pencil className="size-3 shrink-0 text-muted-foreground" />
              <Input
                value={literal}
                placeholder="or type a literal value…"
                onChange={(e) => setLiteral(e.target.value)}
                className="h-7 flex-1 text-xs"
              />
              <button
                type="button"
                disabled={literal.length === 0}
                onClick={() => {
                  onSet({
                    kind: 'literal',
                    value: coerceLiteral(literal, type),
                  })
                  setOpen(false)
                }}
                className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent disabled:opacity-40"
              >
                Set
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
