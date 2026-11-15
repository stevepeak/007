// Whose credential a connector call uses.
//
// A connector (the server, its catalog, which tools are enabled) is shared
// workspace configuration; a CONNECTION is one credential for it, and there
// can be one per owner. The host decides who owns the credential a run uses
// (`WfSdkConfig.resolveConnectionOwner`), so one published agent can act for
// many tenants, each through its own account.
//
// It lives in `engine` because the config hook names it, and `storage`,
// `connectors` and `server` all key credentials by it. The ids are opaque to
// the SDK, exactly like `RunContext.correlationId`.

/**
 * - `workspace`: the one shared credential (the connectors page's own).
 * - `user`: a host user's personal credential.
 * - `tenant`: any other host scope that owns accounts — an org, a brand, a
 *   client.
 */
export type WfConnectionOwner =
  | { scope: 'workspace' }
  | { scope: 'user' | 'tenant'; id: string }

export const WORKSPACE_CONNECTION_OWNER: WfConnectionOwner = {
  scope: 'workspace',
}

/** For messages: "for tenant 'acme'", or nothing for the workspace. */
export function describeConnectionOwner(owner: WfConnectionOwner): string {
  return owner.scope === 'workspace' ? '' : ` for ${owner.scope} '${owner.id}'`
}
