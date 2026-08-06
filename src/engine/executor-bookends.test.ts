import { describe, expect, test } from 'bun:test'

import { executeWorkflow } from './executor'
import { createMemoryRunRecorder } from './run-recorder'
import { createMemorySink, type StreamSink } from './stream-sink'
import { chainGraph, makeConfig } from './executor-test-helpers'

// The in-process backend is what the INLINE engine runs on, so it owes the run
// viewer the same feed the durable backend emits from its `enter:`/`record:`
// steps. The viewer derives "which node is active" from a `node-start` with no
// matching `node-end`, so a missing bookend renders as a run where nothing is
// happening.
describe('executor — node bookends', () => {
  test('every node opens and closes its feed', async () => {
    const sink = createMemorySink()
    await executeWorkflow({
      graph: chainGraph({ continueOnError: true }),
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
      sink,
    })

    const starts = sink.logs.filter((e) => e.level === 'node-start')
    expect(starts.map((e) => e.nodeId)).toEqual(['boom', 'after'])

    // `boom` fails (but continues the run), so it closes with an `error` entry
    // carrying the reason; `after` closes cleanly with `node-end`.
    const boomEnd = sink.logs.find(
      (e) => e.nodeId === 'boom' && e.level === 'error',
    )
    expect(boomEnd?.message).toContain('boom failed')

    const afterEnd = sink.logs.find(
      (e) => e.nodeId === 'after' && e.level === 'node-end',
    )
    expect(afterEnd?.message).toContain('After')

    // No node is left open — nothing would render as perpetually running.
    for (const nodeId of ['boom', 'after']) {
      const opened = sink.logs.filter(
        (e) => e.nodeId === nodeId && e.level === 'node-start',
      ).length
      const closed = sink.logs.filter(
        (e) =>
          e.nodeId === nodeId &&
          (e.level === 'node-end' || e.level === 'error'),
      ).length
      expect(closed).toBe(opened)
    }
  })

  // Regression: an in-flight node used to have NO step row at all (this backend
  // recorded only on completion), so a run sitting on a slow agent looked like
  // it had stopped at the previous node — there was nothing for the viewer's
  // active-node highlight to read.
  test('a node is recorded as running before it runs', async () => {
    const seen: { nodeId: string; status: string }[] = []
    const recorder = createMemoryRunRecorder()
    const spy = {
      steps: recorder.steps,
      record: (args: Parameters<typeof recorder.record>[0]) => {
        seen.push({ nodeId: args.nodeId, status: args.status })
        return recorder.record(args)
      },
    }
    await executeWorkflow({
      graph: chainGraph({ continueOnError: true }),
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: spy,
    })

    // Each executable node opens with `running` and settles afterwards.
    expect(seen.filter((s) => s.nodeId === 'boom')).toEqual([
      { nodeId: 'boom', status: 'running' },
      { nodeId: 'boom', status: 'failed' },
    ])
    expect(seen.filter((s) => s.nodeId === 'after')).toEqual([
      { nodeId: 'after', status: 'running' },
      { nodeId: 'after', status: 'completed' },
    ])
    // The upsert keeps one row per node — the terminal one.
    expect(
      recorder.steps.filter((s) => s.nodeId === 'boom').map((s) => s.status),
    ).toEqual(['failed'])
  })

  // Regression: node handlers emit entries without knowing where they sit in
  // the walk. Unstamped, a sink that persists per node drops every one of them,
  // and a working agent renders as a node that opened and went silent.
  test('entries emitted by a node handler are stamped with its identity', async () => {
    const raw: { nodeId?: string; nodeKind?: string; sequence?: number }[] = []
    const sink: StreamSink = {
      append: () => undefined,
      log: (e) => {
        raw.push({ nodeId: e.nodeId, nodeKind: e.nodeKind, sequence: e.sequence })
      },
    }
    await executeWorkflow({
      graph: chainGraph({ continueOnError: true }),
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
      sink,
    })
    expect(raw.length).toBeGreaterThan(0)
    // Nothing reaches the run sink anonymously.
    for (const e of raw) {
      expect(e.nodeId).toBeTruthy()
      expect(e.nodeKind).toBeTruthy()
      expect(typeof e.sequence).toBe('number')
    }
  })

  test('a node that aborts the run still closes its feed', async () => {
    const sink = createMemorySink()
    await expect(
      executeWorkflow({
        graph: chainGraph(),
        triggerInput: { n: 1 },
        config: makeConfig(),
        runContext: { subjectId: 'acme', triggerKind: 'go' },
        recorder: createMemoryRunRecorder(),
        sink,
      }),
    ).rejects.toThrow('boom failed')

    expect(
      sink.logs.some((e) => e.nodeId === 'boom' && e.level === 'node-start'),
    ).toBe(true)
    expect(
      sink.logs.some((e) => e.nodeId === 'boom' && e.level === 'error'),
    ).toBe(true)
  })
})
