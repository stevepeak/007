import { X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useWfComponents } from '../context'
import { useAgents, useCreateEvalSet } from '../hooks'

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
  const [agentId, setAgentId] = useState('')

  const agentsQuery = useAgents()
  const agents = agentsQuery.data ?? []
  const createSet = useCreateEvalSet()

  useEffect(() => {
    if (!open) return
    setName('')
    setDescription('')
    setAgentId('')
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const canSubmit = !!name.trim() && !!agentId && !createSet.isPending

  const submit = async () => {
    if (!canSubmit) return
    const res = await createSet.mutateAsync({
      name: name.trim(),
      description: description.trim() || undefined,
      targetKind: 'agent',
      targetId: agentId,
      triggerKind: 'manual',
    })
    onCreated(res.setId)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <h2 className="text-sm font-semibold">New goal</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="text-neutral-400 transition hover:text-neutral-700"
          >
            <X className="size-4" />
          </button>
        </div>

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
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
            >
              <option value="">
                {agentsQuery.isLoading ? 'Loading agents…' : 'Select an agent…'}
              </option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {!agentsQuery.isLoading && agents.length === 0 ? (
              <p className="text-xs text-amber-600">
                No agents yet — create one first.
              </p>
            ) : (
              <p className="text-xs text-neutral-400">
                The agent this goal&apos;s samples run against (floats to latest).
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
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

        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
            {createSet.isPending ? 'Creating…' : 'Create goal'}
          </Button>
        </div>
      </div>
    </div>
  )
}
