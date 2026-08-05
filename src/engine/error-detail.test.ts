import { APICallError } from 'ai'
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
})
