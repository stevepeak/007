import { describe, expect, test } from 'bun:test'

import { looksLikeScannedPdf, stripMarkdownMetadata } from './extract-text'

// The shape Workers AI `toMarkdown` returns for a PDF.
const PDF_MARKDOWN = `# report.pdf
## Metadata
- PDFFormatVersion=1.7
- CreationDate=D:20260101120000Z
- pdf:producer=Some Producer v10
- xmpmm:documentid=uuid:1234

## Contents
### Page 1
First page body text.
### Page 2
Second page body text.
`

describe('stripMarkdownMetadata', () => {
  test('drops the metadata block and keeps the body', () => {
    const out = stripMarkdownMetadata(PDF_MARKDOWN)
    expect(out).not.toContain('Metadata')
    expect(out).not.toContain('pdf:producer')
    expect(out).not.toContain('CreationDate')
    expect(out).toContain('## Contents')
    expect(out).toContain('First page body text.')
    expect(out).toContain('Second page body text.')
  })

  test('drops a metadata block that runs to EOF', () => {
    expect(
      stripMarkdownMetadata('# a.pdf\n## Metadata\n- Title=x\n').trim(),
    ).toBe('# a.pdf')
  })

  test('leaves markdown without a metadata block unchanged', () => {
    const md = '# a.docx\n\nHello world.\n'
    expect(stripMarkdownMetadata(md)).toBe(md)
  })
})

describe('looksLikeScannedPdf', () => {
  test('metadata alone does not count as body text', () => {
    const scanned = `# s.pdf
## Metadata
- ${'pdf:producer=A very long producer string '.repeat(10)}

## Contents
### Page 1
### Page 2
`
    expect(looksLikeScannedPdf(scanned)).toBe(true)
    expect(looksLikeScannedPdf(PDF_MARKDOWN, { minCharsPerPage: 10 })).toBe(
      false,
    )
  })
})
