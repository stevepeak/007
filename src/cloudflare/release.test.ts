import { describe, expect, test } from 'bun:test'

import { releaseFromEnv } from './release'

// The deploy-time pins a run records — see `wf_run.host_release`. The seam is
// tiny; what matters is the edges: an unpinned local dev env and a `--var`
// with nothing after the colon must both read as "no release", never as `''`.
describe('releaseFromEnv', () => {
  test('reads both pins when the host set them', () => {
    expect(
      releaseFromEnv({ WF_HOST_RELEASE: 'abc123', WF_SDK_RELEASE: 'def456' }),
    ).toEqual({ hostRelease: 'abc123', sdkRelease: 'def456' })
  })

  test('an unpinned env records nothing rather than empty strings', () => {
    expect(releaseFromEnv({})).toEqual({
      hostRelease: undefined,
      sdkRelease: undefined,
    })
    expect(releaseFromEnv({ WF_HOST_RELEASE: '', WF_SDK_RELEASE: '  ' })).toEqual(
      { hostRelease: undefined, sdkRelease: undefined },
    )
  })

  test('the two sides are independent', () => {
    expect(releaseFromEnv({ WF_SDK_RELEASE: 'def456' })).toEqual({
      hostRelease: undefined,
      sdkRelease: 'def456',
    })
  })
})
