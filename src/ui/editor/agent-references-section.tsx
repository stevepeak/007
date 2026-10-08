import { Link2 } from 'lucide-react'

import type { AgentConfig } from '../../engine'
import type { ToolOption } from '../../server/protocol-tools'
import { useWfComponents } from '../context'
import { useReferenceKinds } from '../hooks-tools'

import { EditorSection } from './editor-section'

// Inline references — which of the host's reference kinds this agent writes into
// its answer. The author only picks kinds: the grammar, and what the model is
// told about each kind, come from the host and are appended to the system prompt
// at run time (see `@stevepeak/007/references`).
//
// Hidden entirely when the host declares no kinds. Shown but inert for a
// non-text agent, because a reference is a link inside prose.
export function AgentReferencesSection({
  config,
  patch,
  aiTools,
}: {
  config: AgentConfig
  patch: (next: Partial<AgentConfig>) => void
  aiTools: ToolOption[]
}) {
  const { Checkbox } = useWfComponents()
  const kinds = useReferenceKinds()
  const catalog = kinds.data ?? []
  if (catalog.length === 0) return null

  const textOutput = config.output.kind === 'text'
  const enabled = new Set(config.referenceKinds)
  // A kind the agent has selected that the host no longer declares would make
  // every run throw — say so instead of hiding it.
  const unknown = config.referenceKinds.filter(
    (id) => !catalog.some((k) => k.id === id),
  )

  function toggle(id: string, on: boolean) {
    patch({
      referenceKinds: on
        ? [...config.referenceKinds.filter((k) => k !== id), id]
        : config.referenceKinds.filter((k) => k !== id),
    })
  }

  return (
    <EditorSection
      icon={Link2}
      title="References"
      description="Clickable links to sources, written inline in the answer."
      collapsible
      defaultCollapsed={config.referenceKinds.length === 0}
      badge={
        !textOutput ? (
          <span className="text-xs text-neutral-400">Text output only</span>
        ) : config.referenceKinds.length > 0 ? (
          <span className="text-xs text-neutral-400">
            {config.referenceKinds.length} on
          </span>
        ) : null
      }
    >
      <div
        className={
          textOutput ? 'space-y-3' : 'pointer-events-none space-y-3 opacity-60'
        }
      >
        {catalog.map((kind) => {
          const feeders = aiTools.filter((t) => {
            return (
              t.produces?.includes(kind.id) && config.toolIds.includes(t.id)
            )
          })
          const suggested = feeders.length > 0 && !enabled.has(kind.id)
          return (
            <label
              key={kind.id}
              className="flex cursor-pointer items-start gap-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="text-foreground block text-sm font-medium">
                  {kind.label}
                </span>
                <span className="mt-0.5 block text-xs text-neutral-400">
                  {kind.description}
                  {feeders.length > 0
                    ? ` Ids come from ${feeders.map((t) => t.name).join(', ')}.`
                    : ''}
                </span>
                {suggested ? (
                  <span className="mt-1 block text-xs text-sky-700">
                    An attached tool hands out these ids — turn this on so the
                    agent links to what it used.
                  </span>
                ) : null}
              </span>
              <Checkbox
                className="mt-0.5"
                checked={enabled.has(kind.id)}
                disabled={!textOutput}
                onChange={(e) => toggle(kind.id, e.target.checked)}
              />
            </label>
          )
        })}
        {unknown.length > 0 ? (
          <p className="text-xs text-amber-600">
            {unknown.map((id) => `'${id}'`).join(', ')}{' '}
            {unknown.length === 1 ? 'is' : 'are'} no longer declared by this
            deployment — runs will fail until{' '}
            {unknown.length === 1 ? 'it is' : 'they are'} removed.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => {
                patch({
                  referenceKinds: config.referenceKinds.filter(
                    (id) => !unknown.includes(id),
                  ),
                })
              }}
            >
              Remove
            </button>
          </p>
        ) : null}
      </div>
    </EditorSection>
  )
}
