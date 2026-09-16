import { AlertTriangle, Plug, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import type { ConnectorSummary } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { EmptyState } from '../evals/shared'
import {
  useConnectorCapability,
  useConnectors,
  useDisconnectConnector,
  useRefreshConnector,
  useSaveConnector,
  useStartConnectorAuth,
} from '../hooks-connectors'
import { useOpenAsset } from '../nav'
import { QueryState } from '../query-state'

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

      {adding ? (
        <AddConnectorForm onDone={() => setAdding(false)} />
      ) : null}

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
              <ConnectorCard
                key={connector.id}
                connector={connector}
                canConnect={configured}
              />
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

function ConnectorCard({
  connector,
  canConnect,
}: {
  connector: ConnectorSummary
  canConnect: boolean
}) {
  const { Button } = useWfComponents()
  const openAsset = useOpenAsset()
  const startAuth = useStartConnectorAuth()
  const disconnect = useDisconnectConnector()
  const refresh = useRefreshConnector()

  const connected = connector.connection?.status === 'connected'
  const needsAttention =
    !!connector.connection && connector.connection.status !== 'connected'

  const connect = () => {
    startAuth.mutate(
      { connectorId: connector.id, returnTo: `/wf/connectors` },
      {
        onSuccess: ({ authorizationUrl }) => {
          // A full-page navigation, not a popup: this is a round trip through
          // somebody else's login screen and it ends at our callback route.
          window.location.href = authorizationUrl
        },
      },
    )
  }

  return (
    <div
      className={cn(
        'rounded-lg border bg-white p-4',
        needsAttention ? 'border-amber-300' : 'border-neutral-200',
        !connector.enabled && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-3">
        <ConnectorIcon icon={connector.icon} label={connector.label} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="text-sm font-semibold text-neutral-900 hover:underline"
              onClick={() => openAsset(`connectors/${connector.id}`)}
            >
              {connector.label}
            </button>
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
          <p className="mt-1.5 text-xs text-neutral-500">
            {connector.toolCount === 0
              ? 'No tools discovered yet — refresh to pull its catalog.'
              : `${connector.enabledToolCount} of ${connector.toolCount} tools enabled`}
          </p>
          {connector.connection?.error ? (
            <p className="mt-1 text-xs text-amber-700">
              {connector.connection.error}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {connected ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => disconnect.mutate({ connectorId: connector.id })}
              disabled={disconnect.isPending}
            >
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={connect}
              disabled={!canConnect || startAuth.isPending}
              title={
                canConnect
                  ? undefined
                  : 'No connector encryption key is configured'
              }
            >
              <Plug className="h-3.5 w-3.5" />
              {needsAttention ? 'Reconnect' : 'Connect'}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => refresh.mutate({ connectorId: connector.id })}
            disabled={refresh.isPending}
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', refresh.isPending && 'animate-spin')}
            />
            Refresh
          </Button>
        </div>
      </div>
      {startAuth.error ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {(startAuth.error).message}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Adding a connector.
 *
 * The id is asked for separately from the label and described as permanent,
 * because it is: it becomes part of every one of this server's tool ids, which
 * get frozen into published agent configs. Renaming later is a delete and a
 * re-create, so it is worth one sentence here.
 */
function AddConnectorForm({ onDone }: { onDone: () => void }) {
  const { Button, Input, Label, Select } = useWfComponents()
  const save = useSaveConnector()
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [authKind, setAuthKind] = useState<'oauth2' | 'bearer' | 'none'>(
    'oauth2',
  )
  const [scopes, setScopes] = useState('')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    save.mutate(
      {
        id: id.trim(),
        label: label.trim(),
        url: url.trim(),
        authKind,
        scopes: scopes.trim() || null,
      },
      { onSuccess: onDone },
    )
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="wf-connector-label">Name</Label>
          <Input
            id="wf-connector-label"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value)
              // Offer a slug, but let it be overridden — it is permanent.
              if (!id || id === slugify(label)) setId(slugify(e.target.value))
            }}
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="wf-connector-id">Id</Label>
          <Input
            id="wf-connector-id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            required
          />
          <p className="text-xs text-neutral-500">
            Permanent — it becomes part of every tool id from this server.
          </p>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="wf-connector-url">Server URL</Label>
        <Input
          id="wf-connector-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="wf-connector-auth">Authentication</Label>
          <Select
            id="wf-connector-auth"
            value={authKind}
            onChange={(e) => { return setAuthKind(e.target.value as 'oauth2' | 'bearer' | 'none') }
            }
          >
            <option value="oauth2">Sign in with OAuth</option>
            <option value="bearer">API token</option>
            <option value="none">No authentication</option>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="wf-connector-scopes">Scopes (optional)</Label>
          <Input
            id="wf-connector-scopes"
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
          />
          <p className="text-xs text-neutral-500">
            Narrowing scopes is the strongest control there is — a token issued
            for <code className="font-mono">read</code> can’t reach a write API.
          </p>
        </div>
      </div>
      {save.error ? (
        <p className="text-xs text-red-600">{(save.error).message}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          Add connector
        </Button>
      </div>
    </form>
  )
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63)
}
