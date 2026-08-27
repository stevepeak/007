import { AlertTriangle, HelpCircle, Link2, Pencil, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import type {
  ArgBinding,
  JsonSchema,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { toText } from '../to-text'
import { Tooltip } from '../tooltip'

import { BindingSourceNode, pickableSources } from './node-data-panel-picker'
import {
  bindingsOf,
  useAccessibleData,
  withBinding,
  withConversation,
} from './node-data-panel-shared'
import { InspectorSection, SectionHeader } from './node-inspector-shared'
import {
  agentThreadSource,
  coerceLiteral,
  literalIssue,
  nodeRequires,
  normalizeJsonType,
  type AccessibleNode,
  type NodeInput,
  type ThreadStatus,
} from './node-io'
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
  const thread = useMemo<ThreadStatus>(
    () =>
      node.kind === 'agent'
        ? agentThreadSource(graph, node.id, maps)
        : { status: 'none' },
    [node, graph, maps],
  )
  const bindings = bindingsOf(node)
  if (
    node.kind !== 'agent' &&
    node.kind !== 'tool' &&
    node.kind !== 'workflow' &&
    node.kind !== 'text'
  ) {
    return null
  }

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
      {node.kind === 'workflow' && !nothingToShow ? (
        // Two modes, and which one is active is decided by whether ANY field is
        // bound — see `buildCalleeTriggerInput`. Saying so here is the only way
        // an author can tell that an empty panel is a working configuration.
        <p className="text-muted-foreground text-xs">
          {Object.keys(bindings).length === 0
            ? 'Nothing mapped: the called workflow receives this step’s incoming data unchanged. Map a field to build its input explicitly instead.'
            : 'Mapped fields build the called workflow’s input. Anything left unmapped is omitted — it is not filled in from the incoming data.'}
        </p>
      ) : null}
      {nothingToShow ? (
        <p className="text-muted-foreground text-xs">
          {node.kind === 'agent'
            ? 'This agent needs no variables.'
            : node.kind === 'workflow'
              ? 'Pick a workflow to call, and publish it, to see what it takes. Its trigger payload is what you map here.'
              : node.kind === 'text'
                ? 'This text has no ${variables} yet — add one to the body above and it appears here to map.'
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
                    empty?.tone === 'warn' ||
                    thread.status === 'unsupported' ? (
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

// How to name the type in prose, for the "nothing upstream fits" line.
function typeNoun(type?: string): string {
  switch (normalizeJsonType(type)) {
    case 'number':
      return 'number'
    case 'boolean':
      return 'true/false value'
    case 'object':
      return 'object'
    case 'array':
      return 'list'
    case 'string':
      return 'text value'
    default:
      return 'value'
  }
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
  /** JSON Schema type of the input. Decides which literal editor is offered and
   * which upstream fields the picker is allowed to show. */
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
  const setHovered = useHoverHighlightSetter()
  const [open, setOpen] = useState(false)
  const [literal, setLiteral] = useState(() =>
    binding?.kind === 'literal' ? toText(binding.value) : '',
  )
  // Only what this input can actually take. An upstream `string` is not offered
  // to a `boolean` argument, because the run would just fail Zod validation on
  // it — see `acceptsValueType` for how permissive the rule is.
  const sources = useMemo(
    () => pickableSources(accessible, type),
    [accessible, type],
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
        {description ? (
          // The input's own documentation, straight from the tool's Zod schema
          // (`.describe(...)` on the argument) or the trigger payload it maps to.
          // An author binding a field usually can't tell what it expects from the
          // name alone, so where the schema says, it is one hover away instead of
          // buried in a native `title=`.
          <Tooltip content={description} side="left" className="shrink-0">
            <HelpCircle
              aria-label={`About ${label}`}
              className="size-3.5 text-muted-foreground/60 transition hover:text-muted-foreground"
            />
          </Tooltip>
        ) : null}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            !mapped && emptyTone === 'warn'
              ? 'text-rose-600'
              : 'text-muted-foreground',
          )}
          title={shown}
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
          ) : sources.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No upstream {typeNoun(type)} to map from — nothing above this step
              produces one. Set it below instead.
            </p>
          ) : (
            <div className="space-y-1.5">
              {sources.map((s) => (
                <BindingSourceNode
                  key={s.node.nodeId}
                  source={s}
                  onPick={(path) => {
                    onSet({ kind: 'ref', nodeId: s.node.nodeId, path })
                    setOpen(false)
                  }}
                />
              ))}
            </div>
          )}
          <LiteralEditor
            type={type}
            enumValues={enumValues}
            binding={binding}
            literal={literal}
            setLiteral={setLiteral}
            onCommit={(value) => {
              onSet({ kind: 'literal', value })
              setOpen(false)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * The "or just type the value" half of the picker, shaped by what the input
 * declares. The control matches the type rather than making every value a
 * string the author has to spell correctly: an enum picks, a boolean toggles, a
 * number takes a number field, an object/array takes JSON that must parse
 * before it can be set. Only an untyped/string input still gets a plain box.
 */
function LiteralEditor({
  type,
  enumValues,
  binding,
  literal,
  setLiteral,
  onCommit,
}: {
  type?: string
  enumValues?: unknown[]
  binding: ArgBinding | null
  literal: string
  setLiteral: (value: string) => void
  onCommit: (value: unknown) => void
}) {
  const { Input, Select, Textarea } = useWfComponents()
  const current = binding?.kind === 'literal' ? binding.value : undefined
  const jsonType = normalizeJsonType(type)

  if (enumValues && enumValues.length > 0) {
    // Enum input: pick from the allowed values — no free-text, so an invalid
    // literal can't be entered. Selecting sets it immediately.
    return (
      <LiteralRow>
        <Select
          value={current === undefined ? '' : toText(current)}
          onChange={(e) => {
            const picked = enumValues.find((v) => String(v) === e.target.value)
            if (picked === undefined) return
            onCommit(picked)
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
      </LiteralRow>
    )
  }

  if (jsonType === 'boolean') {
    // A boolean has exactly two literals, so it gets two buttons. Typing "true"
    // into a text box was the old way to store the STRING "true", which the
    // tool's Zod schema then rejected at run time.
    return (
      <LiteralRow>
        <div className="flex flex-1 overflow-hidden rounded border border-input">
          {[true, false].map((v) => {
            const active = current === v
            return (
              <button
                key={String(v)}
                type="button"
                aria-pressed={active}
                onClick={() => onCommit(v)}
                className={cn(
                  'flex-1 px-2 py-1 text-xs transition',
                  active
                    ? 'bg-neutral-900 text-white'
                    : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {String(v)}
              </button>
            )
          })}
        </div>
      </LiteralRow>
    )
  }

  const issue = literalIssue(literal, type)
  const ready = literal.trim().length > 0 && !issue
  const set = () => {
    if (ready) onCommit(coerceLiteral(literal, type))
  }

  if (jsonType === 'object' || jsonType === 'array') {
    // Structured literals are edited as JSON and must parse — an unparseable
    // string used to be stored verbatim and fail the run instead.
    return (
      <div className="space-y-1 border-t border-neutral-100 pt-2">
        <div className="flex items-start gap-1.5">
          <Pencil className="mt-1.5 size-3 shrink-0 text-muted-foreground" />
          <Textarea
            value={literal}
            rows={2}
            spellCheck={false}
            placeholder={jsonType === 'array' ? '["…"]' : '{ "key": "value" }'}
            onChange={(e) => setLiteral(e.target.value)}
            className="flex-1 rounded border border-input px-1.5 py-1 font-mono text-xs"
          />
          <button
            type="button"
            disabled={!ready}
            onClick={set}
            className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent disabled:opacity-40"
          >
            Set
          </button>
        </div>
        {issue ? <p className="pl-4.5 text-xs text-rose-600">{issue}</p> : null}
      </div>
    )
  }

  const numeric = jsonType === 'number'
  return (
    <div className="space-y-1 border-t border-neutral-100 pt-2">
      <div className="flex items-center gap-1.5">
        <Pencil className="size-3 shrink-0 text-muted-foreground" />
        <Input
          value={literal}
          type={numeric ? 'number' : 'text'}
          step={type === 'integer' ? 1 : undefined}
          placeholder={
            numeric ? 'or type a number…' : 'or type a literal value…'
          }
          onChange={(e) => setLiteral(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              set()
            }
          }}
          className="h-7 flex-1 text-xs"
        />
        <button
          type="button"
          disabled={!ready}
          onClick={set}
          className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent disabled:opacity-40"
        >
          Set
        </button>
      </div>
      {issue ? <p className="pl-4.5 text-xs text-rose-600">{issue}</p> : null}
    </div>
  )
}

// The shared frame for a one-line literal control: the pencil, then the control.
function LiteralRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 border-t border-neutral-100 pt-2">
      <Pencil className="size-3 shrink-0 text-muted-foreground" />
      {children}
    </div>
  )
}
