import { useEffect, useState } from 'react'

import { AgentSelect, type AgentSelectValue } from '../agent-select'
import { useWfComponents } from '../context'
import { useAgents, useCreateEvalSet, useEvalSets } from '../hooks'
import { IdeaSpark } from '../idea-spark'
import { Modal } from '../modal'

// Create-goal dialog. A goal (wf_eval_set) exists to grade ONE target, so
// choosing that target is the only decision worth blocking creation on — pick
// the agent and you land in the goal, ready to add samples.
//
// The name and description used to be asked for here. They aren't anymore: both
// are editable in place on the goal itself, so demanding them upfront made an
// author name a thing they hadn't built yet. The name is seeded from the agent
// (deduped, so a second goal for the same agent doesn't collide) and renamed
// whenever the author has something better to call it.

export type NewGoalDialogProps = {
  open: boolean
  onClose: () => void
  /** Called with the new goal (set) id once created. */
  onCreated: (goalId: string) => void
}

export function NewGoalDialog({ open, onClose, onCreated }: NewGoalDialogProps) {
  const { Button, Label } = useWfComponents()
  const [target, setTarget] = useState<AgentSelectValue>({
    agentId: '',
    version: null,
  })

  const agentsQuery = useAgents()
  const agents = agentsQuery.data ?? []
  const setsQuery = useEvalSets()
  const createSet = useCreateEvalSet()

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the form each time the dialog opens
    setTarget({ agentId: '', version: null })
  }, [open])

  if (!open) return null

  const agent = agents.find((a) => a.id === target.agentId)
  const canSubmit = !!target.agentId && !createSet.isPending

  const submit = async () => {
    if (!canSubmit || !agent) return
    const res = await createSet.mutateAsync({
      name: uniqueGoalName(
        agent.name,
        (setsQuery.data ?? []).map((s) => s.name),
      ),
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
          <div className="flex items-center gap-1.5">
            <Label>Agent to test</Label>
            <IdeaSpark
              title="Let AI seed samples & checks from the agent"
              hint="Idea: generate sample data + checks from the agent itself"
            >
              <p>
                The agent already describes what it&apos;s for — its prompt, its
                declared inputs, its tools. On create, AI could read that and
                propose a starter kit for the goal:
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  a handful of realistic <strong>samples</strong> whose inputs
                  match the variables the agent actually declares
                </li>
                <li>
                  candidate <strong>checks</strong> — the binary assertions and
                  scored judges that would prove the agent does its job
                </li>
              </ul>
              <p>
                Suggestions only — you accept, edit, or discard each one — so a
                blank goal starts warm instead of empty.
              </p>
            </IdeaSpark>
          </div>
          <AgentSelect
            agents={agents}
            value={target}
            onChange={setTarget}
            placeholder={
              agentsQuery.isLoading ? 'Loading agents…' : 'Select an agent…'
            }
          />
          {/* Not a QueryState ladder: the non-empty branch is also what renders
              WHILE loading, so sequencing it would just duplicate the hint. */}
          {!agentsQuery.isLoading && agents.length === 0 ? (
            <p className="text-xs text-amber-600">
              No agents yet — create one first.
            </p>
          ) : (
            <p className="text-xs text-neutral-400">
              Every sample in this goal runs against this agent —{' '}
              {target.version == null
                ? 'floating to its latest published version.'
                : `pinned to v${target.version}.`}{' '}
              You can rename the goal once it exists.
            </p>
          )}
          {createSet.isError ? (
            <p className="text-xs text-red-600">
              Couldn&apos;t create the goal. Try again.
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}

/**
 * A starting name for a goal, seeded from the agent it grades. Suffixed when
 * that name is already taken, so testing one agent from two angles doesn't
 * produce two identically-named goals in the list.
 */
export function uniqueGoalName(agentName: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()))
  const base = agentName.trim() || 'Untitled goal'
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 100; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return base
}
