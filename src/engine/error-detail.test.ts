import {
  APICallError,
  type FinishReason,
  NoObjectGeneratedError,
  RetryError,
} from 'ai'
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

// The shape Sentry WEB-C actually produced: the `titles` agent's structured
// call came back as a lone `{`, so the SDK's parse failed one character in.
// Everything that explains it — the finish reason, the reasoning-vs-output
// token split, the raw text — hangs off the error and nowhere else.
function noObjectGenerated(
  finishReason: FinishReason = 'length',
  text = '{',
): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'No object generated: could not parse the response.',
    cause: new Error(
      "JSON parsing failed: Text: {.\nError message: SyntaxError: Expected property name or '}' in JSON at position 1",
    ),
    text,
    response: {
      id: 'gen-1',
      modelId: 'google/gemini-2.5-flash',
      timestamp: new Date(0),
    },
    usage: {
      inputTokens: 9_000,
      inputTokenDetails: {
        noCacheTokens: 9_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokens: 8_192,
      outputTokenDetails: { textTokens: 1, reasoningTokens: 8_191 },
      totalTokens: 17_192,
    },
    finishReason,
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

  // Before this branch existed, a NoObjectGeneratedError fell through to the
  // `cause` walk, bottomed out at a bare SyntaxError, and returned null — so
  // WEB-C stored a stack and nothing else.
  test('keeps the diagnosis off a structured-output failure', () => {
    const d = apiErrorDetail(noObjectGenerated())
    expect(d?.name).toBe('AI_NoObjectGeneratedError')
    expect(d?.finishReason).toBe('length')
    expect(d?.text).toBe('{')
    expect(d?.cause).toContain('JSON parsing failed')
    expect(d?.usage?.outputTokenDetails.reasoningTokens).toBe(8_191)

    const stored = errorStored(noObjectGenerated())
    expect(stored).toContain('"finishReason": "length"')
    expect(stored).toContain('"reasoningTokens": 8191')
  })

  // `length` says truncated, `stop` says the model finished and simply didn't
  // answer in the requested shape. Two different bugs, so the feed names it
  // rather than making a reader open the stored blob.
  test('the feed line names the finish reason', () => {
    expect(errorFeedLine(noObjectGenerated())).toContain('finish: length')
    expect(errorFeedLine(noObjectGenerated('stop'))).toContain('finish: stop')
  })

  // Undefined, NOT false: the dispatch escalates `isRetryable === false` to a
  // NonRetryableError, which would fail the whole run on the first flake
  // instead of letting the step retry re-run the node.
  test('leaves isRetryable unset so the step retry still runs', () => {
    expect(apiErrorDetail(noObjectGenerated())?.isRetryable).toBeUndefined()
  })

  // An agent that answers in prose instead of JSON hands back its whole answer.
  // Capped, and serialized last, so it can't push the diagnosis out of the blob.
  test('a huge raw text is capped and cannot crowd out the diagnosis', () => {
    const stored = errorStored(noObjectGenerated('stop', 'x'.repeat(50_000)))
    expect(stored).toContain('"finishReason": "stop"')
    expect(stored).toContain('truncated 48000 chars')
    expect(stored.length).toBeLessThan(16_000)
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
