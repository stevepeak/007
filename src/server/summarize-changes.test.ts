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

  // Observed on a real publish: the recorded summary for the version was
  // "Let me compare the two versions:" and nothing else — the model's opening
  // line became the subject, and the actual content was pushed into the body
  // where the version history never shows it.
  test('skips a conversational lead-in rather than publishing it', () => {
    const raw =
      'Let me compare the two versions:\n' +
      '\n' +
      'Point the triage node at the decision agent\n' +
      '\n' +
      '- The agent node now names the ART-238 agent.\n'
    expect(JSON.parse(repairSummaryText(raw)!)).toEqual({
      short: 'Point the triage node at the decision agent',
      long: '- The agent node now names the ART-238 agent.',
    })
  })

  test('skips a markdown heading used as a lead-in', () => {
    const raw = '## Summary of changes\n\nSwap the model\n'
    expect(JSON.parse(repairSummaryText(raw)!)).toEqual({
      short: 'Swap the model',
      long: '',
    })
  })

  test('drops a bullet marker from the subject it keeps', () => {
    expect(JSON.parse(repairSummaryText('- Swap the model')!)).toEqual({
      short: 'Swap the model',
      long: '',
    })
  })

  test('a one-line answer is never discarded for nothing', () => {
    // Ends in a colon and so READS as a lead-in, but there is nothing after it.
    // Better a slightly odd subject than a null summary.
    expect(JSON.parse(repairSummaryText('Changes:')!)).toEqual({
      short: 'Changes:',
      long: '',
    })
  })

  test('a real subject beginning "Changes" survives', () => {
    // "changes" is deliberately not a lead-in word: skipping this would replace
    // a correct subject with the line below it.
    const raw = 'Changes the output contract\n\nNow returns an object.\n'
    expect(JSON.parse(repairSummaryText(raw)!)).toEqual({
      short: 'Changes the output contract',
      long: 'Now returns an object.',
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
    expect(
      repairSummaryText('<think>only reasoning, no answer</think>'),
    ).toBeNull()
    expect(repairSummaryText('```\n\n```')).toBeNull()
  })
})
