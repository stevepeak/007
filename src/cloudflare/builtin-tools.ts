// The tools 007 registers on its own — `extract_text` and `create_document` —
// wired to fixed Worker binding names, so a host gets them without writing any
// tool code. `defineWfConfig` from the package root (`src/index.ts`) merges them
// into every config; the engine's own `defineWfConfig` stays unchanged, because
// `engine` may not import this layer.
//
// Binding contract (on every Worker that runs tools — the workflows Worker, and
// the web Worker that serves tool/agent previews):
//
//   UPLOADS  R2 bucket   uploaded files `extract_text` reads (by key); where
//                        `create_document` writes and large extractions spill
//   AI       Workers AI  `toMarkdown` and the default vision OCR
//   BROWSER  Browser     optional — rasterizes scanned PDFs for OCR
//
// A missing binding fails the CALL with an error naming it; the tool is still
// listed. A host that registers its own entry under either id keeps it — that
// is the override, e.g. to point at another bucket or record a row per document.
//
// WHY THE ENV IS CAPTURED FROM `buildRunDeps`. A tool's `build` receives only
// the host's opaque `TDeps`, never the Worker env, and the SDK can't read
// bindings out of a type it doesn't know. Every run builds its deps through
// `buildRunDeps(ctx)`, and `ctx.env` is right there — so the wrapper below
// remembers that env against the deps object it returned, and the built-ins
// look it up. Keyed weakly, so a finished run's env is collectable.

import { createDocumentTool } from '../documents/create-document-tool'
import {
  defineWfConfig as defineEngineConfig,
  type WfSdkConfig,
} from '../engine/config'
import type { ToolRegistryEntry } from '../engine/tool-registry'

import { createR2BlobResolver } from './blob-resolver'
import { createExtractTextTool } from './extract-text'

/** The bindings the built-ins read off the run's Worker env. */
type BuiltinBindings = {
  UPLOADS?: R2Bucket
  AI?: Ai
  BROWSER?: Fetcher
}

// `RunContext.env` is `unknown` to the SDK; the binding lookups narrow it.
const runEnvs = new WeakMap<object, unknown>()

function envOf(deps: unknown): BuiltinBindings {
  const env =
    typeof deps === 'object' && deps !== null ? runEnvs.get(deps) : undefined
  if (typeof env !== 'object' || env === null) {
    throw new Error(
      "007 built-in tools need `buildRunDeps` to return an object (they find the run's bindings through it).",
    )
  }
  return env
}

function binding<K extends keyof BuiltinBindings>(
  deps: unknown,
  name: K,
): NonNullable<BuiltinBindings[K]> {
  const value = envOf(deps)[name]
  if (!value) {
    throw new Error(
      `007 built-in tools need the \`${name}\` binding on this Worker — see the binding contract in cloudflare/builtin-tools.ts.`,
    )
  }
  return value
}

/** `create_document` storage: the `.docx` and its model, side by side in R2. */
async function storeDocument(
  deps: unknown,
  document: Parameters<Parameters<typeof createDocumentTool>[0]['store']>[1],
): Promise<{ documentId: string; filename: string }> {
  const documentId = crypto.randomUUID()
  const prefix = `documents/${documentId}`
  const bucket = binding(deps, 'UPLOADS')
  await bucket.put(`${prefix}/${document.filename}`, document.bytes, {
    httpMetadata: { contentType: document.mimeType },
  })
  // The model is the editable source; the bytes are its output.
  await bucket.put(`${prefix}/model.json`, JSON.stringify(document.model), {
    httpMetadata: { contentType: 'application/json' },
  })
  return { documentId, filename: document.filename }
}

/** The built-in registry entries, bound to the binding contract above. */
export function builtinToolEntries<TDeps>(): ToolRegistryEntry<TDeps>[] {
  return [
    createExtractTextTool<TDeps>({
      getBucket: (deps) => binding(deps, 'UPLOADS'),
      getAI: (deps) => binding(deps, 'AI'),
      // Optional: without it a scanned PDF returns its (empty) text layer.
      getBrowser: (deps) => envOf(deps).BROWSER,
    }),
    createDocumentTool<TDeps>({ store: storeDocument }),
  ]
}

/**
 * {@link defineEngineConfig} plus the built-ins: validates the host config,
 * then joins `extract_text` / `create_document` into its registry (host entries
 * win on an id collision) and, unless the host set one, a `resolveBlobRef` that
 * reads `extract_text`'s spilled text back from `UPLOADS`.
 */
export function defineWfConfig<TDeps = unknown>(
  config: WfSdkConfig<TDeps>,
): WfSdkConfig<TDeps> {
  const validated = defineEngineConfig(config)
  const toolRegistry = new Map(validated.toolRegistry)
  for (const entry of builtinToolEntries<TDeps>()) {
    if (!toolRegistry.has(entry.id)) toolRegistry.set(entry.id, entry)
  }
  return {
    ...validated,
    toolRegistry,
    buildRunDeps: async (ctx) => {
      const deps = await validated.buildRunDeps(ctx)
      if (typeof deps === 'object' && deps !== null && ctx.env) {
        runEnvs.set(deps, ctx.env)
      }
      return deps
    },
    resolveBlobRef:
      validated.resolveBlobRef ??
      createR2BlobResolver<TDeps>({
        getBucket: (deps) => binding(deps, 'UPLOADS'),
      }),
  }
}
