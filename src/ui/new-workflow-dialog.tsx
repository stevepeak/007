import { CalendarClock, Hand, Webhook } from 'lucide-react'
import { useState } from 'react'

import { buildStarterGraph, type NewWorkflowTrigger } from '../engine/graph'
import { cn } from './cn'
import { useWfComponents } from './context'
import { useCreateWorkflow, useTriggerEvents } from './hooks'
import { Modal } from './modal'

// Create-workflow flow. A workflow can't exist without knowing how it starts, so
// creation is a small dialog: name it, then choose one of three trigger modes —
//   • Manually   — a person starts each run.
//   • On a schedule — a cron expression starts it (built-in).
//   • On an event  — one of the host's declared events (with its data payload).
// The chosen mode seeds a minimal trigger→output graph; the editor takes over.

export type NewWorkflowDialogProps = {
  open: boolean
  onClose: () => void
  /** Called with the new workflow id once it's created (host routes to /edit). */
  onCreated: (workflowId: string) => void
}

type Mode = NewWorkflowTrigger['mode']

const MODES: { mode: Mode; label: string; hint: string; icon: typeof Hand }[] =
  [
    {
      mode: 'manual',
      label: 'Manually',
      hint: 'A person starts each run.',
      icon: Hand,
    },
    {
      mode: 'periodic',
      label: 'On a schedule',
      hint: 'A cron schedule starts it automatically.',
      icon: CalendarClock,
    },
    {
      mode: 'event',
      label: 'On an event',
      hint: 'A system event starts it, with its data.',
      icon: Webhook,
    },
  ]

export function NewWorkflowDialog({
  open,
  onClose,
  onCreated,
}: NewWorkflowDialogProps) {
  const { Button, Input, Label } = useWfComponents()
  const create = useCreateWorkflow()
  const events = useTriggerEvents()

  const [name, setName] = useState('Untitled workflow')
  const [mode, setMode] = useState<Mode>('manual')
  const [cron, setCron] = useState('0 9 * * *')
  const [eventKind, setEventKind] = useState<string>('')

  if (!open) return null

  const eventList = events.data ?? []
  const selectedEvent = eventList.find((e) => e.kind === eventKind)
  // Default the event selection to the first available once loaded.
  const resolvedEventKind = eventKind || eventList[0]?.kind || ''
  const resolvedEvent =
    selectedEvent ?? eventList.find((e) => e.kind === resolvedEventKind)

  const canSubmit =
    name.trim().length > 0 &&
    (mode === 'manual' ||
      (mode === 'periodic' && cron.trim().length > 0) ||
      (mode === 'event' && resolvedEventKind.length > 0)) &&
    !create.isPending

  function submit() {
    const trigger: NewWorkflowTrigger =
      mode === 'manual'
        ? { mode: 'manual' }
        : mode === 'periodic'
          ? { mode: 'periodic', cron: cron.trim() }
          : {
              mode: 'event',
              event: resolvedEventKind,
              eventLabel: resolvedEvent?.description,
            }

    create.mutate(
      { name: name.trim(), graph: buildStarterGraph(trigger) },
      { onSuccess: (r) => onCreated(r.workflowId) },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeOnEsc={false}
      title="New workflow"
      panelClassName="w-full max-w-lg rounded-lg border border-neutral-200 bg-white shadow-xl"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSubmit}>
            {create.isPending ? 'Creating…' : 'Create workflow'}
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
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) submit()
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label>How does it start?</Label>
            <div className="grid grid-cols-3 gap-2">
              {MODES.map((m) => {
                const Icon = m.icon
                const active = mode === m.mode
                return (
                  <button
                    key={m.mode}
                    type="button"
                    onClick={() => setMode(m.mode)}
                    className={cn(
                      'flex flex-col items-center gap-1.5 rounded-md border p-3 text-center transition',
                      active
                        ? 'border-neutral-900 bg-neutral-50'
                        : 'border-neutral-200 hover:bg-neutral-50',
                    )}
                  >
                    <Icon className="size-5 text-neutral-700" />
                    <span className="text-xs font-medium">{m.label}</span>
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-neutral-500">
              {MODES.find((m) => m.mode === mode)?.hint}
            </p>
          </div>

          {mode === 'periodic' ? (
            <div className="space-y-1">
              <Label>Cron schedule</Label>
              <Input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 9 * * *"
                className="font-mono"
              />
              <p className="text-xs text-neutral-500">
                Standard 5-field cron (minute hour day month weekday).
              </p>
            </div>
          ) : null}

          {mode === 'event' ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label>Event</Label>
                {events.isLoading ? (
                  <div className="text-xs text-neutral-500">
                    Loading events…
                  </div>
                ) : eventList.length === 0 ? (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
                    This host declares no events. Use a manual or scheduled
                    trigger instead.
                  </div>
                ) : (
                  <select
                    value={resolvedEventKind}
                    onChange={(e) => setEventKind(e.target.value)}
                    className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
                  >
                    {eventList.map((ev) => (
                      <option key={ev.kind} value={ev.kind}>
                        {ev.description}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {resolvedEvent && resolvedEvent.fields.length > 0 ? (
                <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
                  <div className="mb-1.5 text-[11px] font-medium tracking-wide text-neutral-500 uppercase">
                    Event data
                  </div>
                  <ul className="space-y-1">
                    {resolvedEvent.fields.map((f) => (
                      <li
                        key={f.name}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="font-mono text-neutral-800">
                          {f.name}
                          {f.optional ? (
                            <span className="text-neutral-400">?</span>
                          ) : null}
                        </span>
                        <span className="text-neutral-500">{f.type}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          {create.error ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {(create.error as Error).message}
            </div>
          ) : null}
        </div>
    </Modal>
  )
}
