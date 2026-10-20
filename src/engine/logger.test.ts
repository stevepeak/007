import { describe, expect, test } from 'bun:test'

import { notifyHostSafely, type WfLogger } from './logger'

describe('notifyHostSafely', () => {
  test('a throwing host callback is logged, not rethrown', async () => {
    const logged: string[] = []
    const logger: WfLogger = {
      error: (msg) => void logged.push(msg),
      warn: () => {},
    }
    await notifyHostSafely({
      name: 'on-failed',
      fn: () => {
        throw new Error('host exploded')
      },
      logger,
    })
    expect(logged).toEqual(["[wf] lifecycle callback 'on-failed' failed"])
  })
})
