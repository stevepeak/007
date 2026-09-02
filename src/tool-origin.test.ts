import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import { createDocumentTool } from './documents/create-document-tool'
import { createTavilyTool } from './tools/tavily'

// `ToolMeta.origin` defaults to `host`, and that default is load-bearing: it is
// what lets a deployment register a tool without thinking about provenance and
// still have the console tell the truth about who wrote it.
//
// The cost of that default is that every tool the SDK ships has to opt IN, at
// its own factory. Miss one and it files itself under the host's own work — no
// type error, no failing behaviour, just a Tools page that calls a built-in
// custom and a `get_tool_catalog` that sends a model looking for a file that
// isn't in the repo. This is the thing that notices.
//
// Add a factory to the SDK → add it here.

const SDK_TOOL_FACTORIES = {
  tavily_search: () => createTavilyTool<unknown>({ getApiKey: () => 'k' }),
  create_document: () =>
    createDocumentTool<unknown>({ store: () => Promise.resolve({}) as never }),
}

describe('tools the SDK ships', () => {
  for (const [id, build] of Object.entries(SDK_TOOL_FACTORIES)) {
    test(`${id} declares origin: 'sdk'`, () => {
      const entry = build()
      expect(entry.id).toBe(id)
      expect(entry.origin).toBe('sdk')
    })
  }

  // Renaming a built-in is a labelling choice a host is free to make; it does
  // not transfer authorship, and the console must not claim it does.
  test('a host renaming a built-in does not make it the host’s', () => {
    const renamed = createDocumentTool<unknown>({
      store: () => Promise.resolve({}) as never,
      id: 'draft_letter',
      name: 'Draft Letter',
    })
    expect(renamed.id).toBe('draft_letter')
    expect(renamed.origin).toBe('sdk')
  })

  // `createExtractTextTool` is the third SDK factory and cannot be CALLED from
  // here: this project compiles with bun's types alongside the Workers ones, and
  // under bun's global `fetch` (which has `preconnect`) a `Fetcher` no longer
  // satisfies @cloudflare/puppeteer's `BrowserWorker` — so merely importing
  // `cloudflare/extract-text.ts` fails `tsc -p tsconfig.test.json` on a line
  // this test has no business touching. Read the source instead, the way
  // `package-exports.test.ts` does: cruder than a call, but it still fails when
  // someone adds a factory and forgets the field, which is the whole job.
  test('extract_text declares it too', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./cloudflare/extract-text.ts', import.meta.url)),
      'utf8',
    )
    // Anchored to the registry entry — `id:` then `origin:` with nothing but
    // the comment between — so a stray `origin: 'sdk'` elsewhere can't pass it.
    expect(src).toMatch(
      /id: opts\.id \?\? 'extract_text',\n(?:\s*\/\/.*\n)*\s*origin: 'sdk',/,
    )
  })
})
