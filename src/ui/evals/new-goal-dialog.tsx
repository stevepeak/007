import { useEffect, useState } from 'react'

import { AgentSelect, type AgentSelectValue } from '../agent-select'
import { useWfComponents } from '../context'
import { useAgents, useCreateEvalSet } from '../hooks'
import { IdeaSpark } from '../idea-spark'
import { Modal } from '../modal'

// Create-goal dialog. A goal (wf_eval_set) carries the target — the agent it
// runs its samples against — so creation collects a name, an optional
// description, and the target agent (agent-only for now; workflow targets are a
// follow-on). On submit it persists via useCreateEvalSet and lands on the goal.

export type NewGoalDialogProps = {
  open: boolean
  onClose: () => void
  /** Called with the new goal (set) id once created. */
  onCreated: (goalId: string) => void
}

export function NewGoalDialog({ open, onClose, onCreated }: NewGoalDialogProps) {
  const { Button, Input, Label, Textarea } = useWfComponents()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [target, setTarget] = useState<AgentSelectValue>({
    agentId: '',
    version: null,
  })

  const agentsQuery = useAgents()
  const agents = agentsQuery.data ?? []
  const createSet = useCreateEvalSet()

  useEffect(() => {
    if (!open) return
    setName('')
    setDescription('')
    setTarget({ agentId: '', version: null })
  }, [open])

  if (!open) return null

  const canSubmit = !!name.trim() && !!target.agentId && !createSet.isPending

  const submit = async () => {
    if (!canSubmit) return
    const res = await createSet.mutateAsync({
      name: name.trim(),
      description: description.trim() || undefined,
      targetKind: 'agent',
      targetId: target.agentId,
      targetVersion: target.version,
      triggerKind: 'manual',
    })
    onCreated(res.setId)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New goal"
      panelClassName="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
            {createSet.isPending ? 'Creating…' : 'Create goal'}
          </Button>
        </>
      }
    >
        <div className="space-y-4 px-5 py-4">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input
              autoFocus
              value={name}
              placeholder="e.g. Escalation Policy"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void submit()
              }}
            />
          </div>
          <div className="space-y-1">
            <Label>Target agent</Label>
            <AgentSelect
              agents={agents}
              value={target}
              onChange={setTarget}
              placeholder={
                agentsQuery.isLoading ? 'Loading agents…' : 'Select an agent…'
              }
            />
            {!agentsQuery.isLoading && agents.length === 0 ? (
              <p className="text-xs text-amber-600">
                No agents yet — create one first.
              </p>
            ) : (
              <p className="text-xs text-neutral-400">
                The agent this goal&apos;s samples run against —{' '}
                {target.version == null
                  ? 'floats to the latest published version.'
                  : `pinned to v${target.version}.`}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <Label>Description</Label>
              <IdeaSpark
                title="Let AI seed samples & tests from the description"
                hint="Idea: generate sample data + tests from this description"
              >
                <p>
                  What if this description did more than document intent? On
                  create, AI could read it and propose a starter kit for the
                  goal:
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    a handful of realistic <strong>sample scenarios</strong>{' '}
                    (the “Given” inputs) that match the outcome described
                  </li>
                  <li>
                    candidate <strong>tests</strong> — the binary assertions and
                    scored judges that would prove the goal holds
                  </li>
                </ul>
                <p>
                  Suggestions only — you accept, edit, or discard each one — so a
                  blank goal starts warm instead of empty.
                </p>
              </IdeaSpark>
            </div>
            <Textarea
              rows={2}
              value={description}
              placeholder="What outcome does this goal guarantee?"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {createSet.isError ? (
            <p className="text-xs text-red-600">
              Couldn&apos;t create the goal. Try again.
            </p>
          ) : null}
        </div>
    </Modal>
  )
}
