import { describe, expect, test } from 'bun:test'

import { errorFeedLine, errorStored } from './error-detail'
import { errorMessage } from './error-message'

// A thrown plain object must read as itself, never "[object Object]".

describe('errorMessage', () => {
  test('an Error is its message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  test('a plain object with a message keeps it', () => {
    expect(errorMessage({ code: 'T2001', message: 'bad path', position: 3 })).toBe(
      'bad path',
    )
  })

  test('any other object is serialized', () => {
    expect(errorMessage({ code: 'E1' })).toBe('{"code":"E1"}')
  })

  test('a string and a primitive pass through', () => {
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(42)).toBe('42')
  })

  test('the feed line and stored form share the fallback', () => {
    expect(errorFeedLine({ code: 'E1' })).toBe('{"code":"E1"}')
    expect(errorStored({ code: 'E1' })).toBe('{"code":"E1"}')
  })
})
