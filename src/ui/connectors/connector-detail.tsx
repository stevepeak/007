import { ChevronDown, ChevronRight, Pencil, Plug, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { ConnectorToolInfo } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { DataView } from '../data-view'
import { EmptyState } from '../evals/shared'
import { Tabs } from '../filters'
import {
  useConnector,
  useDisconnectConnector,
  useRefreshConnector,
  useSaveConnectorToken,
  useSetConnectorEnabled,
  useSetConnectorToolEnabled,
  useSetConnectorToolSideEffect,
  useStartConnectorAuth,
} from '../hooks-connectors'
import { useWfNav } from '../nav'
import { QueryState } from '../query-state'

import { ConnectorForm } from './connector-form'
import { DeleteConnectorButton } from './delete-connector-button'
import { ConnectionBadge, ConnectorIcon } from './status'

// One connector: its connection, and the catalog of tools it advertises.
//
// The tool table is the point of the page. Everything a server advertises
// arrives DISABLED, and enabling one is the moment a third party's code becomes
// callable by an agent — so the row shows what it does, what it takes, and
// whether it writes, before the toggle.

type ToolFilter = 'all' | 'enabled' | 'available'

export type ConnectorDetailProps = {
  connectorId: string
  className?: string
}

export function ConnectorDetail({
  connectorId,
  className,
}: ConnectorDetailProps) {
  const { data, isLoading, error } = useConnector(connectorId)
  const [filter, setFilter] = useState<ToolFilter>('all')
  const [query, setQuery] = useState('')

  const tools = useMemo(() => {
    const all = data?.tools ?? []
    const q = query.trim().toLowerCase()
    return all.filter((t) => {
      if (filter === 'enabled' && !t.enabled) return false
      if (filter === 'available' && t.enabled) return false
      if (!q) return true
      return (
        t.toolName.toLowerCase().includes(q) ||
        (t.title ?? '').toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q)
      )
    })
  }, [data?.tools, filter, query])

  return (
    <div className={cn('mx-auto max-w-4xl space-y-4 p-6', className)}>
      <QueryState query={{ isLoading, error, data }}>
        {(detail) => (
          <>
            <ConnectorHeader detail={detail} />
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-neutral-900">
                  Tools
                </h2>
                <div className="flex items-center gap-2">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search tools"
                    // A raw input, not the injected one: the injected primitive
                    // can't be resized by className (there is no tailwind-merge
                    // in this UI), and a full-height field here would tower over
                    // the filter tabs beside it.
                    className="h-8 w-48 rounded-md border border-neutral-300 px-2 text-sm outline-none focus:border-neutral-400"
                  />
                  <Tabs
                    active={filter}
                    onChange={(v) => setFilter(v as ToolFilter)}
                    tabs={[
                      { key: 'all', label: 'All', count: detail.tools.length },
                      {
                        key: 'enabled',
                        label: 'Enabled',
                        count: detail.tools.filter((t) => t.enabled).length,
                      },
                      { key: 'available', label: 'Available' },
                    ]}
                  />
                </div>
              </div>
              {detail.tools.length === 0 ? (
                <EmptyState message="No tools discovered yet. Refresh to pull this server’s catalog." />
              ) : tools.length === 0 ? (
                <EmptyState message="No tools match that filter." />
              ) : (
                <div className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 bg-white">
                  {tools.map((tool) => (
                    <ToolRow key={tool.id} tool={tool} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </QueryState>
    </div>
  )
}

function ConnectorHeader({
  detail,
}: {
  detail: NonNullable<ReturnType<typeof useConnector>['data']>
}) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const connector = detail.connector
  const refresh = useRefreshConnector()
  const startAuth = useStartConnectorAuth()
  const disconnect = useDisconnectConnector()
  const setEnabled = useSetConnectorEnabled()
  const [editing, setEditing] = useState(false)

  const connected = connector.connection?.status === 'connected'

  return (
    <header className="space-y-3">
      <div className="flex items-start gap-3">
        <ConnectorIcon
          icon={connector.icon}
          iconUrl={connector.iconUrl}
          label={connector.label}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-neutral-900">
              {connector.label}
            </h1>
            <ConnectionBadge connection={connector.connection} />
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-neutral-500">
            {connector.url}
          </p>
          {connector.connection?.scopes ? (
            <p className="mt-1 text-xs text-neutral-500">
              Granted scopes:{' '}
              <code className="font-mono">{connector.connection.scopes}</code>
            </p>
          ) : null}
          {connector.note ? (
            <p className="mt-1 text-xs text-neutral-500">{connector.note}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <DeleteConnectorButton
            connector={connector}
            onDeleted={() => navigate('connectors')}
          />
        </div>
      </div>

      {editing ? (
        <ConnectorForm connector={connector} onDone={() => setEditing(false)} />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {connected ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => disconnect.mutate({ connectorId: connector.id })}
            disabled={disconnect.isPending}
          >
            Disconnect
          </Button>
        ) : connector.authKind === 'oauth2' ? (
          <Button
            size="sm"
            onClick={() => { return startAuth.mutate(
                {
                  connectorId: connector.id,
                  returnTo: `/wf/connectors/${connector.id}`,
                },
                {
                  onSuccess: ({ authorizationUrl }) => {
                    window.location.href = authorizationUrl
                  },
                },
              ) }
            }
            disabled={startAuth.isPending}
          >
            <Plug className="h-3.5 w-3.5" />
            Connect
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => refresh.mutate({ connectorId: connector.id })}
          disabled={refresh.isPending}
        >
          <RefreshCw
            className={cn('h-3.5 w-3.5', refresh.isPending && 'animate-spin')}
          />
          Refresh catalog
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { return setEnabled.mutate({
              connectorId: connector.id,
              enabled: !connector.enabled,
            }) }
          }
          disabled={setEnabled.isPending}
        >
          {connector.enabled ? 'Disable connector' : 'Enable connector'}
        </Button>
      </div>

      {connector.authKind === 'bearer' && !connected ? (
        <TokenForm connectorId={connector.id} />
      ) : null}

      {refresh.data ? (
        <p className="text-xs text-neutral-500">
          {refresh.data.added} new, {refresh.data.updated} updated,{' '}
          {refresh.data.missing} withdrawn
          {refresh.data.drifted.length > 0
            ? `, ${refresh.data.drifted.length} schema change(s)`
            : ''}
          .
        </p>
      ) : null}
      {refresh.error ? (
        <p className="text-xs text-red-600">
          {(refresh.error).message}
        </p>
      ) : null}
    </header>
  )
}

/** Pasting an API key, for servers that take one instead of doing OAuth. */
function TokenForm({ connectorId }: { connectorId: string }) {
  const { Button, Input } = useWfComponents()
  const save = useSaveConnectorToken()
  const [token, setToken] = useState('')
  return (
    <form
      className="flex items-end gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(
          { connectorId, token: token.trim() },
          { onSuccess: () => setToken('') },
        )
      }}
    >
      <div className="flex-1 space-y-1">
        <label className="text-xs font-medium text-neutral-700">
          API token
        </label>
        <Input
          type="password"
          value={token}
          placeholder="Paste a personal API key"
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={!token.trim() || save.isPending}>
        Save token
      </Button>
    </form>
  )
}

function ToolRow({ tool }: { tool: ConnectorToolInfo }) {
  const setEnabled = useSetConnectorToolEnabled()
  const setSideEffect = useSetConnectorToolSideEffect()
  const [open, setOpen] = useState(false)

  const withdrawn = tool.missingSince !== null

  return (
    <div className={cn('p-3', withdrawn && 'bg-neutral-50')}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          className="mt-0.5 text-neutral-400 hover:text-neutral-600"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Hide schema' : 'Show schema'}
        >
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-neutral-900">
              {tool.toolName}
            </span>
            {tool.sideEffect === 'write' ? (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                writes
              </span>
            ) : (
              <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-600">
                read-only
              </span>
            )}
            {withdrawn ? (
              <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs text-red-700">
                withdrawn by the server
              </span>
            ) : null}
          </div>
          {/*
            The server's own description — third-party text that will be read by
            a model once this tool is enabled. Rendered as plain text, never as
            markup.
          */}
          {tool.description ? (
            <p className="mt-1 text-sm text-neutral-600">{tool.description}</p>
          ) : null}
          {open ? (
            <div className="mt-2 space-y-2">
              <div>
                <p className="mb-1 text-xs font-medium text-neutral-500">
                  Input schema
                </p>
                <DataView value={tool.inputSchema ?? null} />
              </div>
              {tool.outputSchema ? (
                <div>
                  <p className="mb-1 text-xs font-medium text-neutral-500">
                    Output schema
                  </p>
                  <DataView value={tool.outputSchema} />
                </div>
              ) : null}
              <p className="font-mono text-[11px] text-neutral-400">
                {tool.id}
              </p>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            Raw controls rather than the injected primitives: these sit inside a
            dense table row, and the injected Select/Checkbox can't be resized by
            className in this UI.
          */}
          <select
            value={tool.sideEffect}
            onChange={(e) => { return setSideEffect.mutate({
                toolId: tool.id,
                sideEffect: e.target.value as 'read' | 'write',
              }) }
            }
            className="h-7 rounded-md border border-neutral-300 bg-white px-1.5 text-xs outline-none"
            title={
              tool.sideEffectOverridden
                ? 'Set by hand — a refresh will not revert it'
                : 'Derived from the server’s annotations'
            }
          >
            <option value="read">read</option>
            <option value="write">write</option>
          </select>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-neutral-600">
            <input
              type="checkbox"
              checked={tool.enabled}
              disabled={withdrawn || setEnabled.isPending}
              onChange={(e) => { return setEnabled.mutate({
                  toolId: tool.id,
                  enabled: e.target.checked,
                }) }
              }
              className="h-3.5 w-3.5"
            />
            Enabled
          </label>
        </div>
      </div>
    </div>
  )
}
