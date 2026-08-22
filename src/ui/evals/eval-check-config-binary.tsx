import { AlertTriangle, ChevronDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { JsonSchema } from '../../engine'
import type { EvalCheck, WfEvalTargetKind } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'

import {
  BINARY_TYPE_META,
  BINARY_TYPES,
  type BinaryType,
  defaultCheck,
} from './eval-check-config-shared'
import {
  BoolPicker,
  MatchRow,
  outputPathOptions,
  TextField,
  EvalToolPicker,
} from './fields'

// ── Binary check config ──────────────────────────────────────────────────────

export function BinaryConfig({
  check,
  persist,
  targetKind,
  hasTools,
  outputSchema,
  allowToolIds,
}: {
  check: EvalCheck
  persist: (next: EvalCheck) => void
  targetKind?: WfEvalTargetKind
  /** Whether the target has any tools at all (null = still resolving). */
  hasTools?: boolean | null
  outputSchema?: JsonSchema | null
  allowToolIds?: string[]
}) {
  const { Label } = useWfComponents()
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>What to check</Label>
        <BinaryTypePicker
          value={check.type as BinaryType}
          targetKind={targetKind}
          hasTools={hasTools}
          onChange={(t) => persist(defaultCheck(t))}
        />
      </div>
      <BinaryFields
        check={check}
        persist={persist}
        outputSchema={outputSchema}
        allowToolIds={allowToolIds}
      />
      <p className="text-xs text-neutral-400">
        Binary checks are pure pass/fail — they never enter the score.
      </p>
    </div>
  )
}

// The binary assertion selector — a dropdown of human-readable check types
// (icon + label + blurb). The open menu is portaled to <body> and fixed-positioned
// under the trigger so it overlays the content below instead of pushing it down
// (and so the StepFlow card's `overflow-hidden` can't clip it).
// Two kinds of assertion are offered only where they could ever hold:
// `node_*` checks read the workflow step trace, which agents don't produce, so
// they're only offered when the goal targets a workflow; `tool_*` checks are
// unsatisfiable by construction against an agent wired to no tools, so an agent
// with none is never asked about them. Both are hidden rather than disabled —
// an option you can't pick is a question you shouldn't have been asked. That
// holds even when the check ALREADY is one of them (authored before the target
// lost its tools, or via the family toggle): the type stays visible in the
// trigger, but it isn't offered, and a line underneath says why.
const NODE_TYPES: readonly BinaryType[] = ['node_visited', 'node_input_match']
const TOOL_TYPES: readonly BinaryType[] = ['tool_called', 'tool_args_match']

function BinaryTypePicker({
  value,
  onChange,
  targetKind,
  hasTools,
}: {
  value: BinaryType
  onChange: (type: BinaryType) => void
  targetKind?: WfEvalTargetKind
  hasTools?: boolean | null
}) {
  const [open, setOpen] = useState(false)
  const applies = (t: BinaryType) =>
    (targetKind !== 'agent' || !NODE_TYPES.includes(t)) &&
    (hasTools !== false || !TOOL_TYPES.includes(t))
  const types = BINARY_TYPES.filter(applies)
  // The stored type can be one this target can't satisfy. The trigger still
  // names it — reading "Select a check…" over a config it plainly has would be
  // worse — but it's not in the menu, so the only way out is a type that works.
  const staleReason = applies(value)
    ? null
    : TOOL_TYPES.includes(value)
      ? 'This agent has no tools, so this check can never pass.'
      : 'This goal targets an agent, which has no workflow nodes, so this check can never pass.'
  const [rect, setRect] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const reposition = () => {
    if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect())
  }

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const onScroll = () => reposition()
    window.addEventListener('scroll', onScroll, {capture: true})
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t))
        return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = BINARY_TYPE_META[value]
  const CurrentIcon = current?.icon

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full max-w-md items-center gap-2 rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none transition focus:border-neutral-500"
      >
        {CurrentIcon ? (
          <CurrentIcon className="size-4 shrink-0 text-neutral-500" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-left text-neutral-800">
          {current?.label ?? 'Select a check…'}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-neutral-400 transition',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && rect
        ? createPortal(
            <div
              ref={menuRef}
              role="listbox"
              className="fixed z-50 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg"
              style={{
                top: rect.bottom + 4,
                left: rect.left,
                width: rect.width,
              }}
            >
              {types.map((t) => {
                const m = BINARY_TYPE_META[t]
                const Icon = m.icon
                const isSel = t === value
                return (
                  <button
                    key={t}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    onClick={() => {
                      onChange(t)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-2 py-1.5 text-left transition',
                      isSel ? 'bg-neutral-100' : 'hover:bg-neutral-50',
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-neutral-500" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-neutral-800">
                        {m.label}
                      </span>
                      <span className="block truncate text-xs text-neutral-400">
                        {m.desc}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>,
            document.body,
          )
        : null}

      {staleReason ? (
        <p className="mt-1 flex items-start gap-1 text-xs text-amber-600">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span>{staleReason} Pick another check.</span>
        </p>
      ) : null}
    </>
  )
}

function BinaryFields({
  check,
  persist,
  outputSchema,
  allowToolIds,
}: {
  check: EvalCheck
  persist: (next: EvalCheck) => void
  outputSchema?: JsonSchema | null
  allowToolIds?: string[]
}) {
  switch (check.type) {
    case 'tool_called':
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <EvalToolPicker
            value={check.toolId}
            onChange={(toolId) => persist({ ...check, toolId })}
            allowToolIds={allowToolIds}
          />
          <BoolPicker
            label="Expectation"
            value={check.called}
            trueLabel="was called"
            falseLabel="was not called"
            onChange={(called) => persist({ ...check, called })}
          />
        </div>
      )
    case 'tool_args_match':
      return (
        <div className="space-y-3">
          <EvalToolPicker
            value={check.toolId}
            onChange={(toolId) => persist({ ...check, toolId })}
            allowToolIds={allowToolIds}
          />
          <MatchRow
            path={check.path}
            match={check.match}
            value={check.value}
            pathLabel="Args path (optional)"
            pathPlaceholder="e.g. amount"
            onChange={(p) => persist({ ...check, ...p })}
          />
        </div>
      )
    case 'node_visited':
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField
            label="Node id"
            value={check.nodeId}
            placeholder="node id from the graph"
            onCommit={(nodeId) => persist({ ...check, nodeId })}
          />
          <BoolPicker
            label="Expectation"
            value={check.visited}
            trueLabel="was visited"
            falseLabel="was not visited"
            onChange={(visited) => persist({ ...check, visited })}
          />
        </div>
      )
    case 'node_input_match':
      return (
        <div className="space-y-3">
          <TextField
            label="Node id"
            value={check.nodeId}
            placeholder="node id from the graph"
            onCommit={(nodeId) => persist({ ...check, nodeId })}
          />
          <MatchRow
            path={check.path}
            match={check.match}
            value={check.value}
            pathLabel="Input path (optional)"
            pathPlaceholder="e.g. reason"
            onChange={(p) => persist({ ...check, ...p })}
          />
        </div>
      )
    case 'output_match': {
      const pathOptions = outputPathOptions(outputSchema)
      return (
        <MatchRow
          path={check.path}
          match={check.match}
          value={check.value}
          pathLabel={pathOptions ? 'Output field' : 'Output path (optional)'}
          pathPlaceholder="e.g. status"
          pathOptions={pathOptions}
          onChange={(p) => persist({ ...check, ...p })}
        />
      )
    }
    case 'llm_judge':
      return null
  }
}
