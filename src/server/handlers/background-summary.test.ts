import { describe, expect, test } from 'bun:test'

import type { WfLogger } from '../../engine/logger'

import { scheduleBackgroundSummary } from './shared'

function recordingLogger(): { logger: WfLogger; errors: unknown[][] } {
  const errors: unknown[][] = []
  return {
    errors,
    logger: {
      warn: () => {},
      error: (message, err) => {
        errors.push([message, err])
      },
    },
  }
}

describe('scheduleBackgroundSummary', () => {
  test('without a scheduler nothing is computed and env is never resolved', async () => {
    let touched = false
    await scheduleBackgroundSummary({
      waitUntil: undefined,
      c: {
        env: async () => {
          touched = true
          return {}
        },
        logger: recordingLogger().logger,
      },
      failureMessage: 'failed',
      compute: async () => {
        touched = true
        return { short: '', long: '' }
      },
      persist: async () => {},
    })
    expect(touched).toBe(false)
  })

  test('persists the computed summary, with env resolved before deferral', async () => {
    const pending: Promise<unknown>[] = []
    const persisted: unknown[] = []
    await scheduleBackgroundSummary({
      waitUntil: (p) => {
        pending.push(p)
      },
      c: { env: async () => ({ key: 'v' }), logger: recordingLogger().logger },
      failureMessage: 'failed',
      compute: async ({ env }) => ({ short: JSON.stringify(env), long: 'l' }),
      persist: async (summary) => {
        persisted.push(summary)
      },
    })
    await Promise.all(pending)
    expect(persisted).toEqual([{ short: '{"key":"v"}', long: 'l' }])
  })

  test('a failure is logged under the given message, never thrown', async () => {
    const pending: Promise<unknown>[] = []
    const { logger, errors } = recordingLogger()
    await scheduleBackgroundSummary({
      waitUntil: (p) => {
        pending.push(p)
      },
      c: { env: async () => ({}), logger },
      failureMessage: 'summary failed',
      compute: async () => {
        throw new Error('boom')
      },
      persist: async () => {},
    })
    await Promise.all(pending)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.[0]).toBe('summary failed')
  })
})
