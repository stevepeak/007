import { describe, expect, test } from 'bun:test'

import { interpolateUserText } from '../engine/prompt-variables'

import {
  createDocumentTool,
  documentFilename,
  DOCX_MIME_TYPE,
  FactCheckFailedError,
  type GeneratedDocument,
  type StoredDocument,
} from './create-document-tool'
import type { DocumentModel } from './model'

type Deps = { orgId: string; hostFacts?: unknown }

const DOCUMENT: DocumentModel = {
  title: 'Demand for Payment — Sterling',
  letterhead: { subject: 'Unpaid invoice 4471', salutation: 'Dear Ms. Ruiz:' },
  blocks: [
    {
      type: 'paragraph',
      runs: [{ text: 'Invoice 4471 remains unpaid in the sum of $84,200.00.' }],
    },
  ],
}

const FACTS = ['Invoice 4471, issued 2025-11-02, amount $84,200.00']

/** Build the tool with a `store` that records what it was handed. */
function harness(opts?: { getFacts?: (deps: Deps) => unknown }) {
  const stored: GeneratedDocument[] = []
  const entry = createDocumentTool<Deps>({
    getFacts: opts?.getFacts,
    store: (_deps, document): Promise<StoredDocument> => {
      stored.push(document)
      return Promise.resolve({
        documentId: 'doc-1',
        filename: document.filename,
      })
    },
  })
  if (entry.kind !== 'ai-tool') throw new Error('expected an ai-tool')
  const built = entry.build({ orgId: 'org-1' })
  const call = (args: unknown): Promise<StoredDocument> =>
    // The AI SDK types `execute` loosely; the tool re-parses its own input.
    (built.execute as (a: unknown, o: unknown) => Promise<StoredDocument>)(
      args,
      {},
    )
  return { entry, call, stored }
}

describe('create_document — the happy path', () => {
  test('renders, stores, and returns only the identity', async () => {
    const { call, stored } = harness()
    const out = await call({ facts: FACTS, document: DOCUMENT })

    expect(out).toEqual({
      documentId: 'doc-1',
      filename: 'Demand-for-Payment-Sterling.docx',
    })
    // Never bytes: a workflow step return is capped around 1 MiB, and a .docx
    // crossing that boundary is how you blow it.
    expect(Object.keys(out).sort()).toEqual(['documentId', 'filename'])

    expect(stored.length).toBe(1)
    expect(stored[0].mimeType).toBe(DOCX_MIME_TYPE)
    expect(stored[0].bytes.byteLength).toBeGreaterThan(1_000)
    expect([stored[0].bytes[0], stored[0].bytes[1]]).toEqual([0x50, 0x4b])
    // The model travels with the bytes so a later edit has something to edit.
    expect(stored[0].model.title).toBe(DOCUMENT.title)
  })

  test('a total derived from the facts is allowed through', async () => {
    const { call, stored } = harness()
    await call({
      facts: ['Invoice 4471: $84,200.00', 'Invoice 4478: $12,630.00'],
      document: {
        title: 'Demand',
        blocks: [
          {
            type: 'paragraph',
            runs: [{ text: 'The total due is $96,830.00.' }],
          },
        ],
      },
    })
    expect(stored.length).toBe(1)
  })
})

describe('create_document — the guardrail', () => {
  test('a fabricated figure is a hard error, and nothing is stored', async () => {
    const { call, stored } = harness()
    const bad: DocumentModel = {
      title: 'Demand',
      blocks: [
        {
          type: 'paragraph',
          runs: [{ text: 'With interest the balance is $243,546.25.' }],
        },
      ],
    }

    const err = await call({ facts: FACTS, document: bad }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(FactCheckFailedError)
    expect((err as FactCheckFailedError).message).toContain('$243,546.25')
    // The retry instruction is the point: the agent has to abstain, not guess.
    expect((err as FactCheckFailedError).message).toContain('TBD')
    // Checked BEFORE rendering and storing, so a rejected document never has an
    // id anyone could link to.
    expect(stored).toEqual([])
  })

  test('host-supplied facts win over the ones the model restated', async () => {
    // The model lists its invention as a fact. Only facts from outside the model
    // can catch that, which is what `getFacts` is for.
    const { call, stored } = harness({ getFacts: () => FACTS })
    const err = await call({
      facts: [...FACTS, 'Accrued interest: $243,546.25'],
      document: {
        title: 'Demand',
        blocks: [
          { type: 'paragraph', runs: [{ text: 'You owe $243,546.25.' }] },
        ],
      },
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(FactCheckFailedError)
    expect(stored).toEqual([])
  })

  test('without host facts, the model at least has to declare its figures', async () => {
    // The weaker guarantee, stated explicitly so a change to it is deliberate.
    const { call, stored } = harness()
    await call({
      facts: [...FACTS, 'Accrued interest: $243,546.25'],
      document: {
        title: 'Demand',
        blocks: [
          { type: 'paragraph', runs: [{ text: 'You owe $243,546.25.' }] },
        ],
      },
    })
    expect(stored.length).toBe(1)
  })

  test('abstention passes and produces a real document', async () => {
    const { call, stored } = harness({ getFacts: () => ({}) })
    await call({
      facts: [],
      document: {
        title: 'Matter summary',
        blocks: [
          {
            type: 'table',
            header: ['Invoice', 'Amount'],
            rows: [['TBD', 'Not yet calculable from the current file']],
          },
        ],
      },
    })
    expect(stored.length).toBe(1)
  })
})

describe('create_document — registry metadata', () => {
  test('is an agent-callable write tool with both schemas declared', () => {
    const { entry } = harness()
    expect(entry.id).toBe('create_document')
    expect(entry.kind).toBe('ai-tool')
    // Under an eval's `simulate`, a write tool must not actually write.
    expect(entry.sideEffect).toBe('write')
    expect(entry.inputSchema).toBeDefined()
    expect(entry.outputSchema).toBeDefined()
  })
})

describe('documentFilename', () => {
  test('is readable, safe as a key segment, and never empty', () => {
    expect(documentFilename('Demand for Payment — Sterling')).toBe(
      'Demand-for-Payment-Sterling.docx',
    )
    expect(documentFilename('Halberd v. Sterling: engagement')).toBe(
      'Halberd-v.-Sterling-engagement.docx',
    )
    // No path separators can reach the object key.
    expect(documentFilename('a/b\\c')).toBe('abc.docx')
    expect(documentFilename('   ')).toBe('document.docx')
    expect(documentFilename('…')).toBe('document.docx')
  })
})

describe('the user-facing status label', () => {
  test('renders as prose, never as a leaked token or a dumped document', () => {
    // What the end user sees while the agent works, when the node's "inform
    // user" toggle is on. `interpolateUserText` reads TOP-LEVEL arg keys only,
    // so a nested `${document.title}` is not a token and would surface to the
    // user verbatim — and a bare `${document}` would stringify the whole
    // document into the feed.
    const { entry } = harness()
    const rendered = interpolateUserText(entry.statusLabel!, {
      facts: FACTS,
      document: DOCUMENT,
    })
    expect(rendered).toBe('Writing the document')
    expect(rendered).not.toContain('${')
    expect(rendered).not.toContain('{"')
  })
})
