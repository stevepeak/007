import { APICallError, RetryError } from 'ai'
import { describe, expect, test } from 'bun:test'

import { apiErrorDetail, errorFeedLine, errorStored } from './error-detail'

function apiError(): APICallError {
  return new APICallError({
    message: 'Payment Required',
    url: 'https://api.venice.ai/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 402,
    responseBody: '{"error":"Insufficient USD or Diem balance"}',
    isRetryable: false,
  })
}

// The shape Venice actually produced in Sentry WEB-R: a gateway timeout the
// provider returned repeatedly, which the SDK marks retryable.
function gatewayTimeout(): APICallError {
  return new APICallError({
    message: 'Gateway Timeout',
    url: 'https://api.venice.ai/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 504,
    responseBody: '<html><body>504 Gateway Time-out</body></html>',
    isRetryable: true,
  })
}

describe('apiErrorDetail', () => {
  test('extracts status and response body from an API error', () => {
    const d = apiErrorDetail(apiError())
    expect(d?.statusCode).toBe(402)
    expect(d?.isRetryable).toBe(false)
    expect(d?.responseBody).toContain('Insufficient USD')
  })

  test('returns null for an ordinary error', () => {
    expect(apiErrorDetail(new Error('boom'))).toBeNull()
  })

  // The Cloudflare dispatch rewraps a fatal provider error as a
  // NonRetryableError so the workflow stops retrying it. The provider's
  // response body — the only part that explains the failure — must survive
  // that rewrap and still reach wf_run_step.error and the run feed.
  test('follows `cause` so a rewrapped provider error keeps its detail', () => {
    const wrapped = new Error('AI_APICallError: Payment Required (HTTP 402)')
    wrapped.cause = apiError()

    const d = apiErrorDetail(wrapped)
    expect(d?.statusCode).toBe(402)
    expect(d?.responseBody).toContain('Insufficient USD')
    expect(errorFeedLine(wrapped)).toContain('HTTP 402')
    expect(errorStored(wrapped)).toContain('Insufficient USD')
  })

  test('a self-referential cause chain terminates', () => {
    const a = new Error('a')
    a.cause = a
    expect(apiErrorDetail(a)).toBeNull()
  })

  // The AI SDK's retry wrapper keeps its sub-errors on `.errors`/`.lastError`,
  // NOT on `cause`. This is the shape of Sentry WEB-R: following `cause` alone
  // returned null, so the 504 and Venice's response body were dropped.
  test('follows RetryError so a retried provider error keeps its detail', () => {
    const err = new RetryError({
      message: 'Failed after 3 attempts. Last error: Gateway Timeout',
      reason: 'maxRetriesExceeded',
      errors: [gatewayTimeout(), gatewayTimeout(), gatewayTimeout()],
    })

    const d = apiErrorDetail(err)
    expect(d?.statusCode).toBe(504)
    expect(d?.responseBody).toContain('504 Gateway Time-out')
    expect(d?.attempts).toBe(3)
    expect(d?.retryReason).toBe('maxRetriesExceeded')
    expect(errorFeedLine(err)).toContain('HTTP 504')
    expect(errorFeedLine(err)).toContain('after 3 attempts')
    expect(errorStored(err)).toContain('Gateway Time-out')
  })

  // `isRetryable: false` surviving the unwrap is what lets the Cloudflare
  // dispatch escalate to a NonRetryableError instead of replaying the whole
  // node four times against an error that will never succeed.
  test('a non-retryable error wrapped in a RetryError stays non-retryable', () => {
    const err = new RetryError({
      message: 'Failed after 1 attempt. Last error: Payment Required',
      reason: 'errorNotRetryable',
      errors: [apiError()],
    })

    const d = apiErrorDetail(err)
    expect(d?.isRetryable).toBe(false)
    expect(d?.statusCode).toBe(402)
    expect(d?.retryReason).toBe('errorNotRetryable')
  })

  test('a RetryError nested under a cause unwraps through both wrappers', () => {
    const wrapped = new Error('node failed')
    wrapped.cause = new RetryError({
      message: 'Failed after 2 attempts',
      reason: 'maxRetriesExceeded',
      errors: [gatewayTimeout(), gatewayTimeout()],
    })

    const d = apiErrorDetail(wrapped)
    expect(d?.statusCode).toBe(504)
    expect(d?.attempts).toBe(2)
  })

  test('a RetryError wrapping only ordinary errors yields null', () => {
    const err = new RetryError({
      message: 'Failed after 2 attempts',
      reason: 'maxRetriesExceeded',
      errors: [new Error('boom'), new Error('boom')],
    })
    expect(apiErrorDetail(err)).toBeNull()
  })
})
