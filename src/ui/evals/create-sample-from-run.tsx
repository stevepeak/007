import { FlaskConical } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { AgentNode, ArgBinding, WorkflowNode } from '../../engine'
import { resolvePath } from '../../engine/binding'
import type { EvalInitialCondition, WfRunStepDTO } from '../../server/protocol'
import { useWfComponents } from '../context'
import {
  useAgents,
  useCreateEvalSet,
  useEvalSets,
  useUpsertEvalRow,
} from '../hooks'
import { IdeaSpark } from '../idea-spark'
import { Modal } from '../modal'
import { useOpenAsset } from '../nav'

// "Create Sample" — turn a completed agent node's execution into an eval Sample
// (wf_eval_row) under a Goal (wf_eval_set) that targets that agent. Lives in the
// run viewer's Inspect header. v1 only captures the sample title + Given (its
// initial condition, reconstructed from the run); mock tools and tests are noted
// as ✨ follow-ons. On create it opens the new sample in a new tab.
//
// The component self-gates: it renders nothing unless the selected node is an
// agent pointer with a completed step, so the run page can mount it
// unconditionally.

const NEW_GOAL = '__new__'

export type CreateSampleFromRunProps = {
  /** The node selected on the run graph. */
  node: WorkflowNode
  /** The selected node's recorded step. */
  step: WfRunStepDTO | null
  /** Every recorded step in the run — used to resolve the node's ref inputs. */
  steps: WfRunStepDTO[]
}

export function CreateSampleFromRun({
  node,
  step,
  steps,
}: CreateSampleFromRunProps) {
  // Only agent nodes that actually ran (and point at a real agent) can seed a
  // sample. Gate before any hooks so the inner control owns them unconditionally.
  if (node.kind !== 'agent' || !node.config.agentId) return null
  if (!step || step.status !== 'completed') return null
  return <Control agentNode={node} step={step} steps={steps} />
}

function Control({
  agentNode,
  step,
  steps,
}: {
  agentNode: AgentNode
  step: WfRunStepDTO
  steps: WfRunStepDTO[]
}) {
  const { Button, Input, Label, Select } = useWfComponents()
  const openAsset = useOpenAsset()

  const agentId = agentNode.config.agentId
  const agentsQuery = useAgents()
  const agent = agentsQuery.data?.find((a) => a.id === agentId)
  const agentName = agent?.name ?? 'this agent'
  const inputVariables = agent?.inputVariables ?? []

  // Goals that already test this agent — the sample lands under one of them, or a
  // brand-new goal the author names here.
  const setsQuery = useEvalSets()
  const goals = useMemo(
    () =>
      (setsQuery.data ?? []).filter(
        (s) => s.targetKind === 'agent' && s.targetId === agentId,
      ),
    [setsQuery.data, agentId],
  )

  // The Given, reconstructed from what this node actually ran with.
  const given = useMemo(
    () => seedGiven(agentNode, step, steps, inputVariables),
    [agentNode, step, steps, inputVariables],
  )
  const givenEntries = Object.entries(given.promptVariables ?? {})

  const createSet = useCreateEvalSet()
  const upsertRow = useUpsertEvalRow()

  const [open, setOpen] = useState(false)
  // `null` = "auto" (follow the first existing goal); a string is the author's
  // explicit pick. Kept as auto until they choose, so goals loading in after the
  // dialog opens still default sensibly without clobbering a selection.
  const [goalChoice, setGoalChoice] = useState<string | null>(null)
  const [newGoalName, setNewGoalName] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Reset the form only on the open→true edge, so a background refetch (goals /
  // agents) while the dialog is open never clobbers in-progress edits.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true
      setGoalChoice(null)
      setNewGoalName(`${agentName} goal`)
      setTitle(deriveTitle(agentName, given, step))
      setError(null)
    } else if (!open) {
      wasOpen.current = false
    }
  }, [open, agentName, given, step])

  const effectiveGoal = goalChoice ?? goals[0]?.id ?? NEW_GOAL
  const creatingNewGoal = effectiveGoal === NEW_GOAL
  const pending = createSet.isPending || upsertRow.isPending
  const canSubmit =
    !pending && (!creatingNewGoal || !!newGoalName.trim())

  const submit = async () => {
    if (!canSubmit) return
    setError(null)
    try {
      let setId = effectiveGoal
      if (creatingNewGoal) {
        const res = await createSet.mutateAsync({
          name: newGoalName.trim(),
          targetKind: 'agent',
          targetId: agentId,
          targetVersion: agentNode.config.version ?? null,
          triggerKind: 'manual',
        })
        setId = res.setId
      }
      const { rowId } = await upsertRow.mutateAsync({
        setId,
        name: title.trim() || 'Untitled sample',
        initialCondition: given,
        checks: { op: 'and', checks: [] },
      })
      setOpen(false)
      // Open the fresh sample in its own tab so the run stays put behind it.
      openAsset(`evals/${setId}/samples/${rowId}`, { newTab: true })
    } catch {
      setError("Couldn't create the sample. Try again.")
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        title={`Create an eval sample from ${agentName}'s run`}
      >
        <FlaskConical className="size-3.5" />
        Create Sample
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create sample"
        panelClassName="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
              {pending ? 'Creating…' : 'Create sample'}
            </Button>
          </>
        }
      >
        <div className="space-y-4 px-5 py-4">
          {/* Goal — the sample tests this agent, so only goals aimed at it apply. */}
          <div className="space-y-1">
            <Label>Goal</Label>
            {goals.length > 0 ? (
              <Select
                value={effectiveGoal}
                onChange={(e) => setGoalChoice(e.target.value)}
              >
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
                <option value={NEW_GOAL}>＋ New goal…</option>
              </Select>
            ) : (
              <p className="text-xs text-neutral-400">
                No goals test{' '}
                <span className="font-medium text-neutral-500">
                  {agentName}
                </span>{' '}
                yet — name a new one:
              </p>
            )}
            {creatingNewGoal ? (
              <Input
                autoFocus={goals.length === 0}
                value={newGoalName}
                placeholder="New goal name"
                onChange={(e) => setNewGoalName(e.target.value)}
              />
            ) : null}
            <p className="text-xs text-neutral-400">
              The agent this sample runs against — {agentName}.
            </p>
          </div>

          {/* Title. */}
          <div className="space-y-1">
            <Label>Sample title</Label>
            <Input
              value={title}
              placeholder="Untitled sample"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void submit()
              }}
            />
          </div>

          {/* Given — reconstructed from the execution (read-only preview). */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label>Given</Label>
              <span className="text-[11px] uppercase tracking-wide text-neutral-400">
                captured from this run
              </span>
            </div>
            {givenEntries.length > 0 ? (
              <dl className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
                {givenEntries.map(([k, v]) => (
                  <div key={k} className="flex gap-2 px-2.5 py-1.5">
                    <dt
                      title={k}
                      className="w-32 shrink-0 truncate font-mono text-xs text-neutral-500"
                    >
                      {k}
                    </dt>
                    <dd className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-700">
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs text-neutral-400">
                Couldn&apos;t recover input values from this run — you can fill
                the Given in on the sample.
              </p>
            )}
          </div>

          {/* ✨ Follow-ons: mocks + tests seeded from the run, later. */}
          <div className="space-y-2 rounded-md bg-neutral-50 p-3">
            <SparkNote
              title="Auto-generate mock tools from this run"
              blurb="Mock tools, built from this run's tool calls"
            >
              <p>
                This run already recorded every tool call the agent made — the
                inputs it sent and the outputs it got back. We could turn those
                into <strong>mock tools</strong> (fixtures) on the sample, so it
                replays deterministically without hitting live tools.
              </p>
            </SparkNote>
            <SparkNote
              title="Auto-generate tests from this output"
              blurb="Tests, generated from the agent's output"
            >
              <p>
                The agent&apos;s output is the obvious oracle. We could propose{' '}
                <strong>tests</strong> from it automatically — binary assertions
                on what it produced plus a scored judge on the response — so the
                sample starts graded instead of empty.
              </p>
            </SparkNote>
          </div>

          {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
      </Modal>
    </>
  )
}

// A ✨ sparkle (the not-built-yet marker) paired with a one-line caption.
function SparkNote({
  title,
  blurb,
  children,
}: {
  title: string
  blurb: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <IdeaSpark title={title} hint={title} className="shrink-0">
        {children}
      </IdeaSpark>
      <span className="text-xs text-neutral-500">{blurb}</span>
    </div>
  )
}

// ── Given reconstruction ──────────────────────────────────────────────────────

// Rebuild the sample's initial condition from the node's execution. The Given
// the sample editor shows is `promptVariables`; we recover a value for each of
// the agent's declared `${vars}` from the node's input bindings resolved against
// the run's recorded outputs (a `literal` is its own value; a `ref` reads the
// referenced node's recorded output at the binding path), falling back to a
// matching field on the node's routed input. Vars supplied by run-level prompt
// variables (not bound on the node) aren't persisted per-step, so they stay
// blank for the author to fill. Free-form agents (no declared vars) capture the
// routed input's own fields. `triggerInput` preserves the routed input verbatim
// so the sample reproduces the same call.
function seedGiven(
  node: AgentNode,
  step: WfRunStepDTO,
  steps: WfRunStepDTO[],
  inputVariables: string[],
): EvalInitialCondition {
  const inputs = node.config.inputs ?? {}
  const promptVariables: Record<string, string> = {}

  const resolveBinding = (binding: ArgBinding): unknown => {
    if (binding.kind === 'literal') return binding.value
    const source = outputForNode(steps, step, binding.nodeId)
    return source === undefined ? undefined : resolvePath(source, binding.path)
  }

  for (const v of inputVariables) {
    const binding = inputs[v]
    let value = binding ? resolveBinding(binding) : undefined
    if (value === undefined) value = flatField(step.input, v)
    if (value !== undefined && value !== null) promptVariables[v] = asText(value)
  }

  // Free-form agent: no declared vars → surface the routed input's own fields so
  // the Given isn't empty.
  if (inputVariables.length === 0 && isPlainRecord(step.input)) {
    for (const [k, value] of Object.entries(step.input)) {
      if (value !== undefined && value !== null) promptVariables[k] = asText(value)
    }
  }

  return {
    triggerInput: isPlainRecord(step.input) ? step.input : undefined,
    promptVariables,
  }
}

// The recorded output for `nodeId`, preferring a sibling within the same
// iteration item when the selected step ran inside one, else the top-level step.
function outputForNode(
  steps: WfRunStepDTO[],
  step: WfRunStepDTO,
  nodeId: string,
): unknown {
  if (step.parentNodeId != null) {
    const sibling = steps.find(
      (s) =>
        s.nodeId === nodeId &&
        s.parentNodeId === step.parentNodeId &&
        s.itemIndex === step.itemIndex,
    )
    if (sibling) return sibling.output
  }
  return steps.find((s) => s.nodeId === nodeId && s.parentNodeId == null)?.output
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flatField(input: unknown, key: string): unknown {
  return isPlainRecord(input) ? input[key] : undefined
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

// A short, one-line title seeded from the run: the first captured Given value,
// else a glimpse of the routed input, else the agent's name.
function deriveTitle(
  agentName: string,
  given: EvalInitialCondition,
  step: WfRunStepDTO,
): string {
  const firstGiven = Object.values(given.promptVariables ?? {})[0]
  const raw =
    (typeof firstGiven === 'string' && firstGiven) ||
    previewInput(step.input) ||
    ''
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  if (!line) return `${agentName} sample`
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}

// Best-effort one-line glimpse of a routed input for the default title.
function previewInput(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (isPlainRecord(value)) {
    if (typeof value.text === 'string') return value.text
    const messages = value.messages
    if (Array.isArray(messages) && messages.length > 0) {
      const last = messages[messages.length - 1] as {
        content?: unknown
        parts?: Array<{ type?: string; text?: string }>
      }
      const part = last.parts?.find(
        (p) => p.type === 'text' && typeof p.text === 'string',
      )
      if (part?.text) return part.text
      if (typeof last.content === 'string') return last.content
    }
  }
  return JSON.stringify(value)
}
