import type { WfDb } from '../storage/client'
import { getConnection, setConnectionStatus } from '../storage/data/connectors'

import { McpUnauthorizedError, type McpAuth } from './client'
import { resolveAccessToken } from './oauth'

/**
 * Talk to a connector's server with its stored credential, keeping the
 * connection's status honest in both directions — the one path a tool call and
 * a catalog refresh share.
 *
 * - No credential: `requireCredential` callers (a tool call) fail with an
 *   unauthorized error naming the connector; the others (a refresh — a server
 *   may expose its catalog unauthenticated) go ahead with no auth.
 * - A 401 with a credential: the token went bad mid-life (revoked upstream, or
 *   minted with the wrong scopes). The connection flips to `expired` so the
 *   connectors page offers Reconnect, instead of every call failing anonymously.
 * - Success with a credential: an `expired` connection the server honours again
 *   flips back to `connected`, or the page keeps offering Reconnect forever.
 */
export async function withConnectorAuth<T>(args: {
  db: WfDb
  connector: Parameters<typeof resolveAccessToken>[0]['connector']
  secret: string
  requireCredential: boolean
  run: (auth: McpAuth) => Promise<T>
}): Promise<T> {
  const { db, connector } = args
  const credential = await resolveAccessToken({
    db,
    connector,
    secret: args.secret,
  })
  if (!credential && args.requireCredential) {
    throw new McpUnauthorizedError(
      `${connector.label} is not connected. Connect it from the connectors page.`,
    )
  }
  let result: T
  try {
    result = await args.run(
      credential
        ? { kind: 'bearer', token: credential.token }
        : { kind: 'none' },
    )
  } catch (err) {
    if (err instanceof McpUnauthorizedError && credential) {
      const connection = await getConnection(db, connector.id)
      if (connection) {
        await setConnectionStatus(db, {
          connectionId: connection.id,
          status: 'expired',
          error: err.message,
        })
      }
    }
    throw err
  }
  if (credential) {
    const connection = await getConnection(db, connector.id)
    if (connection && connection.status === 'expired') {
      await setConnectionStatus(db, {
        connectionId: connection.id,
        status: 'connected',
        error: null,
      })
    }
  }
  return result
}
