// Where a connector is allowed to point.
//
// A connector URL is admin-entered and then fetched by a Worker holding live
// bindings, which makes it an SSRF surface: "https://mcp.example.com" and
// "http://127.0.0.1:8080" are the same three fields on the same form.
//
// Both of this repo's Workers set `global_fetch_strictly_public`, which blocks
// private-range fetches in production — but that flag is NOT enforced under
// `wrangler dev` (verified: a Worker carrying it fetched 127.0.0.1 happily).
// So local dev would never reproduce a prod block, and a URL that looks fine on
// a laptop would fail only after deploy. The check has to be ours, applied at
// write time, where it can be reported to the person typing the URL.

/** Thrown when a connector URL is not one we're willing to fetch. */
export class ConnectorUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectorUrlError'
  }
}

/**
 * Hostnames that resolve to the machine or the private network. Literal-only:
 * this cannot catch a public DNS name that resolves to a private address (that
 * needs resolution at fetch time, which Workers doesn't expose), and the
 * production flag is the backstop for that case.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata.google.internal',
])

/** Private / link-local / loopback IPv4 ranges, plus IPv6 unique-local. */
const BLOCKED_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // private
  /^192\.168\./, // private
  /^172\.(1[6-9]|2\d|3[01])\./, // private
  /^169\.254\./, // link-local (incl. cloud metadata at 169.254.169.254)
  /^0\./,
  /^\[?f[cd][0-9a-f]{2}:/i, // IPv6 unique-local
  /^\[?fe80:/i, // IPv6 link-local
]

/**
 * Validate a connector endpoint, returning the normalized URL.
 *
 * `allowInsecure` exists for local development against an MCP server on
 * localhost — it is an explicit, per-call opt-in rather than an environment
 * sniff, so nothing can decide on its own that this deployment is "dev enough"
 * to fetch private addresses.
 */
export function assertConnectorUrl(
  raw: string,
  opts: { allowInsecure?: boolean } = {},
): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConnectorUrlError(`"${raw}" is not a valid URL.`)
  }

  if (opts.allowInsecure) return url.href

  if (url.protocol !== 'https:') {
    throw new ConnectorUrlError(
      `A connector must be reached over https (got "${url.protocol}//"). ` +
        'Credentials are sent on every call.',
    )
  }
  const host = url.hostname.toLowerCase()
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    BLOCKED_PATTERNS.some((p) => p.test(host))
  ) {
    throw new ConnectorUrlError(
      `"${url.hostname}" is a private or loopback address. A connector must ` +
        'be a publicly reachable server.',
    )
  }
  return url.href
}

/** Non-throwing form, for a UI that wants to show the reason inline. */
export function connectorUrlProblem(
  raw: string,
  opts: { allowInsecure?: boolean } = {},
): string | null {
  try {
    assertConnectorUrl(raw, opts)
    return null
  } catch (err) {
    return (err as Error).message
  }
}
