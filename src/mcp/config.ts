// How `wf-mcp` learns where to point and what it is allowed to do.
//
// Both halves matter to a host that is not this repo: 007 ships the server, and
// the deployment it talks to is entirely the host's. Nothing is baked in — no
// origin, no route path, no token.

/** Default route the SDK's handlers are mounted at (`createWfSdkHandlers`). */
const DEFAULT_API_PATH = '/api/wf'

/**
 * Generous by design. The default `createHttpWfDataClient` budget is 20s
 * because it backstops a UI spinner; here the caller is a model that is happy
 * to wait, and the slow methods (a dashboard read, an eval run) legitimately
 * take longer than a UI would tolerate.
 */
const DEFAULT_TIMEOUT_MS = 120_000

export type WfMcpConfig = {
  /** Fully-resolved URL of the mounted data API. */
  apiUrl: string
  /** Bearer credential presented on every call. */
  token: string
  /**
   * Whether mutating tools are REGISTERED. Off by default, and off means the
   * write tools do not exist on the server at all — see `createWfMcpServer`.
   */
  write: boolean
  timeoutMs: number
}

export type WfMcpEnv = {
  WF_BASE_URL?: string
  WF_API_PATH?: string
  WF_MCP_TOKEN?: string
  WF_MCP_TIMEOUT_MS?: string
}

/** `--flag=value` / `--flag` — the only shape an MCP client config can pass. */
function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const withValue = argv.find((a) => a.startsWith(prefix))
  if (withValue) return withValue.slice(prefix.length)
  return argv.includes(`--${name}`) ? '' : undefined
}

/**
 * Resolve the server's configuration from argv and the environment.
 *
 * Flags win over env: an MCP client config file sets the env block once, and a
 * flag is what someone types to point the same entry somewhere else for one
 * session.
 *
 * `WF_BASE_URL` may be either an origin (`https://app.example.com`, the route
 * path is appended) or the full route URL. Accepting both is worth the small
 * ambiguity — the origin is what a person reaches for, and the full URL is what
 * they paste after reading an error.
 *
 * Throws rather than defaulting on a missing token. A server that starts
 * without one would fail on every tool call with a 403, and the useful message
 * would be nowhere near the cause.
 */
export function resolveWfMcpConfig(
  argv: string[],
  env: WfMcpEnv,
): WfMcpConfig {
  const baseUrl = readFlag(argv, 'base-url') || env.WF_BASE_URL
  if (!baseUrl) {
    throw new Error(
      'No API target. Set WF_BASE_URL (e.g. http://localhost:3000) or pass --base-url=…',
    )
  }
  const token = readFlag(argv, 'token') || env.WF_MCP_TOKEN
  if (!token) {
    throw new Error(
      'No credential. Set WF_MCP_TOKEN to the value of the host Worker’s WF_MCP_TOKEN secret, or pass --token=…',
    )
  }
  const path = readFlag(argv, 'api-path') || env.WF_API_PATH || DEFAULT_API_PATH
  const trimmed = baseUrl.replace(/\/+$/, '')
  const apiUrl = trimmed.endsWith(path) ? trimmed : `${trimmed}${path}`

  const rawTimeout = readFlag(argv, 'timeout') ?? env.WF_MCP_TIMEOUT_MS
  const parsedTimeout = rawTimeout ? Number(rawTimeout) : NaN
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : DEFAULT_TIMEOUT_MS

  return {
    apiUrl,
    token,
    write: readFlag(argv, 'write') !== undefined,
    timeoutMs,
  }
}
