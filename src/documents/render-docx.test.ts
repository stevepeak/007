import { inflateRawSync } from 'node:zlib'

import { describe, expect, test } from 'bun:test'
import { Paragraph, TextRun } from 'docx'
import { z } from 'zod'

import {
  documentModelSchema,
  documentModelSchemaWith,
  type DocumentModel,
} from './model'
import { renderDocx, stripReLabel } from './render-docx'

// A `.docx` is a ZIP of XML parts, so the only honest assertion about a renderer
// is one made against the parts themselves. Reading the archive here rather than
// pulling in a zip library keeps the test dependency-free — and the reader is
// 30 lines because we only ever read archives this file just produced.
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // End of central directory: scan back for its signature.
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06_05_4b_50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)

  const out = new Map<string, string>()
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    )

    // The local header repeats the name and carries its own extra field, whose
    // length differs from the central one — read it, don't assume it.
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = bytes.subarray(start, start + compressedSize)
    out.set(name, decoder.decode(method === 8 ? inflateRawSync(raw) : raw))

    cursor += 46 + nameLength + extraLength + commentLength
  }
  return out
}

/** Every `w:numId` value in document order — how a clause says which list it is
 * counting in, and therefore the only way to see a restart from the outside. */
function numIds(documentXml: string): string[] {
  return [...documentXml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1])
}

// One fixture exercising EVERY block type, so a change that breaks a block the
// current documents happen not to use still fails here.
const FIXTURE: DocumentModel = {
  title: 'Demand for Payment — Sterling Fabrication',
  letterhead: {
    senderLines: ['ARTISIAN LAW, PLLC', '100 Main Street', 'Austin, TX 78701'],
    date: 'March 4, 2026',
    deliveryMethod: 'VIA CERTIFIED MAIL, RETURN RECEIPT REQUESTED',
    recipientLines: ['Dana Ruiz', 'Sterling Fabrication', 'Dallas, TX 75201'],
    // The model wrote the label into the value; the renderer must not repeat it.
    subject: 'Re: Unpaid invoices 4471, 4478, 4502',
    salutation: 'Dear Ms. Ruiz:',
  },
  blocks: [
    {
      type: 'paragraph',
      runs: [
        { text: 'This firm represents ' },
        { text: 'Halberd Components, Inc.', bold: true },
        { text: ' in connection with the invoices below.' },
      ],
    },
    { type: 'heading', level: 1, text: 'The amounts owed' },
    {
      type: 'table',
      header: ['Invoice', 'Issued', 'Amount'],
      rows: [
        ['4471', 'Nov 2, 2025', '$18,400.00'],
        ['4478', 'Nov 16, 2025', '$9,250.00'],
      ],
    },
    {
      type: 'clause',
      level: 0,
      runs: [{ text: 'Payment was due thirty days from issuance.' }],
    },
    {
      type: 'clause',
      level: 1,
      runs: [{ text: 'Interest accrues at 1.5% per month thereafter.' }],
    },
    {
      type: 'clause',
      level: 2,
      runs: [{ text: 'Compounded monthly, per section 4 of the agreement.' }],
    },
    { type: 'heading', level: 2, text: 'What we require' },
    {
      type: 'clause',
      level: 0,
      runs: [{ text: 'Payment in full within fourteen days.' }],
    },
    {
      type: 'list',
      ordered: true,
      items: [
        { runs: [{ text: 'Wire transfer to the account on file.' }] },
        { runs: [{ text: 'A certified check delivered to this office.' }] },
      ],
    },
    {
      type: 'list',
      ordered: false,
      items: [{ runs: [{ text: 'Partial payments will not be accepted.' }] }],
    },
    { type: 'pageBreak' },
    {
      type: 'signature',
      closing: 'Sincerely,',
      name: 'Mark Halloran',
      title: 'Managing Attorney',
      organization: 'Artisian Law, PLLC',
    },
    {
      type: 'signatureLine',
      label: 'ACKNOWLEDGED AND AGREED',
      name: 'Dana Ruiz',
      title: 'President, Sterling Fabrication',
      includeDate: true,
    },
  ],
}

describe('renderDocx', () => {
  test('the fixture renders a valid, complete OOXML package', async () => {
    const bytes = await renderDocx(FIXTURE)
    expect(bytes.byteLength).toBeGreaterThan(5_000)
    // PK zip magic — Word rejects anything else outright.
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b])

    const parts = unzip(bytes)
    expect(parts.size).toBeGreaterThan(15)
    for (const required of [
      '[Content_Types].xml',
      'word/document.xml',
      'word/numbering.xml',
      'word/styles.xml',
      'docProps/core.xml',
    ]) {
      expect(parts.has(required)).toBe(true)
    }

    const xml = parts.get('word/document.xml')!
    // Every block type put its text on the page.
    for (const text of [
      'Halberd Components, Inc.',
      'The amounts owed',
      '$18,400.00',
      'Interest accrues',
      'Wire transfer to the account on file.',
      'Partial payments will not be accepted.',
      'Sincerely,',
      'Mark Halloran',
      'ACKNOWLEDGED AND AGREED',
    ]) {
      expect(xml).toContain(text)
    }
    // The page break and both tables (data + the signature/date layout) exist.
    expect(xml).toContain('w:type="page"')
    expect([...xml.matchAll(/<w:tbl>/g)].length).toBe(2)
  })

  test('clause numbering restarts under each heading', async () => {
    const parts = unzip(await renderDocx(FIXTURE))
    const ids = numIds(parts.get('word/document.xml')!)
    // Three clauses in section 1, then a heading, then one clause in section 2.
    const [a, b, c, d] = ids
    expect(a).toBe(b)
    expect(b).toBe(c)
    // The restart IS a new concrete numbering instance — same definition, new
    // counter. If this ever equals `c`, section 2 opens at "4." again.
    expect(d).not.toBe(c)

    // …and both instances are declared, pointing at the same abstract numbering
    // with the counter overridden back to 1 — which is what Word acts on.
    const numbering = parts.get('word/numbering.xml')!
    for (const id of new Set(ids)) {
      expect(numbering).toContain(`<w:num w:numId="${id}"`)
    }
    expect(numbering).toContain('<w:startOverride w:val="1"/>')
  })

  test('clause levels number 1. / 1.1 / 1.1.1', async () => {
    const numbering = unzip(await renderDocx(FIXTURE)).get(
      'word/numbering.xml',
    )!
    for (const text of ['%1.', '%1.%2', '%1.%2.%3']) {
      expect(numbering).toContain(`<w:lvlText w:val="${text}"/>`)
    }
  })

  test('two ordered lists each start at 1', async () => {
    const model: DocumentModel = {
      title: 'Two lists',
      blocks: [
        { type: 'list', ordered: true, items: [{ runs: [{ text: 'one' }] }] },
        { type: 'list', ordered: true, items: [{ runs: [{ text: 'two' }] }] },
      ],
    }
    const parts = unzip(await renderDocx(model))
    const ids = numIds(parts.get('word/document.xml')!)
    expect(ids.length).toBe(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  test('the subject line is never doubled', async () => {
    const parts = unzip(await renderDocx(FIXTURE))
    const xml = parts.get('word/document.xml')!
    expect(xml).toContain('Re: Unpaid invoices 4471, 4478, 4502')
    expect(xml).not.toContain('Re: Re:')
  })

  test('a title is printed only when there is no letterhead', async () => {
    const withHead = unzip(await renderDocx(FIXTURE)).get('word/document.xml')!
    expect(withHead).not.toContain(FIXTURE.title)

    const memo: DocumentModel = {
      title: 'Matter summary — Halberd v. Sterling',
      blocks: [{ type: 'paragraph', runs: [{ text: 'Background.' }] }],
    }
    const withoutHead = unzip(await renderDocx(memo)).get('word/document.xml')!
    expect(withoutHead).toContain(memo.title)
  })

  test('an empty table is dropped rather than emitted as invalid XML', async () => {
    const model: DocumentModel = {
      title: 'Empty table',
      blocks: [{ type: 'table', header: null, rows: [] }],
    }
    const xml = unzip(await renderDocx(model)).get('word/document.xml')!
    expect(xml).not.toContain('<w:tbl>')
  })
})

describe('stripReLabel', () => {
  test('strips one or many labels, keeps the subject', () => {
    expect(stripReLabel('Re: Unpaid invoices')).toBe('Unpaid invoices')
    expect(stripReLabel('RE : Re: Unpaid invoices')).toBe('Unpaid invoices')
    expect(stripReLabel('  Unpaid invoices ')).toBe('Unpaid invoices')
    // A colon that isn't a label stays put.
    expect(stripReLabel('Deadline: March 4')).toBe('Deadline: March 4')
  })
})

describe('the extraBlocks / extraRenderers seam', () => {
  const exhibitBlock = z.object({
    type: z.literal('exhibit'),
    caption: z.string(),
  })

  test('a host block validates and renders without forking the SDK', async () => {
    const schema = documentModelSchemaWith([exhibitBlock])
    const parsed = schema.parse({
      title: 'With an exhibit',
      blocks: [{ type: 'exhibit', caption: 'Exhibit A — the agreement' }],
    })

    const bytes = await renderDocx(parsed, {
      extraRenderers: {
        exhibit: (block) => [
          new Paragraph({
            children: [new TextRun({ text: String(block.caption) })],
          }),
        ],
      },
    })
    const xml = unzip(bytes).get('word/document.xml')!
    expect(xml).toContain('Exhibit A — the agreement')
  })

  test('an unregistered block throws instead of vanishing', async () => {
    const model = { title: 'x', blocks: [{ type: 'exhibit' }] }
    await expect(renderDocx(model as DocumentModel)).rejects.toThrow(
      /No renderer for document block type 'exhibit'/,
    )
  })
})

describe('documentModelSchema', () => {
  test('a model that answers null for every optional still parses', () => {
    // What a provider actually sends under the strict schema dialect: every
    // property present, absent ones null. See `../engine/strict-schema`.
    const parsed = documentModelSchema.parse({
      title: 'Nulls everywhere',
      letterhead: {
        senderLines: null,
        date: null,
        deliveryMethod: null,
        recipientLines: null,
        subject: null,
        salutation: null,
      },
      blocks: [
        {
          type: 'paragraph',
          runs: [{ text: 'Body.', bold: null, italic: null, underline: null }],
        },
      ],
    })
    expect(parsed.blocks.length).toBe(1)
  })

  test('a clause level outside 0–2 is rejected at the boundary', () => {
    const bad = documentModelSchema.safeParse({
      title: 'x',
      blocks: [{ type: 'clause', level: 5, runs: [{ text: 'y' }] }],
    })
    expect(bad.success).toBe(false)
  })
})
