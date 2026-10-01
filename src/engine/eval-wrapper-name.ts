// The naming convention for an agent's hidden eval wrapper workflow.
//
// It lives in `engine` — layer 0, no dependencies — rather than in `eval`,
// because two layers speak it and `storage` is BELOW `eval`: the eval harness
// MINTS these names (`ensureAgentEvalWrapper` caches a wrapper by its name) and
// the storage layer has to recognise them when it lists what references an
// agent, so a hidden wrapper isn't reported as a workflow someone wired up.
// Held in `eval/`, that second reader was a layer violation — which is exactly
// the "move the shared value down" case AGENTS.md §1 describes. `eval/wrapper`
// re-exports both names, so the published surface is unchanged.

/** Stable name prefix of an agent's wrapper workflow — also its cache key. */
export const EVAL_WRAPPER_NAME_PREFIX = 'eval-wrapper:'

/**
 * A wrapper's name doubles as its cache key. It must fold in the version pin so
 * a goal pinned to a specific version gets its own wrapper rather than reusing
 * the float-to-latest one. An unpinned (latest) target keeps the historic
 * `eval-wrapper:{agentId}` name for backward compatibility.
 */
export function evalWrapperName(
  agentId: string,
  version: number | null = null,
): string {
  return version == null
    ? `${EVAL_WRAPPER_NAME_PREFIX}${agentId}`
    : `${EVAL_WRAPPER_NAME_PREFIX}${agentId}@v${version}`
}
