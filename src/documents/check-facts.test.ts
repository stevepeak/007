import { describe, expect, test } from 'bun:test'

import {
  checkFacts,
  documentText,
  factCheckErrorMessage,
  factValues,
} from './check-facts'
import type { DocumentModel } from './model'

// The three invoice amounts the spike's demand-letter brief actually supplied,
// and the total the models correctly computed from them. `161,965` was the ONLY
// figure flagged across every correct document in the corpus, which is what the
// derivation allowance exists for.
const FACTS = {
  client: 'Halberd Components, Inc.',
  debtor: 'Sterling Fabrication LLC',
  invoices: [
    { number: '4471', issued: '2025-11-02', amount: 84_200 },
    { number: '4478', issued: '2025-11-16', amount: 12_630 },
    { number: '4502', issued: '2025-12-01', amount: 65_135 },
  ],
  interestRate: '1.5% per month',
  deadlineDays: 14,
}

const TOTAL = 84_200 + 12_630 + 65_135 // 161,965

function letter(blocks: DocumentModel['blocks']): DocumentModel {
  return {
    title: 'Demand for Payment',
    letterhead: {
      senderLines: ['ARTISIAN LAW, PLLC'],
      date: 'March 4, 2026',
      deliveryMethod: 'VIA CERTIFIED MAIL',
      recipientLines: ['Sterling Fabrication LLC'],
      subject: 'Unpaid invoices 4471, 4478, and 4502',
      salutation: 'Dear Ms. Ruiz:',
    },
    blocks,
  }
}

describe('checkFacts — a correct document', () => {
  test('a letter that states only supplied figures passes', () => {
    const doc = letter([
      {
        type: 'paragraph',
        runs: [
          {
            text: 'Three invoices remain unpaid, issued under the agreement of June 12, 2024.',
          },
        ],
      },
      {
        type: 'table',
        header: ['Invoice', 'Amount'],
        rows: [
          ['4471', '$84,200.00'],
          ['4478', '$12,630.00'],
          ['4502', '$65,135.00'],
        ],
      },
      {
        type: 'clause',
        level: 0,
        runs: [{ text: 'Payment is due within 14 days of this letter.' }],
      },
      {
        type: 'clause',
        level: 1,
        runs: [{ text: 'Interest accrues at 1.5% per month thereafter.' }],
      },
    ])
    const result = checkFacts(FACTS, doc)
    expect(result.unsupported).toEqual([])
    expect(result.ok).toBe(true)
    // The check is only worth anything if it actually looked at something.
    expect(result.checked).toBeGreaterThan(3)
  })

  test('the computed total is a legitimate derivation', () => {
    const doc = letter([
      {
        type: 'paragraph',
        runs: [
          {
            text: `The total now due is $${TOTAL.toLocaleString('en-US')}.00.`,
          },
        ],
      },
    ])
    expect(TOTAL).toBe(161_965)
    const result = checkFacts(FACTS, doc)
    expect(result.ok).toBe(true)
  })

  test('a partial sum of two invoices also derives', () => {
    const doc = letter([
      {
        type: 'paragraph',
        runs: [{ text: 'Invoices 4471 and 4478 alone total $96,830.00.' }],
      },
    ])
    expect(checkFacts(FACTS, doc).ok).toBe(true)
  })

  test('the same figure repeated is reported once, not once per mention', () => {
    const doc = letter([
      { type: 'paragraph', runs: [{ text: 'You owe $99,999.00.' }] },
      { type: 'paragraph', runs: [{ text: 'Again: $99,999.00.' }] },
      { type: 'heading', level: 1, text: 'The $99,999.00 demand' },
    ])
    expect(checkFacts(FACTS, doc).unsupported.length).toBe(1)
  })
})

describe('checkFacts — the fabrication the spike caught', () => {
  // The memo brief withheld the figures entirely; every model but one filled the
  // table with plausible inventions. These are the literal values it produced.
  const INVENTED = ['$84,200', '$12,630', '$96,830', '$7,919.06', '$69,669.06']

  test('every invented figure is flagged when no facts were supplied', () => {
    const doc: DocumentModel = {
      title: 'Matter summary',
      blocks: [
        {
          type: 'table',
          header: ['Invoice', 'Amount', 'Interest', 'Balance'],
          rows: [
            ['4471', INVENTED[0], INVENTED[3], INVENTED[4]],
            ['4478', INVENTED[1], '$0.00', INVENTED[2]],
          ],
        },
      ],
    }
    // The brief supplied prose context and no numbers at all.
    const result = checkFacts({ matter: 'Halberd v. Sterling' }, doc)
    expect(result.ok).toBe(false)
    const flagged = result.unsupported.map((f) => f.text)
    for (const value of INVENTED) expect(flagged).toContain(value)
    // The invoice identifiers are fabricated too — four digits, not a year.
    expect(flagged).toContain('4471')
  })

  test('a fabricated total is caught even when the parts are real', () => {
    // 243,546.25 is not any subset sum of the three supplied amounts.
    const doc = letter([
      {
        type: 'paragraph',
        runs: [{ text: 'With interest the balance is $243,546.25.' }],
      },
    ])
    const result = checkFacts(FACTS, doc)
    expect(result.ok).toBe(false)
    expect(result.unsupported[0].text).toBe('$243,546.25')
    // The context has to be usable — it is what the agent gets told.
    expect(result.unsupported[0].context).toContain('balance is')
  })
})

describe('checkFacts — abstention passes', () => {
  test('TBD and "not calculable" are correct behaviour, not failures', () => {
    // What gpt-54-mini did instead of inventing: emit the table, abstain in it.
    const doc: DocumentModel = {
      title: 'Matter summary',
      blocks: [
        {
          type: 'table',
          header: ['Invoice', 'Amount'],
          rows: [
            ['TBD', 'TBD'],
            ['TBD', 'Not yet calculable from the current file'],
          ],
        },
        {
          type: 'paragraph',
          runs: [{ text: 'The outstanding balance is $___ pending the file.' }],
        },
      ],
    }
    const result = checkFacts({ matter: 'Halberd v. Sterling' }, doc)
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(0)
  })
})

describe('checkFacts — normalization and what is exempt', () => {
  test('$525, $525.00 and 525.00 are one fact', () => {
    for (const written of ['$525', '$525.00', '525.00', '$ 525']) {
      const doc: DocumentModel = {
        title: 'Fee',
        blocks: [
          { type: 'paragraph', runs: [{ text: `The fee is ${written}.` }] },
        ],
      }
      expect(checkFacts({ fee: 525 }, doc).ok).toBe(true)
    }
  })

  test('small plain numbers, years, and rates are not claims about money', () => {
    // No letterhead: this fixture is about the prose alone.
    const doc: DocumentModel = {
      title: 'Terms',
      blocks: [
        {
          type: 'clause',
          level: 0,
          runs: [
            {
              text: 'Under section 4, payment is due within thirty (30) days at 1.5% per month, per the agreement dated June 12, 2024.',
            },
          ],
        },
      ],
    }
    // Facts mention none of 4, 30, 1.5, 12 or 2024 — and none should be flagged.
    expect(checkFacts({ matter: 'x' }, doc).unsupported).toEqual([])
  })

  test('a grouped or dollar-prefixed figure is checked whatever its size', () => {
    const doc: DocumentModel = {
      title: 'Costs',
      blocks: [
        {
          type: 'paragraph',
          runs: [{ text: 'A filing fee of $402 applies.' }],
        },
      ],
    }
    // Under 1,000, but it carries a `$` — this is exactly a money claim.
    const result = checkFacts({ matter: 'x' }, doc)
    expect(result.unsupported.map((f) => f.text)).toEqual(['$402'])
  })

  test('a figure split across styled runs still reads as one number', () => {
    const doc = letter([
      {
        type: 'paragraph',
        runs: [
          { text: 'The total is $' },
          { text: '84,200', bold: true },
          { text: '.00 as stated.' },
        ],
      },
    ])
    // Supported: it is one of the invoice amounts, not "84" plus "200".
    expect(checkFacts(FACTS, doc).ok).toBe(true)
  })
})

describe('checkFacts — coverage of the whole document', () => {
  test('the letterhead, title, and signature blocks are checked too', () => {
    const doc: DocumentModel = {
      title: 'Demand for $77,777.00',
      letterhead: { subject: 'Unpaid invoice 8888' },
      blocks: [
        { type: 'signature', name: 'Mark Halloran', title: 'Attorney #6543' },
      ],
    }
    const flagged = checkFacts(FACTS, doc).unsupported.map((f) => f.text)
    expect(flagged).toContain('$77,777.00')
    expect(flagged).toContain('8888')
    expect(flagged).toContain('6543')
  })

  test('a host-defined block is walked generically rather than skipped', () => {
    const doc = {
      title: 'With an exhibit',
      blocks: [{ type: 'exhibit', caption: 'Exhibit A — $55,000.00 claimed' }],
    } as unknown as DocumentModel
    expect(checkFacts(FACTS, doc).unsupported.map((f) => f.text)).toEqual([
      '$55,000.00',
    ])
  })

  test('documentText reads blocks in order', () => {
    const doc = letter([
      { type: 'heading', level: 1, text: 'First' },
      { type: 'paragraph', runs: [{ text: 'Second' }] },
      { type: 'pageBreak' },
    ])
    const text = documentText(doc)
    expect(text.indexOf('First')).toBeLessThan(text.indexOf('Second'))
  })
})

describe('factValues', () => {
  test('pulls numbers out of nested objects, arrays, and strings alike', () => {
    const values = factValues(FACTS)
    expect(values).toContain(84_200)
    expect(values).toContain(65_135)
    // From the string "4471", and from "1.5% per month".
    expect(values).toContain(4471)
    expect(values).toContain(1.5)
  })
})

describe('factCheckErrorMessage', () => {
  test('names every figure and tells the agent to abstain instead', () => {
    const doc = letter([
      { type: 'paragraph', runs: [{ text: 'The balance is $243,546.25.' }] },
    ])
    const message = factCheckErrorMessage(checkFacts(FACTS, doc))
    expect(message).toContain('$243,546.25')
    expect(message).toContain('TBD')
    expect(message).toContain('not yet calculable')
  })
})
