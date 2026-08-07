import { describe, expect, test } from 'bun:test'

import { assertDatasetName, createAnalyticsQuery } from './query'
import {
  runVolumeSql,
  spendSql,
  workflowStepsSql,
  type AnalyticsWindow,
} from './sql'

const W: AnalyticsWindow = {
  sinceSec: 1_700_000_000,
  untilSec: 1_700_600_000,
  size: 3600,
}

const BUILDERS = {
  runVolume: runVolumeSql('wf_telemetry', W),
  spend: spendSql('wf_telemetry', W),
  workflowSteps: workflowStepsSql('wf_telemetry', W),
}

describe('sampling correctness', () => {
  // The failure this guards is nasty: a bare COUNT()/SUM() is right until a
  // workflow gets busy enough for AE to sample it, then silently under-reports
  // — exactly when the number matters. Regex, not review.
  for (const [name, sql] of Object.entries(BUILDERS)) {
    test(`${name}: every aggregate is sample-weighted`, () => {
      const aggregates = sql.match(/\b(?:SUM|COUNT|AVG)\s*\([^)]*\)/g) ?? []
      expect(aggregates.length).toBeGreaterThan(0)
      for (const agg of aggregates) {
        expect(agg).toContain('_sample_interval')
      }
    })

    test(`${name}: filters on the schema version so a v2 layout can't leak in`, () => {
      expect(sql).toContain("blob2 = '1'")
    })

    test(`${name}: excludes eval runs, matching the D1 charts`, () => {
      expect(sql).toContain('double1 = 0')
    })
  }
})

describe('query shape', () => {
  test('run volume buckets on the CARRIED run start, not ingest time', () => {
    // A long run is written at finish; bucketing on `timestamp` would file it
    // under the wrong hour and stop it reconciling with `wf_run.created_at`.
    expect(BUILDERS.runVolume).toContain('intDiv(toUInt32(double9), 3600)')
  })

  test('spend buckets on ingest time — money belongs to when it was spent', () => {
    expect(BUILDERS.spend).toContain(
      'intDiv(toUInt32(toUnixTimestamp(timestamp)), 3600)',
    )
  })

  test('run-volume queries prune partitions with a timestamp predicate', () => {
    // Without this AE scans the whole retention window for every query.
    expect(BUILDERS.runVolume).toContain('timestamp >= toDateTime(1699913600)')
    expect(BUILDERS.workflowSteps).toContain(
      'timestamp >= toDateTime(1699913600)',
    )
  })

  test('the steps query counts only durable runs — inline bills no steps', () => {
    expect(BUILDERS.workflowSteps).toContain("blob11 = 'durable'")
  })

  test('spend reads only agent steps', () => {
    expect(BUILDERS.spend).toContain("blob9 = 'agent'")
    expect(BUILDERS.spend).toContain("blob1 = 'step'")
  })

  test('cost is converted out of integer micros', () => {
    expect(BUILDERS.spend).toContain('SUM(_sample_interval * double8) / 1e6')
  })
})

describe('assertDatasetName', () => {
  // The SQL API has no parameter binding, so the dataset name is interpolated.
  test('accepts an ordinary dataset name', () => {
    expect(assertDatasetName('wf_telemetry')).toBe('wf_telemetry')
  })

  for (const bad of [
    'wf telemetry',
    'wf;DROP TABLE x',
    'wf-telemetry',
    '',
    'wf_telemetry WHERE 1=1',
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => assertDatasetName(bad)).toThrow(/Invalid Analytics Engine/)
    })
  }

  test('createAnalyticsQuery validates at construction, not at first query', () => {
    expect(() =>
      createAnalyticsQuery({
        accountId: 'acct',
        apiToken: 'token',
        dataset: 'bad name',
      }),
    ).toThrow(/Invalid Analytics Engine/)
  })
})

describe('createAnalyticsQuery', () => {
  function stubFetch(res: Partial<Response> & { json?: () => Promise<unknown> }) {
    const calls: { url: string; init: RequestInit }[] = []
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return { ok: true, status: 200, ...res } as Response
    }) as unknown as typeof fetch
    return { calls, impl }
  }

  test('posts the SQL and returns the data array', async () => {
    const { calls, impl } = stubFetch({
      json: async () => ({ data: [{ runs: 3 }], rows: 1 }),
    })
    const query = createAnalyticsQuery({
      accountId: 'acct-1',
      apiToken: 'secret',
      dataset: 'wf_telemetry',
      fetchImpl: impl,
    })
    expect(await query.run('SELECT 1')).toEqual([{ runs: 3 }])
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-1/analytics_engine/sql',
    )
    expect(calls[0].init.body).toBe('SELECT 1')
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe('Bearer secret')
  })

  test('an empty result set is an empty array, not a throw', async () => {
    const { impl } = stubFetch({ json: async () => ({ rows: 0 }) })
    const query = createAnalyticsQuery({
      accountId: 'a',
      apiToken: 't',
      dataset: 'wf_telemetry',
      fetchImpl: impl,
    })
    expect(await query.run('SELECT 1')).toEqual([])
  })

  test('a non-2xx surfaces the body — AE reports schema errors as plain text', async () => {
    const impl = (async () =>
      ({
        ok: false,
        status: 403,
        text: async () => 'authentication error',
      }) as unknown as Response) as unknown as typeof fetch
    const query = createAnalyticsQuery({
      accountId: 'a',
      apiToken: 't',
      dataset: 'wf_telemetry',
      fetchImpl: impl,
    })
    await expect(query.run('SELECT 1')).rejects.toThrow(
      /failed \(403\): authentication error/,
    )
  })
})
