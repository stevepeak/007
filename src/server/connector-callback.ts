import { completeAuthorization } from '../connectors/oauth'
import type { WfDb } from '../storage/client'

import type { WfServerContext } from './handlers/handler-options'

// The OAuth redirect target — the one route that cannot be a POST.
//
// Everything else the connectors UI does goes through the single JSON data
// plane (`createWfSdkHandlers`). An authorization redirect can't: the browser
// arrives here by GET, sent by a server we don't control, carrying `code` and
// `state` as query parameters. So the host mounts this separately, at the path
// it declares as `connectorCallbackPath` — the two must agree, because that
// path is registered with the authorization server as the redirect URI and a
// mismatch is rejected at authorization time, not at startup.
//
// It answers with a redirect in every case, success or failure. A user who just
// came back from an OAuth screen should land on a page, never on a JSON body.

export type CreateWfConnectorCallbackOptions = {
  resolveDb: (req: Request) => WfDb | Promise<WfDb>
  /**
   * The authenticated caller. Same contract as the data plane's: throw
   * `UnauthorizedError` (or anything) to reject. The callback is a
   * state-changing route that stores a credential, so it must be gated exactly
   * as tightly as the editor itself.
   */
  resolveContext: (req: Request) => WfServerContext | Promise<WfServerContext>
  /** The connector encryption key. See `WfSdkConfig.resolveConnectorSecret`. */
  resolveSecret: (req: Request) => string | undefined | Promise<string | undefined>
  /**
   * Where to send the browser when the flow finishes and the attempt named no
   * `returnTo`. Defaults to `/wf/connectors`.
   */
  defaultReturnTo?: string
  /** Optional: report a failure to the host's error tracker. */
  onError?: (input: { err: unknown; req: Request }) => void
}

const DEFAULT_RETURN_TO = '/wf/connectors'

/**
 * Build the landing URL.
 *
 * `returnTo` is only ever honoured as a same-origin PATH. It arrives from the
 * `state` row rather than the query string, so it is already ours — but it was
 * written from a client-supplied value, and an open redirect that laundered
 * itself through our own database would still be an open redirect.
 */
function landing(
  req: Request,
  returnTo: string | null | undefined,
  fallback: string,
  params: Record<string, string>,
): string {
  const origin = new URL(req.url).origin
  const candidate = returnTo ?? fallback
  const path = candidate.startsWith('/') ? candidate : fallback
  const url = new URL(path, origin)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.href
}

/**
 * Handle the authorization-server redirect: exchange the code, store the
 * credential, and bounce the browser back to the connectors page.
 */
export function createWfConnectorCallback(
  opts: CreateWfConnectorCallbackOptions,
): (req: Request) => Promise<Response> {
  const fallback = opts.defaultReturnTo ?? DEFAULT_RETURN_TO

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')

    // The authorization server declined, or the user did. This is a normal
    // outcome, not a fault — report it on the page and log nothing.
    const denied = url.searchParams.get('error')
    if (denied) {
      const description =
        url.searchParams.get('error_description') ?? denied
      return Response.redirect(
        landing(req, null, fallback, { connector_error: description }),
        302,
      )
    }

    if (!code || !state) {
      return Response.redirect(
        landing(req, null, fallback, {
          connector_error:
            'The authorization server did not send a code. Start again from the connectors page.',
        }),
        302,
      )
    }

    try {
      // `resolveContext` is called for its GATE, not its value: it throws for
      // anyone who may not manage connectors, and this route stores a
      // credential. The identity it returns is already recorded on the
      // authorization attempt (`wf_connector_oauth_state.user_id`), written
      // when the flow started.
      const [db, , secret] = await Promise.all([
        opts.resolveDb(req),
        opts.resolveContext(req),
        opts.resolveSecret(req),
      ])
      if (!secret) {
        throw new Error(
          'Connector credentials are not configured on this deployment.',
        )
      }
      const { connectorId, returnTo } = await completeAuthorization({
        db,
        secret,
        state,
        code,
      })
      return Response.redirect(
        landing(req, returnTo, fallback, { connected: connectorId }),
        302,
      )
    } catch (err) {
      opts.onError?.({ err, req })
      return Response.redirect(
        landing(req, null, fallback, {
          connector_error: (err as Error).message,
        }),
        302,
      )
    }
  }
}
