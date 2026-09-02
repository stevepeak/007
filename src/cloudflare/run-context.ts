import type { RunContext, WfRunManifestEntry } from '../engine'

// The one place a backend builds the per-run context it hands to
// `buildRunDeps`, prompt interpolation and the host's lifecycle hooks.
//
// It exists because there are TWO backends — the durable Cloudflare Workflows
// dispatch and the inline runner a trigger can pick instead — and each of them
// assembles this object in several places. When `runId` was added so a host tool
// could name the run it is executing inside, only the durable backend got it;
// the inline one silently handed every tool an undefined run id, and the host
// feature that depended on it (linking a generated document back to the chat
// turn that produced it) simply produced nothing on the engine our chat
// workflow actually runs on. Nothing failed. The row just had a null column.
//
// A shared constructor makes that class of omission impossible rather than
// merely unlikely: a new field is added once, and both engines have it.

/** What every backend knows about the run it is executing. */
export type RunContextSource = {
  runContext: RunContext
  workflowRunId: string
}

/**
 * The run context for one backend's execution, stamped with the identity of the
 * run itself.
 *
 * `env` is threaded through so `buildRunDeps` can construct clients from live
 * bindings inside a step boundary; `manifest` is passed once it has been
 * resolved (it is not known at the moment the first context is built).
 */
export function runContextFor(
  source: RunContextSource,
  env: unknown,
  extras?: { manifest?: WfRunManifestEntry[] },
): RunContext {
  return {
    ...source.runContext,
    env,
    runId: source.workflowRunId,
    ...(extras?.manifest ? { manifest: extras.manifest } : {}),
  }
}
