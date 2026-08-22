import { FlaskConical } from 'lucide-react'
import type { ReactNode } from 'react'

import type { AgentNode, WorkflowNode } from '../../engine'
import type { WfRunStepDTO } from '../../server/protocol'
import { useWfComponents } from '../context'
import { IdeaSpark } from '../idea-spark'
import { Modal } from '../modal'

import { NEW_GOAL, useCreateSampleForm } from './use-create-sample-form'

// "Create Sample" — turn a completed agent node's execution into an eval Sample
// (wf_eval_row) under a Goal (wf_eval_set) that targets that agent. Lives in the
// run viewer's Inspect header. v1 only captures the sample title + Given (its
// initial condition, reconstructed from the run); mock tools and checks are noted
// as ✨ follow-ons. On create it opens the new sample in a new tab.
//
// The component self-gates: it renders nothing unless the selected node is an
// agent pointer with a completed step, so the run page can mount it
// unconditionally.

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
  const { Button } = useWfComponents()
  const form = useCreateSampleForm({ agentNode, step, steps })

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => form.setOpen(true)}
        title={`Create an eval sample from ${form.agentName}'s run`}
      >
        <FlaskConical className="size-3.5" />
        Create Sample
      </Button>

      <Modal
        open={form.open}
        onClose={() => form.setOpen(false)}
        title="Create sample"
        panelClassName="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => form.setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!form.canSubmit}
              onClick={() => void form.submit()}
            >
              {form.pending ? 'Creating…' : 'Create sample'}
            </Button>
          </>
        }
      >
        <div className="space-y-4 px-5 py-4">
          <GoalField form={form} />

          <TitleField form={form} />

          <GivenPreview entries={form.givenEntries} />
          <FollowOnNotes />

          {form.error ? (
            <p className="text-xs text-red-600">{form.error}</p>
          ) : null}
        </div>
      </Modal>
    </>
  )
}

type Form = ReturnType<typeof useCreateSampleForm>

/** The sample tests this agent, so only goals aimed at it apply. */
function GoalField({ form }: { form: Form }) {
  const { Input, Label, Select } = useWfComponents()
  return (
    <div className="space-y-1">
      <Label>Goal</Label>
      {form.goals.length > 0 ? (
        <Select
          value={form.effectiveGoal}
          onChange={(e) => form.setGoalChoice(e.target.value)}
        >
          {form.goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
          <option value={NEW_GOAL}>＋ New goal…</option>
        </Select>
      ) : (
        <p className="text-xs text-neutral-400">
          No goals test{' '}
          <span className="font-medium text-neutral-500">{form.agentName}</span>{' '}
          yet — name a new one:
        </p>
      )}
      {form.creatingNewGoal ? (
        <Input
          autoFocus={form.goals.length === 0}
          value={form.newGoalName}
          placeholder="New goal name"
          onChange={(e) => form.setNewGoalName(e.target.value)}
        />
      ) : null}
      <p className="text-xs text-neutral-400">
        The agent this sample runs against — {form.agentName}.
      </p>
    </div>
  )
}

function TitleField({ form }: { form: Form }) {
  const { Input, Label } = useWfComponents()
  return (
    <div className="space-y-1">
      <Label>Sample title</Label>
      <Input
        value={form.title}
        placeholder="Untitled sample"
        onChange={(e) => form.setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && form.canSubmit) void form.submit()
        }}
      />
    </div>
  )
}

/** The Given, reconstructed from the execution — read-only. */
function GivenPreview({ entries }: { entries: [string, string][] }) {
  const { Label } = useWfComponents()
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label>Given</Label>
        <span className="text-[11px] uppercase tracking-wide text-neutral-400">
          captured from this run
        </span>
      </div>
      {entries.length > 0 ? (
        <dl className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
          {entries.map(([k, v]) => (
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
          Couldn&apos;t recover input values from this run — you can fill the
          Given in on the sample.
        </p>
      )}
    </div>
  )
}

/** ✨ Follow-ons: mocks + checks seeded from the run, later. */
function FollowOnNotes() {
  return (
    <div className="space-y-2 rounded-md bg-neutral-50 p-3">
      <SparkNote
        title="Auto-generate mock tools from this run"
        blurb="Mock tools, built from this run's tool calls"
      >
        <p>
          This run already recorded every tool call the agent made — the inputs
          it sent and the outputs it got back. We could turn those into{' '}
          <strong>mock tools</strong> (fixtures) on the sample, so it replays
          deterministically without hitting live tools.
        </p>
      </SparkNote>
      <SparkNote
        title="Auto-generate checks from this output"
        blurb="Checks, generated from the agent's output"
      >
        <p>
          The agent&apos;s output is the obvious oracle. We could propose{' '}
          <strong>checks</strong> from it automatically — binary assertions on
          what it produced plus a scored judge on the response — so the sample
          starts graded instead of empty.
        </p>
      </SparkNote>
    </div>
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
