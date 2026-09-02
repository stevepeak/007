// `@stevepeak/007/documents` — the document model an agent authors and the
// deterministic renderer that turns it into `.docx` bytes.
//
// Deliberately free of any host or Cloudflare type: what to do with the bytes
// (put them in R2, write a row, hand back a download link) is the host's half of
// the feature, and lives outside the SDK.
//
// `docx` is an optional peer dependency — importing this subpath is what opts a
// host into it.

export {
  createDocumentTool,
  documentFilename,
  DOCX_MIME_TYPE,
  FactCheckFailedError,
  type CreateDocumentToolOptions,
  type GeneratedDocument,
  type StoredDocument,
} from './create-document-tool'
export {
  checkFacts,
  documentText,
  factCheckErrorMessage,
  factValues,
  type FactCheckResult,
  type UnsupportedFigure,
} from './check-facts'
export {
  documentBlockSchema,
  documentLetterheadSchema,
  documentModelSchema,
  documentModelSchemaWith,
  documentRunSchema,
  type DocumentBlock,
  type DocumentLetterhead,
  type DocumentModel,
  type DocumentRun,
  type ExtraBlockSchema,
} from './model'
export {
  type BlockRenderer,
  renderDocx,
  type RenderContext,
  type RenderDocxOptions,
  stripReLabel,
} from './render-docx'
