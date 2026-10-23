import { APICallError, RetryError } from 'ai'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import {
  classifyFailure,
  failedNodeIdOf,
  RunCancelledError,
  tagFailure,
} from './failure-route'
import { IterationTooManyItemsError } from './nodes/iteration'
import { WorkflowBudgetError, WorkflowStalledError } from './scheduler'

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: 'Provider said no',
    url: 'https://provider.example/v1/chat',
    requestBodyValues: {},
    statusCode,
  })
}

describe('classifyFailure', () => {
  test('reads the provider status code', () => {
    expect(classifyFailure(apiError(429))).toBe('rate_limited')
    expect(classifyFailure(apiError(402))).toBe('limit_exceeded')
    expect(classifyFailure(apiError(504))).toBe('timeout')
    expect(classifyFailure(apiError(401))).toBe('external_error')
    expect(classifyFailure(apiError(503))).toBe('external_error')
  })

  test('sees through the AI SDK retry wrapper', () => {
    const last = apiError(429)
    const err = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [last, last, last],
    })
    expect(classifyFailure(err)).toBe('rate_limited')
  })

  test('knows the engine and platform error classes by name', () => {
    expect(classifyFailure(new RunCancelledError())).toBe('cancelled')
    expect(classifyFailure(new WorkflowBudgetError(256))).toBe('limit_exceeded')
    expect(classifyFailure(new WorkflowStalledError())).toBe('internal_error')
    expect(
      classifyFailure(new IterationTooManyItemsError('it', 900, 500, 'too long')),
    ).toBe('limit_exceeded')
    expect(classifyFailure(new DOMException('slow', 'TimeoutError'))).toBe(
      'timeout',
    )
    const zod = z.object({ id: z.string() }).safeParse({})
    expect(classifyFailure(zod.error)).toBe('invalid_input')
  })

  test('falls back to the message — all a durable step boundary leaves', () => {
    expect(classifyFailure(new Error('Bad Request (HTTP 429)'))).toBe(
      'rate_limited',
    )
    expect(classifyFailure(new Error('fetch failed'))).toBe('external_error')
    expect(
      classifyFailure(new Error("Workflow output does not satisfy the 'chat' trigger contract")),
    ).toBe('invalid_output')
  })

  test('anything unrecognised is an internal error', () => {
    expect(classifyFailure(new Error('undefined is not a function'))).toBe(
      'internal_error',
    )
    expect(classifyFailure('a thrown string')).toBe('internal_error')
  })

  test('a tagged route wins, so a tool can choose its own', () => {
    const err = Object.assign(new Error('nope'), { failureRoute: 'invalid_input' })
    expect(classifyFailure(err)).toBe('invalid_input')
    expect(classifyFailure(tagFailure(new Error('x'), { route: 'timeout' }))).toBe(
      'timeout',
    )
  })
})

describe('tagFailure', () => {
  test('keeps the first route and node it was given', () => {
    const err = tagFailure(new Error('x'), { route: 'timeout', nodeId: 'a' })
    tagFailure(err, { route: 'rate_limited', nodeId: 'b' })
    expect(classifyFailure(err)).toBe('timeout')
    expect(failedNodeIdOf(err)).toBe('a')
  })

  test('passes a non-object through untouched', () => {
    expect(tagFailure('boom', { route: 'timeout' })).toBe('boom')
  })
})
