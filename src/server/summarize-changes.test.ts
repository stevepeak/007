import { describe, expect, test } from 'bun:test'

import { repairSummaryText } from './summarize-changes'

describe('repairSummaryText', () => {
  // Verbatim from the aion-3-0 response that produced
  // AI_NoObjectGeneratedError: the right content, the wrong envelope.
  test('salvages a fenced commit message', () => {
    const raw =
      '```\n' +
      'Add "engine": "inline" to Chat message trigger config\n' +
      '\n' +
      'The trigger node now explicitly sets `engine` to `inline` in its config.\n' +
      'No other nodes, edges, or agent configurations were changed.\n' +
      '```\n'
    const repaired = repairSummaryText(raw)
    expect(repaired).not.toBeNull()
    expect(JSON.parse(repaired!)).toEqual({
      short: 'Add "engine": "inline" to Chat message trigger config',
      long:
        'The trigger node now explicitly sets `engine` to `inline` in its config.\n' +
        'No other nodes, edges, or agent configurations were changed.',
    })
  })

  test('unwraps JSON that was merely fenced', () => {
    const raw = '```json\n{"short":"Swap the model","long":""}\n```'
    expect(JSON.parse(repairSummaryText(raw)!)).toEqual({
      short: 'Swap the model',
      long: '',
    })
  })

  test('strips inlined reasoning before reading the answer', () => {
    const raw =
      '<think>The user changed one config field, so keep it short.</think>\n' +
      'Set the chat trigger to the inline engine\n'
    expect(JSON.parse(repairSummaryText(raw)!)).toEqual({
      short: 'Set the chat trigger to the inline engine',
      long: '',
    })
  })

  test('a bare one-line answer becomes the subject', () => {
    expect(JSON.parse(repairSummaryText('Remove the OCR fallback.')!)).toEqual({
      short: 'Remove the OCR fallback',
      long: '',
    })
  })

  test('gives up on an empty response rather than inventing a summary', () => {
    expect(repairSummaryText('')).toBeNull()
    expect(repairSummaryText('   \n  ')).toBeNull()
    expect(repairSummaryText('<think>only reasoning, no answer</think>')).toBeNull()
    expect(repairSummaryText('```\n\n```')).toBeNull()
  })
})
