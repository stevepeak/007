import { ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'

import type { ConnectorSummary } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { EmptyState } from '../evals/shared'
import { useConnectorCapability, useConnectors } from '../hooks-connectors'
import { useOpenAsset } from '../nav'
import { QueryState } from '../query-state'

import { ConnectorForm } from './connector-form'
import { ConnectionBadge, ConnectorIcon } from './status'

// The Connectors page (hub → Connectors).
//
// This is the INBOUND direction: remote MCP servers whose tools this deployment
// consumes. The outbound page — how Claude or Cursor points itself at us — is
// `../mcp`, and the two are deliberately named apart.
//
// The loop the page has to make obvious is: add a server → sign in to it →
// choose which of its tools agents may call. The third step is not a formality.
// A server ships write tools, and until a human enables one it does nothing.

export type ConnectorsListProps = {
  className?: string
  /** Set by the OAuth callback redirect: the connector that just connected. */
  connectedId?: string | null
  /** Set by the OAuth callback redirect when the round trip failed. */
  errorMessage?: string | null
}

export function ConnectorsList({
  className,
  connectedId,
  errorMessage,
}: ConnectorsListProps) {
  const { Button } = useWfComponents()
  const { data, isLoading, error } = useConnectors()
  const capability = useConnectorCapability()
  const [adding, setAdding] = useState(false)

  const configured = capability.data?.credentialsConfigured !== false

  return (
    <div className={cn('mx-auto max-w-4xl space-y-4 p-6', className)}>
      <header className="flex items-start justify-between gap-4">
        {/* `min-w-0` lets the prose column be the one that gives, so the button
            beside it keeps its natural width instead of being squeezed. */}
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-neutral-900">Connectors</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Sign in to an MCP server and its tools become available to your
            agents and Tool nodes — the same as any built-in tool.
          </p>
        </div>
        <Button
          onClick={() => setAdding((v) => !v)}
          variant="outline"
          className="shrink-0 whitespace-nowrap"
        >
          <Plus className="h-4 w-4 shrink-0" />
          Add connector
        </Button>
      </header>

      {errorMessage ? (
        <Notice tone="error">{errorMessage}</Notice>
      ) : connectedId ? (
        <Notice tone="ok">
          Connected. Choose which of its tools agents may call.
        </Notice>
      ) : null}

      {/*
        Said up front rather than at the moment somebody presses Connect: with no
        key there is nowhere to put a token, and finding that out three clicks
        into an OAuth round trip is a worse way to learn it.
      */}
      {capability.data && !configured ? (
        <Notice tone="warn">
          This deployment has no connector encryption key, so credentials can’t
          be stored. Wire <code className="font-mono">resolveConnectorSecret</code>{' '}
          (a <code className="font-mono">WF_CONNECTOR_KEY</code> secret) to
          enable connecting.
        </Notice>
      ) : null}

      {adding ? <ConnectorForm onDone={() => setAdding(false)} /> : null}

      <QueryState
        query={{ isLoading, error, data }}
        isEmpty={(rows) => (rows?.length ?? 0) === 0}
        empty={
          <EmptyState message="No connectors yet. Add one to bring an MCP server’s tools into your workflows." />
        }
      >
        {(rows) => (
          <div className="space-y-3">
            {rows.map((connector) => (
              <ConnectorCard key={connector.id} connector={connector} />
            ))}
          </div>
        )}
      </QueryState>
    </div>
  )
}

function Notice({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'error'
  children: React.ReactNode
}) {
  const styles = {
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    warn: 'border-amber-200 bg-amber-50 text-amber-800',
    error: 'border-red-200 bg-red-50 text-red-800',
  }[tone]
  return (
    <div className={cn('rounded-lg border px-3 py-2 text-sm', styles)}>
      {children}
    </div>
  )
}

/**
 * One row per connector, and the whole row is the way in.
 *
 * Nothing is operated from here on purpose: connect, refresh, edit, delete and
 * the tool toggles all live on the detail page, so there is exactly one place
 * to learn. The card only answers "what state is it in" and "how many of its
 * tools can agents use" — and clicking anywhere on it opens the answer.
 */
function ConnectorCard({ connector }: { connector: ConnectorSummary }) {
  const openAsset = useOpenAsset()

  const needsAttention =
    !!connector.connection && connector.connection.status !== 'connected'
  const noneEnabled =
    connector.toolCount > 0 && connector.enabledToolCount === 0

  return (
    <button
      type="button"
      onClick={() => openAsset(`connectors/${connector.id}`)}
      className={cn(
        'group flex w-full items-start gap-3 rounded-lg border bg-white p-4 text-left transition-colors hover:bg-neutral-50',
        needsAttention ? 'border-amber-300' : 'border-neutral-200',
        !connector.enabled && 'opacity-60',
      )}
    >
      <ConnectorIcon
        icon={connector.icon}
        iconUrl={connector.iconUrl}
        label={connector.label}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-neutral-900">
            {connector.label}
          </span>
          <ConnectionBadge connection={connector.connection} />
          {!connector.enabled ? (
            <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-500">
              Disabled
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-neutral-500">
          {connector.url}
        </p>
        {/*
          The tool count doubles as the call to action. "0 of 66" is the state
          every freshly-refreshed connector sits in, and it is the one that
          most needs a human to go do something — so it is coloured as a
          prompt, not reported as a fact.
        */}
        <p
          className={cn(
            'mt-1.5 text-xs',
            noneEnabled ? 'text-amber-700' : 'text-neutral-500',
          )}
        >
          {connector.toolCount === 0
            ? 'No tools discovered yet — open to refresh its catalog.'
            : noneEnabled
              ? `${connector.toolCount} tools discovered, none enabled yet — open to choose which agents may call.`
              : `${connector.enabledToolCount} of ${connector.toolCount} tools enabled`}
        </p>
        {connector.connection?.error ? (
          <p className="mt-1 text-xs text-amber-700">
            {connector.connection.error}
          </p>
        ) : null}
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 self-center text-xs text-neutral-500 group-hover:text-neutral-800">
        Manage
        <ChevronRight className="h-4 w-4" />
      </span>
    </button>
  )
}
