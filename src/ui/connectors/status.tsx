import { AlertTriangle, CheckCircle2, CircleSlash, Clock } from 'lucide-react'
import type { ReactNode } from 'react'

import type { ConnectorConnectionInfo } from '../../server/protocol'
import { cn } from '../cn'

// How a connection's state reads at a glance.
//
// Four states, and the distinction that matters is between the two a person can
// act on and the two they cannot: `expired` and `error` come with a button
// (Reconnect), `connected` and "never connected" do not. The copy says what to
// do, not merely what happened — a status line that only reports is a status
// line somebody has to interpret.

export type ConnectionTone = 'connected' | 'expired' | 'error' | 'absent'

export function connectionTone(
  connection: ConnectorConnectionInfo | null,
): ConnectionTone {
  if (!connection) return 'absent'
  if (connection.status === 'connected') return 'connected'
  if (connection.status === 'expired') return 'expired'
  return 'error'
}

const TONE_STYLES: Record<ConnectionTone, string> = {
  connected: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  expired: 'bg-amber-50 text-amber-700 border-amber-200',
  error: 'bg-red-50 text-red-700 border-red-200',
  absent: 'bg-neutral-50 text-neutral-500 border-neutral-200',
}

const TONE_ICONS: Record<ConnectionTone, ReactNode> = {
  connected: <CheckCircle2 className="h-3.5 w-3.5" />,
  expired: <Clock className="h-3.5 w-3.5" />,
  error: <AlertTriangle className="h-3.5 w-3.5" />,
  absent: <CircleSlash className="h-3.5 w-3.5" />,
}

/** The one-line status label, including who we're connected as. */
export function connectionLabel(
  connection: ConnectorConnectionInfo | null,
): string {
  if (!connection) return 'Not connected'
  switch (connection.status) {
    case 'connected':
      return connection.accountLabel
        ? `Connected as ${connection.accountLabel}`
        : 'Connected'
    case 'expired':
      // The distinction a person actually needs: whether waiting would help.
      return connection.canRefresh
        ? 'Token refresh failed — reconnect'
        : 'Expired — reconnect'
    case 'revoked':
      return 'Access revoked — reconnect'
    default:
      return 'Connection error'
  }
}

export function ConnectionBadge({
  connection,
  className,
}: {
  connection: ConnectorConnectionInfo | null
  className?: string
}) {
  const tone = connectionTone(connection)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        TONE_STYLES[tone],
        className,
      )}
    >
      {TONE_ICONS[tone]}
      {connectionLabel(connection)}
    </span>
  )
}

/** The connector's mark: its brand SVG when it has one, else a lettered chip. */
export function ConnectorIcon({
  icon,
  label,
  className,
}: {
  icon: string | null
  label: string
  className?: string
}) {
  if (icon) {
    return (
      <span
        className={cn('inline-flex h-8 w-8 items-center justify-center', className)}
        // Trusted, admin-supplied brand markup, and the same treatment
        // `ToolMeta.icon` already gets for built-in tools. Explicitly NOT the
        // remote server's own content — descriptions and tool names are third
        // party and are only ever rendered as text.
        // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml
        dangerouslySetInnerHTML={{ __html: icon }}
      />
    )
  }
  return (
    <span
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md bg-neutral-100 text-sm font-semibold text-neutral-600',
        className,
      )}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  )
}
