import {
  ArrowRightToLine,
  Binary,
  Braces,
  ChevronDown,
  FlaskConical,
  Gauge,
  Goal,
  type LucideIcon,
  Microscope,
  Play,
  Text,
  Waypoints,
  Wrench,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { agentOutputJsonSchema, type JsonSchema } from '../../engine'
import type {
  EvalCheck,
  EvalMatch,
  WfEvalTargetKind,
} from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useAgents, useEvalSet, useTools, useUpsertEvalRow } from '../hooks'
import { useWfNav } from '../nav'
import { ArchiveButton } from '../archive-button'
import { WfShell } from '../shell'
import { ToolIcon } from '../tool-icon'
import { sectionCrumb } from '../wf-crumbs'
import { ModelSelect } from '../editor/model-select'
import { RunConfigDialog } from './run-config-dialog'
import { describeCheck, EmptyState } from './shared'
import { PickerCards, StepFlow, type Step } from './step-flow'

// The single-test view
// (route: evals/<setId>/samples/<sampleId>/tests/<testIndex>). A "Test" is one
// EvalCheck inside the sample row's `checks` tree, addressed by its index. The
// Configuration flow picks the family (binary vs scored) and its type, then the
// type-specific fields. Every edit persists the whole row (rows are mutable).

type TestFamily = 'binary' | 'scored'

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

const MATCH_OPTIONS: EvalMatch[] = ['equals', 'contains', 'jsonpath', 'regex']

function familyOf(check: EvalCheck): TestFamily {
  return check.type === 'llm_judge' ? 'scored' : 'binary'
}

function defaultCheck(type: EvalCheck['type']): EvalCheck {
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
function withMeta(check: EvalCheck, from: EvalCheck | null): EvalCheck {
  return { ...check, label: from?.label, description: from?.description }
}

/** Render a stored check value back into an editable string. */
function valueToStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined) return ''
  return JSON.stringify(v)
}
/** Parse an entered value: JSON when it parses (numbers/booleans/objects), else raw string. */
function parseValue(s: string): unknown {
  const t = s.trim()
  if (t === '') return ''
  try {
    return JSON.parse(t)
  } catch {
    return s
  }
}

export type EvalTestProps = {
  setId: string
  sampleId: string
  /** The check's index within the sample row's checks tree (as a string). */
  testId: string
  className?: string
}

export function EvalTest({
  setId,
  sampleId,
  testId,
  className,
}: EvalTestProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [runOpen, setRunOpen] = useState(false)

  const index = Number(testId)
  const { data, isLoading } = useEvalSet(setId)
  const set = data?.set
  const row = useMemo(
    () => data?.rows.find((r) => r.id === sampleId),
    [data?.rows, sampleId],
  )
  const stored =
    row && Number.isInteger(index) ? row.checks.checks[index] : undefined
  const upsertRow = useUpsertEvalRow()

  // When the goal targets an agent, the agent's declared output contract lets us
  // offer its fields (with descriptions) as the "output path" instead of a raw
  // free-form path. Only agents have a single known output schema; workflows keep
  // the free-form path.
  const agentsQuery = useAgents()
  const outputSchema = useMemo<JsonSchema | null>(() => {
    if (set?.targetKind !== 'agent') return null
    const output = agentsQuery.data?.find((a) => a.id === set.targetId)?.output
    return output ? agentOutputJsonSchema(output) : null
  }, [set?.targetKind, set?.targetId, agentsQuery.data])

  // Local draft of this one check, synced per (row, index). Title/description
  // mirror the draft's label/description as their own inputs so typing stays
  // smooth; they commit on blur.
  const [draft, setDraft] = useState<EvalCheck | null>(null)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const syncKey = useRef<string | null>(null)
  useEffect(() => {
    const key = row ? `${row.id}:${index}` : null
    if (stored && key && syncKey.current !== key) {
      setDraft(stored)
      setTitle(stored.label ?? '')
      setDesc(stored.description ?? '')
      syncKey.current = key
    }
  }, [stored, row, index])

  const persist = (next: EvalCheck) => {
    if (!row) return
    setDraft(next)
    const checks = [...row.checks.checks]
    checks[index] = next
    upsertRow.mutate({
      id: row.id,
      setId,
      name: row.name,
      initialCondition: row.initialCondition,
      fixtures: row.fixtures,
      checks: { ...row.checks, checks },
    })
  }

  // Commit the user-authored title/description onto the check.
  const commitMeta = (patch: { label?: string; description?: string }) => {
    if (!draft) return
    persist({ ...draft, ...patch } as EvalCheck)
  }

  const removeTest = () => {
    if (!row) return
    const checks = row.checks.checks.filter((_, i) => i !== index)
    upsertRow.mutate({
      id: row.id,
      setId,
      name: row.name,
      initialCondition: row.initialCondition,
      fixtures: row.fixtures,
      checks: { ...row.checks, checks },
    })
    navigate(`evals/${setId}/samples/${sampleId}`)
  }

  const setFamily = (family: TestFamily) => {
    if (family === familyOf(draft ?? defaultCheck('tool_called'))) return
    persist(
      withMeta(
        defaultCheck(family === 'scored' ? 'llm_judge' : 'tool_called'),
        draft,
      ),
    )
  }

  return (
    <WfShell
      className={className}
      scroll
      titleIcon={<FlaskConical className="size-5 shrink-0 text-rose-500" />}
      assetLabel="Test"
      crumbs={[
        { home: true },
        sectionCrumb('evals'),
        {
          assetLabel: 'Goal',
          label: set?.name ?? 'Goal',
          to: `evals/${setId}`,
          icon: Goal,
          iconClassName: 'text-rose-500',
        },
        {
          assetLabel: 'Sample',
          label: row?.name ?? 'Sample',
          to: `evals/${setId}/samples/${sampleId}`,
          icon: Microscope,
          iconClassName: 'text-rose-500',
        },
        row && draft
          ? {
              editable: {
                value: title,
                onChange: setTitle,
                onCommit: () => {
                  if ((title.trim() || undefined) !== draft.label)
                    commitMeta({ label: title.trim() || undefined })
                },
                ariaLabel: 'Test title',
                placeholder: describeCheck({ ...draft, label: undefined }),
              },
            }
          : { label: 'Test' },
      ]}
      descriptionEditable={
        row && draft
          ? {
              value: desc,
              onChange: setDesc,
              onCommit: () => {
                if ((desc.trim() || undefined) !== draft.description)
                  commitMeta({ description: desc.trim() || undefined })
              },
              ariaLabel: 'Test description',
            }
          : undefined
      }
      actions={
        row && draft ? (
          <>
            <ArchiveButton
              title="Delete test"
              confirmLabel="Hold to delete"
              description={
                <>
                  Delete <strong>{describeCheck(draft)}</strong>? It’ll be
                  removed from this sample&apos;s tests.
                </>
              }
              onConfirm={removeTest}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRunOpen(true)}
            >
              <Play className="size-4" />
              Run Test
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        {isLoading && !row ? (
          <EmptyState message="Loading test…" />
        ) : !row || !draft ? (
          <EmptyState message="This test doesn't exist, or was removed." />
        ) : (
          <>
            <RunConfigDialog
              open={runOpen}
              onClose={() => setRunOpen(false)}
              scope="test"
              targetName={set?.name || 'goal'}
              setIds={[setId]}
            />

            <ConfigForm
              draft={draft}
              persist={persist}
              setFamily={setFamily}
              targetKind={set?.targetKind}
              outputSchema={outputSchema}
            />
          </>
        )}
      </div>
    </WfShell>
  )
}

function ConfigForm({
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
  const [rubric, setRubric] = useState(check.rubric)
  const rubricRef = useRef(check.rubric)
  useEffect(() => {
    if (check.rubric !== rubricRef.current) {
      setRubric(check.rubric)
      rubricRef.current = check.rubric
    }
  }, [check.rubric])

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
          value={rubric}
          placeholder="What should the judge reward or penalize?"
          onChange={(e) => setRubric(e.target.value)}
          onBlur={() => {
            if (rubric !== check.rubric) {
              rubricRef.current = rubric
              persist({ ...check, rubric })
            }
          }}
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

// ── Field primitives ─────────────────────────────────────────────────────────

// Tool selector — a dropdown of the host's tools (icon + name + short blurb),
// replacing the bare name-only <select>. Expands inline (in normal flow) so it
// can't be clipped by the StepFlow card's `overflow-hidden`.
function ToolPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (toolId: string) => void
}) {
  const { Label } = useWfComponents()
  const toolsQuery = useTools()
  const tools = toolsQuery.data ?? []
  const selected = tools.find((t) => t.id === value)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
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

  return (
    <div className="space-y-1">
      <Label>Tool</Label>
      <div ref={rootRef} className="space-y-2">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex h-9 w-full items-center gap-2 rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none transition focus:border-neutral-500"
        >
          <ToolIcon icon={selected?.icon} className="size-5" />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-left',
              selected ? 'text-neutral-800' : 'text-neutral-400',
            )}
          >
            {selected?.name ??
              (toolsQuery.isLoading ? 'Loading tools…' : 'Select a tool…')}
            {value && !selected && !toolsQuery.isLoading ? (
              <span className="ml-1 text-xs text-amber-600">(not found)</span>
            ) : null}
          </span>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-neutral-400 transition',
              open && 'rotate-180',
            )}
          />
        </button>

        {open ? (
          <div className="max-h-72 overflow-y-auto rounded-md border border-neutral-200 py-1">
            {toolsQuery.isLoading ? (
              <div className="px-3 py-6 text-center text-sm text-neutral-400">
                Loading tools…
              </div>
            ) : tools.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-neutral-500">
                No tools available.
              </div>
            ) : (
              tools.map((t) => {
                const isSel = t.id === value
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    onClick={() => {
                      onChange(t.id)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-2 py-1.5 text-left transition',
                      isSel ? 'bg-neutral-100' : 'hover:bg-neutral-50',
                    )}
                  >
                    <ToolIcon icon={t.icon} className="size-5" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-neutral-800">
                        {t.name}
                      </span>
                      {t.description ? (
                        <span className="block truncate text-xs text-neutral-400">
                          {t.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function BoolPicker({
  label,
  value,
  trueLabel,
  falseLabel,
  onChange,
}: {
  label: string
  value: boolean
  trueLabel: string
  falseLabel: string
  onChange: (v: boolean) => void
}) {
  const { Label } = useWfComponents()
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <select
        value={value ? 'true' : 'false'}
        onChange={(e) => onChange(e.target.value === 'true')}
        className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
      >
        <option value="true">{trueLabel}</option>
        <option value="false">{falseLabel}</option>
      </select>
    </div>
  )
}

function TextField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string
  value: string
  placeholder?: string
  onCommit: (v: string) => void
}) {
  const { Input, Label } = useWfComponents()
  const [local, setLocal] = useState(value)
  const ref = useRef(value)
  useEffect(() => {
    if (value !== ref.current) {
      setLocal(value)
      ref.current = value
    }
  }, [value])
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        value={local}
        placeholder={placeholder}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local !== ref.current) {
            ref.current = local
            onCommit(local)
          }
        }}
        className="font-mono text-xs"
      />
    </div>
  )
}

/** A selectable field from a target's output schema — drives the path dropdown. */
type PathOption = {
  value: string
  label: string
  type?: string
  description?: string
}

// Top-level fields of an output JSON Schema, as path options (with descriptions).
// Null when there's no usable object schema — callers fall back to a free-form path.
function outputPathOptions(
  schema: JsonSchema | null | undefined,
): PathOption[] | null {
  if (!schema || schema.type !== 'object') return null
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>
  const entries = Object.entries(props)
  if (entries.length === 0) return null
  return entries.map(([key, s]) => ({
    value: key,
    label: key,
    type: typeof s.type === 'string' ? s.type : undefined,
    description: typeof s.description === 'string' ? s.description : undefined,
  }))
}

// The match/path/value trio shared by the *_match check types. When `pathOptions`
// is supplied (an agent target with a known output schema), the path is chosen
// from a dropdown of the schema's fields — with each field's description shown —
// instead of a free-form text box.
function MatchRow({
  path,
  match,
  value,
  pathLabel,
  pathPlaceholder,
  pathOptions,
  onChange,
}: {
  path: string | undefined
  match: EvalMatch
  value: unknown
  pathLabel: string
  pathPlaceholder?: string
  pathOptions?: PathOption[] | null
  onChange: (patch: {
    path?: string
    match?: EvalMatch
    value?: unknown
  }) => void
}) {
  const { Input, Label } = useWfComponents()
  const [pathLocal, setPathLocal] = useState(path ?? '')
  const [valueLocal, setValueLocal] = useState(valueToStr(value))
  const pathRef = useRef(path ?? '')
  const valueRef = useRef(valueToStr(value))
  useEffect(() => {
    const p = path ?? ''
    if (p !== pathRef.current) {
      setPathLocal(p)
      pathRef.current = p
    }
  }, [path])
  useEffect(() => {
    const v = valueToStr(value)
    if (v !== valueRef.current) {
      setValueLocal(v)
      valueRef.current = v
    }
  }, [value])

  const selectedField = pathOptions?.find((o) => o.value === (path ?? ''))
  // Preserve a stored path that isn't in the schema (nested/custom) as its own
  // option so switching targets or hand-authored paths never silently vanish.
  const showsCustom = Boolean(
    pathOptions && path && !pathOptions.some((o) => o.value === path),
  )

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>{pathLabel}</Label>
          {pathOptions ? (
            <select
              value={path ?? ''}
              onChange={(e) => onChange({ path: e.target.value || undefined })}
              className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
            >
              <option value="">Entire output</option>
              {pathOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                  {o.type ? ` · ${o.type}` : ''}
                </option>
              ))}
              {showsCustom ? (
                <option value={path}>{path} (custom)</option>
              ) : null}
            </select>
          ) : (
            <Input
              value={pathLocal}
              placeholder={pathPlaceholder}
              onChange={(e) => setPathLocal(e.target.value)}
              onBlur={() => {
                if (pathLocal !== pathRef.current) {
                  pathRef.current = pathLocal
                  onChange({ path: pathLocal || undefined })
                }
              }}
              className="font-mono text-xs"
            />
          )}
        </div>
        <div className="space-y-1">
          <Label>Match</Label>
          <select
            value={match}
            onChange={(e) => onChange({ match: e.target.value as EvalMatch })}
            className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
          >
            {MATCH_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Value</Label>
          <Input
            value={valueLocal}
            placeholder="expected"
            onChange={(e) => setValueLocal(e.target.value)}
            onBlur={() => {
              if (valueLocal !== valueRef.current) {
                valueRef.current = valueLocal
                onChange({ value: parseValue(valueLocal) })
              }
            }}
            className="font-mono text-xs"
          />
        </div>
      </div>
      {selectedField?.description ? (
        <p className="text-xs text-neutral-400">{selectedField.description}</p>
      ) : null}
    </div>
  )
}
