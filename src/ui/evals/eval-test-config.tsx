import {
  ArrowRightToLine,
  Binary,
  Braces,
  ChevronDown,
  Gauge,
  type LucideIcon,
  Text,
  Waypoints,
  Wrench,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { JsonSchema } from '../../engine'
import type { EvalCheck, WfEvalTargetKind } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { ModelSelect } from '../editor/model-select'
import { useCommittedField } from '../use-committed-field'
import {
  BoolPicker,
  MatchRow,
  outputPathOptions,
  TextField,
  ToolPicker,
} from './fields'
import { PickerCards, StepFlow, type Step } from './step-flow'

export type TestFamily = 'binary' | 'scored'

const BINARY_TYPES = [
  'tool_called',
  'tool_args_match',
  'node_visited',
  'node_input_match',
  'output_match',
] as const
type BinaryType = (typeof BINARY_TYPES)[number]

// Human-readable label, blurb, and icon for each binary assertion — drives the
// picker so authors never see the raw `snake_case` type ids.
const BINARY_TYPE_META: Record<
  BinaryType,
  { label: string; desc: string; icon: LucideIcon }
> = {
  tool_called: {
    label: 'Tool called',
    desc: 'A specific tool was (or wasn’t) called',
    icon: Wrench,
  },
  tool_args_match: {
    label: 'Tool arguments',
    desc: 'A called tool’s arguments match a value',
    icon: Braces,
  },
  node_visited: {
    label: 'Node visited',
    desc: 'A workflow node was (or wasn’t) reached',
    icon: Waypoints,
  },
  node_input_match: {
    label: 'Node input',
    desc: 'A node’s input matches a value',
    icon: ArrowRightToLine,
  },
  output_match: {
    label: 'Output matches',
    desc: 'The final output matches a value',
    icon: Text,
  },
}

export function familyOf(check: EvalCheck): TestFamily {
  return check.type === 'llm_judge' ? 'scored' : 'binary'
}

export function defaultCheck(type: EvalCheck['type']): EvalCheck {
  switch (type) {
    case 'tool_called':
      return { type, toolId: '', called: true }
    case 'tool_args_match':
      return { type, toolId: '', match: 'contains', value: '' }
    case 'node_visited':
      return { type, nodeId: '', visited: true }
    case 'node_input_match':
      return { type, nodeId: '', match: 'contains', value: '' }
    case 'output_match':
      return { type, match: 'contains', value: '' }
    case 'llm_judge':
      return { type, rubric: '', threshold: 0.7, weight: 1 }
  }
}

/** Carry the user-authored title/description across a type/family switch. */
export function withMeta(check: EvalCheck, from: EvalCheck | null): EvalCheck {
  return { ...check, label: from?.label, description: from?.description }
}

export function ConfigForm({
  draft,
  persist,
  setFamily,
  targetKind,
  outputSchema,
}: {
  draft: EvalCheck
  persist: (next: EvalCheck) => void
  setFamily: (family: TestFamily) => void
  targetKind?: WfEvalTargetKind
  outputSchema?: JsonSchema | null
}) {
  const family = familyOf(draft)
  const steps: Step[] = [
    {
      key: 'config',
      title: 'Configuration',
      content:
        draft.type === 'llm_judge' ? (
          <JudgeConfig check={draft} persist={persist} />
        ) : (
          <BinaryConfig
            check={draft}
            persist={persist}
            targetKind={targetKind}
            outputSchema={outputSchema}
          />
        ),
    },
  ]
  return (
    <div className="space-y-3">
      <PickerCards
        value={family}
        onSelect={(f) => setFamily(f)}
        options={[
          {
            value: 'binary',
            icon: Binary,
            label: 'Binary',
            desc: 'A deterministic pass/fail check.',
            accent: 'sky',
          },
          {
            value: 'scored',
            icon: Gauge,
            label: 'Scored',
            desc: 'An LLM judge grades the output against a rubric.',
            accent: 'amber',
          },
        ]}
      />
      <StepFlow steps={steps} />
    </div>
  )
}

// ── Binary check config ──────────────────────────────────────────────────────

function BinaryConfig({
  check,
  persist,
  targetKind,
  outputSchema,
}: {
  check: EvalCheck
  persist: (next: EvalCheck) => void
  targetKind?: WfEvalTargetKind
  outputSchema?: JsonSchema | null
}) {
  const { Label } = useWfComponents()
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>What to check</Label>
        <BinaryTypePicker
          value={check.type as BinaryType}
          targetKind={targetKind}
          onChange={(t) => persist(withMeta(defaultCheck(t), check))}
        />
      </div>
      <BinaryFields
        check={check}
        persist={persist}
        outputSchema={outputSchema}
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
// `node_*` checks read the workflow step trace, which agents don't produce, so
// they're only offered when the goal targets a workflow.
const NODE_TYPES: readonly BinaryType[] = ['node_visited', 'node_input_match']

function BinaryTypePicker({
  value,
  onChange,
  targetKind,
}: {
  value: BinaryType
  onChange: (type: BinaryType) => void
  targetKind?: WfEvalTargetKind
}) {
  const [open, setOpen] = useState(false)
  const types =
    targetKind === 'agent'
      ? BINARY_TYPES.filter((t) => !NODE_TYPES.includes(t))
      : BINARY_TYPES
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
    window.addEventListener('scroll', onScroll, true)
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
    </>
  )
}

function BinaryFields({
  check,
  persist,
  outputSchema,
}: {
  check: EvalCheck
  persist: (next: EvalCheck) => void
  outputSchema?: JsonSchema | null
}) {
  switch (check.type) {
    case 'tool_called':
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ToolPicker
            value={check.toolId}
            onChange={(toolId) => persist({ ...check, toolId })}
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
          <ToolPicker
            value={check.toolId}
            onChange={(toolId) => persist({ ...check, toolId })}
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

// ── Scored (judge) config ────────────────────────────────────────────────────

function JudgeConfig({
  check,
  persist,
}: {
  check: Extract<EvalCheck, { type: 'llm_judge' }>
  persist: (next: EvalCheck) => void
}) {
  const { Input, Label, Textarea } = useWfComponents()
  const rubricField = useCommittedField(check.rubric, (rubric) =>
    persist({ ...check, rubric }),
  )

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Judge model</Label>
        <ModelSelect
          value={check.modelId ?? ''}
          onChange={(modelId) =>
            persist({ ...check, modelId: modelId || undefined })
          }
        />
        <p className="text-xs text-neutral-400">
          Optional — falls back to the host&apos;s default judge model.
        </p>
      </div>
      <div className="space-y-1">
        <Label>Rubric</Label>
        <Textarea
          rows={3}
          value={rubricField.value}
          placeholder="What should the judge reward or penalize?"
          onChange={(e) => rubricField.onChange(e.target.value)}
          onBlur={rubricField.onBlur}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Threshold</Label>
          <Input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={String(check.threshold ?? 0.7)}
            onChange={(e) =>
              persist({ ...check, threshold: Number(e.target.value) })
            }
          />
        </div>
        <div className="space-y-1">
          <Label>Weight</Label>
          <Input
            type="number"
            step="0.5"
            min="0"
            value={String(check.weight ?? 1)}
            onChange={(e) =>
              persist({ ...check, weight: Number(e.target.value) })
            }
          />
        </div>
      </div>
      <p className="text-xs text-neutral-400">
        Scored tests contribute to the goal/sample score; the threshold maps the
        0–1 judge score to pass/fail, weight scales its share of the mean.
      </p>
    </div>
  )
}
