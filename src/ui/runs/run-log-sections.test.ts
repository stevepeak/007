import { describe, expect, test } from 'bun:test'

import { isEmptyValue, runLogSections } from './run-log-sections'

describe('isEmptyValue', () => {
  test('treats the column defaults and blanks as empty', () => {
    for (const v of [null, undefined, '', [], {}]) {
      expect(isEmptyValue(v)).toBe(true)
    }
  })

  test('keeps falsy-but-real values', () => {
    for (const v of [0, false, 'x', [0], { a: undefined }]) {
      expect(isEmptyValue(v)).toBe(false)
    }
  })
})

describe('runLogSections', () => {
  test('a running step with default meta/output shows neither Details nor Output', () => {
    expect(
      runLogSections({
        step: { status: 'running', meta: {}, output: {} },
        hasBespokeMeta: false,
      }),
    ).toEqual({ details: false, tail: 'pending' })
  })

  test('a completed step with real data shows Details and Output', () => {
    expect(
      runLogSections({
        step: { status: 'completed', meta: { took: 3 }, output: { ok: true } },
        hasBespokeMeta: false,
      }),
    ).toEqual({ details: true, tail: 'output' })
  })

  test('a settled step with no output says so explicitly', () => {
    for (const status of ['completed', 'failed', 'skipped']) {
      expect(
        runLogSections({
          step: { status, meta: {}, output: {} },
          hasBespokeMeta: false,
        }).tail,
      ).toBe('empty')
    }
  })

  test('meta with a bespoke view never doubles as Details', () => {
    expect(
      runLogSections({
        step: { status: 'completed', meta: { steps: [] }, output: 'hi' },
        hasBespokeMeta: true,
      }).details,
    ).toBe(false)
  })
})
