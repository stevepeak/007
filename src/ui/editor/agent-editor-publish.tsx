import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useWfClient, useWfComponents } from '../context'
import { Modal } from '../modal'

// Publish flow — warns how many workflows reference this agent (they float to
// the latest published version and update immediately).
export function PublishAgentDialog({
  agentId,
  publishing,
  error,
  onCancel,
  onConfirm,
}: {
  agentId: string
  publishing: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (changeNote: string) => void
}) {
  const { Button, Textarea } = useWfComponents()
  const client = useWfClient()
  const [note, setNote] = useState('')
  const [refCount, setRefCount] = useState<number | null>(null)

  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void client
      .countAgentReferences(agentId)
      .then((r) => setRefCount(r.workflows))
      .catch(() => setRefCount(0))
  }, [client, agentId])

  return (
    <Modal
      open
      onClose={onCancel}
      panelClassName="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-xl"
    >
      <h2 className="mb-1 text-base font-semibold text-neutral-900">
        Publish new version
      </h2>
      <p className="mb-3 text-sm text-neutral-500">
        Publishing makes this the live version. Add an optional note
        describing the change — it's saved with the version.
      </p>

      {refCount != null && refCount > 0 ? (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>
              {refCount} workflow{refCount === 1 ? '' : 's'}
            </strong>{' '}
            reference this agent and will use the new version immediately.
          </span>
        </div>
      ) : null}

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder="Describe the changes in this version…"
        className="w-full"
      />

      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => onConfirm(note)}
          disabled={publishing}
        >
          {publishing ? 'Publishing…' : 'Publish version'}
        </Button>
      </div>
    </Modal>
  )
}
