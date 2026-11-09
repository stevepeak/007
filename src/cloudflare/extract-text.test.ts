import { describe, expect, test } from 'bun:test'

import {
  createExtractTextTool,
  looksLikeScannedPdf,
  stripMarkdownMetadata,
} from './extract-text'

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

describe('transformBytes', () => {
  test('toMarkdown reads the transformed bytes; plain text skips it', async () => {
    const files: Record<string, string> = { 'a.bin': 'raw', 'b.txt': 'raw' }
    const bucket = {
      get: async (key: string) => {
        return { arrayBuffer: async () => new TextEncoder().encode(files[key]).buffer }
      },
    }
    const ai = {
      toMarkdown: async (input: { name: string; blob: Blob }[]) => {
        return [{ name: input[0].name, data: await input[0].blob.text() }]
      },
    }
    const run = createExtractTextTool<null>({
      getBucket: () => bucket as unknown as R2Bucket,
      getAI: () => ai as unknown as Ai,
      transformBytes: async () => new TextEncoder().encode('transformed'),
    }).build(null) as (args: unknown) => Promise<unknown>

    const bin = (await run({ source: 'a.bin', filename: 'a.bin' })) as {
      text: string
    }
    expect(bin.text).toBe('transformed')
    const txt = (await run({ source: 'b.txt', filename: 'b.txt' })) as {
      text: string
    }
    expect(txt.text).toBe('raw')
  })
})
