import { X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useWfComponents } from '../context'
import { createGoal } from './mock-store'

// Create-goal dialog. A goal is a folder, so creation is trivial: name it,
// optionally describe it, and land on its page. (Mock store — no persistence.)

export type NewGoalDialogProps = {
  open: boolean
  onClose: () => void
  /** Called with the new goal id once created. */
  onCreated: (goalId: string) => void
}

export function NewGoalDialog({ open, onClose, onCreated }: NewGoalDialogProps) {
  const { Button, Input, Label, Textarea } = useWfComponents()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    if (!open) return
    setName('')
    setDescription('')
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const submit = () => {
    const id = createGoal({ name, description })
    onCreated(id)
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
                if (e.key === 'Enter' && name.trim()) submit()
              }}
            />
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
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!name.trim()} onClick={submit}>
            Create goal
          </Button>
        </div>
      </div>
    </div>
  )
}
