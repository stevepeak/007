// The two optional vars a host pins at deploy time so every run can record
// what was deployed when it was created — see `wf_run.host_release` /
// `wf_run.sdk_release`. Import-safe on purpose (no Cloudflare types): the
// start path and both child-spawn paths read them, and `startGraphRun` has to
// stay loadable from any server runtime.

export interface ReleaseBindings {
  /**
   * Optional: the host's own release identifier — its git sha, typically. Pin
   * it at deploy (`wrangler deploy --var WF_HOST_RELEASE:$SHA`); leave it unset
   * in local dev, where a run is not on any release. Recorded, never read back
   * by the SDK.
   */
  WF_HOST_RELEASE?: string
  /**
   * Optional: the SDK's release identifier — the submodule commit the host is
   * deployed against (`git rev-parse HEAD:packages/007`). Separate from the
   * host's because the two move independently and "did this run predate the
   * fix" has to be answerable for either.
   */
  WF_SDK_RELEASE?: string
}

/** Empty strings read as unset — a `--var X:` with nothing after the colon. */
function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() ? v.trim() : undefined
}

export function releaseFromEnv(env: ReleaseBindings): {
  hostRelease?: string
  sdkRelease?: string
} {
  return {
    hostRelease: nonEmpty(env.WF_HOST_RELEASE),
    sdkRelease: nonEmpty(env.WF_SDK_RELEASE),
  }
}
