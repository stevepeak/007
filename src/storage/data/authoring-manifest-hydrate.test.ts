import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import { makeAgentConfig } from '../../engine/agent-test-helpers'
import type {
  WfAgentManifestEntry,
  WfRunManifestEntry,
  WorkflowGraph,
} from '../../engine/graph'
import type { WfDb } from '../client'
import { d1Guard, migratedSqlite } from '../db-test-helpers'
import { wfRun, wfSchema, wfWorkflow, wfWorkflowVersion } from '../schema'

import { createAgent, publishAgent } from './authoring-agents'
import { hydrateRunManifest, resolveRunManifest } from './authoring-manifest'
import { setRunManifest } from './runs-lifecycle'
import { getRunManifest } from './runs-resume'

function graphOf(agentId: string): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: 'agent',
        kind: 'agent',
        label: 'agent',
        position: { x: 0, y: 0 },
        informUser: { mode: 'off' },
        config: { agentId, version: null, inputs: {} },
      },
    ],
    edges: [],
  }
}

function agentEntry(manifest: WfRunManifestEntry[]) {
  return manifest.find((e): e is WfAgentManifestEntry => e.kind === 'agent')!
}

describe('run manifest refs', () => {
  let db: WfDb
  let queries: string[]
  let agentId: string

  beforeEach(async () => {
    queries = []
    db = drizzle(d1Guard(migratedSqlite()), {
      schema: wfSchema,
      logger: {
        logQuery: (q) => {
          queries.push(q)
        },
      },
    }) as unknown as WfDb
    ;({ agentId } = await createAgent(db, {
      name: 'Summarizer',
      config: makeAgentConfig({ prompt: 'v1' }),
    }))
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Root' })
    await db.insert(wfWorkflowVersion).values({
      id: 'wfv-1',
      workflowId: 'wf-1',
      versionNumber: 1,
      graph: graphOf(agentId),
    })
    await db.insert(wfRun).values({
      id: 'run-1',
      workflowVersionId: 'wfv-1',
      triggerKind: 'chat',
    })
  })

  const storedManifest = async () => {
    const [row] = await db
      .select({ manifest: wfRun.manifest })
      .from(wfRun)
    return row?.manifest
  }

  test('the run row stores refs, never version content', async () => {
    const manifest = await resolveRunManifest(db, graphOf(agentId))
    await setRunManifest(db, { runId: 'run-1', manifest })

    const { versionId, versionNumber } = agentEntry(manifest)
    expect(await storedManifest()).toEqual([
      {
        kind: 'agent',
        id: agentId,
        pinnedVersion: null,
        versionId,
        versionNumber,
        name: 'Summarizer',
      },
    ])
  })

  test('a stored manifest hydrates to what resolution produced', async () => {
    const manifest = await resolveRunManifest(db, graphOf(agentId))
    await setRunManifest(db, { runId: 'run-1', manifest })

    const refs = await getRunManifest(db, 'run-1')
    expect(await hydrateRunManifest(db, refs!)).toEqual(manifest)
  })

  test('a publish after the freeze does not reach the run', async () => {
    const manifest = await resolveRunManifest(db, graphOf(agentId))
    await setRunManifest(db, { runId: 'run-1', manifest })
    await publishAgent(db, {
      agentId,
      config: makeAgentConfig({ prompt: 'v2' }),
    })

    const refs = await getRunManifest(db, 'run-1')
    const entry = agentEntry(await hydrateRunManifest(db, refs!))
    expect(entry.versionNumber).toBe(1)
    expect(entry.config.prompt).toBe('v1')
  })

  test('hydrates workflow refs from the workflow version', async () => {
    const [entry] = await hydrateRunManifest(db, [
      {
        kind: 'workflow',
        id: 'wf-1',
        versionId: 'wfv-1',
        versionNumber: 1,
        name: 'Root',
      },
    ])
    expect(entry).toMatchObject({ kind: 'workflow', graph: graphOf(agentId) })
  })

  test('a row that embedded its content hydrates from the version row', async () => {
    const manifest = await resolveRunManifest(db, graphOf(agentId))
    const embedded = agentEntry(manifest)
    const entry = agentEntry(
      await hydrateRunManifest(db, [
        { ...embedded, config: makeAgentConfig({ prompt: 'stale copy' }) },
      ] as WfRunManifestEntry[]),
    )
    expect(entry.config.prompt).toBe('v1')
  })

  test('a ref whose version is gone is dropped, not a throw', async () => {
    const manifest = await resolveRunManifest(db, graphOf(agentId))
    const hydrated = await hydrateRunManifest(db, [
      ...manifest,
      {
        kind: 'workflow',
        id: 'wf-gone',
        versionId: 'wfv-gone',
        versionNumber: 1,
        name: 'Gone',
      },
    ])
    expect(hydrated).toEqual(manifest)
  })

  test('a second hydrate in this isolate reads no version row', async () => {
    const manifest = await resolveRunManifest(db, graphOf(agentId))
    await hydrateRunManifest(db, manifest)
    queries = []
    await hydrateRunManifest(db, manifest)
    expect(queries).toEqual([])
  })

  test('the cached content is not shared between runs', async () => {
    const manifest = await resolveRunManifest(db, graphOf(agentId))
    const first = agentEntry(await hydrateRunManifest(db, manifest))
    first.config.prompt = 'mutated by one run'

    const second = agentEntry(await hydrateRunManifest(db, manifest))
    expect(second.config.prompt).toBe('v1')
  })

  test('a transient read failure is retried', async () => {
    const manifest = await resolveRunManifest(db, graphOf(agentId))
    let failures = 1
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select' && failures > 0) {
          failures--
          throw new Error('D1_ERROR: network connection lost')
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    expect(await hydrateRunManifest(flaky, manifest)).toEqual(manifest)
  })

  test('a read that keeps failing surfaces its error', async () => {
    const manifest = await resolveRunManifest(db, graphOf(agentId))
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select') throw new Error('D1_ERROR: database is down')
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    await expect(hydrateRunManifest(broken, manifest)).rejects.toThrow(
      'database is down',
    )
  })

  test('a run that stored no manifest reads back as null', async () => {
    expect(await getRunManifest(db, 'run-1')).toBeNull()
    expect(await getRunManifest(db, 'nope')).toBeNull()
  })
})
