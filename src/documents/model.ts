// The document model — the constrained shape an agent authors, and the only
// input the renderer accepts.
//
// THE ARCHITECTURAL POINT: a model never emits OOXML. It fills in this schema,
// and a deterministic renderer turns that into `.docx` bytes. XML written by a
// language model is subtly invalid in ways Word reports as "the file is corrupt
// and cannot be opened" — unrecoverable and unreviewable. A validated JSON model
// fails at the tool boundary instead, where the failure is legible; it is
// diffable, re-renderable into other formats, and it is the same value a
// letterhead template later consumes.
//
// The vocabulary is deliberately CLOSED and small. Every block here earned its
// place in a real document (demand letter, engagement letter, matter memo); the
// seam for anything else is `extraBlocks` below, not a new optional field.
//
// AUTHORING NOTE: every optional is `.nullish()`, never `.optional()`. Providers
// constrain structured output with a strict JSON Schema dialect in which every
// property is required, so an "absent" field is one the model answers with
// `null`. See `../engine/strict-schema`.

import { z } from 'zod'

/** A span of text with optional emphasis. The smallest unit an agent writes. */
export const documentRunSchema = z.object({
  text: z.string().describe('The literal text of this span.'),
  bold: z.boolean().nullish().describe('Bold this span. Null for normal.'),
  italic: z
    .boolean()
    .nullish()
    .describe('Italicize this span. Null for normal.'),
  underline: z
    .boolean()
    .nullish()
    .describe('Underline this span. Null for normal.'),
})

export type DocumentRun = z.infer<typeof documentRunSchema>

const runs = z
  .array(documentRunSchema)
  .describe('The text of this block, as one or more styled spans.')

/**
 * The letter head matter: who is writing, to whom, about what.
 *
 * Rendered by the renderer in the conventional order — sender block, date,
 * delivery method, recipient block, `Re:` line, salutation — so an agent never
 * has to know the layout, only the facts.
 */
export const documentLetterheadSchema = z.object({
  senderLines: z
    .array(z.string())
    .nullish()
    .describe(
      'The sender block, one line per line: firm name, street, city/state/zip, phone. Null to omit.',
    ),
  date: z
    .string()
    .nullish()
    .describe('The letter date, already formatted (e.g. "March 4, 2026").'),
  deliveryMethod: z
    .string()
    .nullish()
    .describe(
      'How the letter is sent, e.g. "VIA CERTIFIED MAIL, RETURN RECEIPT REQUESTED". Null to omit.',
    ),
  recipientLines: z
    .array(z.string())
    .nullish()
    .describe('The addressee block, one line per line. Null to omit.'),
  subject: z
    .string()
    .nullish()
    .describe(
      'The subject of the letter WITHOUT a "Re:" prefix — the renderer writes the "Re:" itself.',
    ),
  salutation: z
    .string()
    .nullish()
    .describe('The greeting, e.g. "Dear Mr. Alvarez:". Null to omit.'),
})

export type DocumentLetterhead = z.infer<typeof documentLetterheadSchema>

const headingBlockSchema = z.object({
  type: z.literal('heading'),
  level: z
    .literal([1, 2, 3])
    .describe('1 for a section, 2 for a subsection, 3 below that.'),
  text: z.string().describe('The heading text.'),
})

const paragraphBlockSchema = z.object({
  type: z.literal('paragraph'),
  runs,
})

const clauseBlockSchema = z.object({
  type: z.literal('clause'),
  level: z
    .literal([0, 1, 2])
    .describe(
      'Depth of this clause: 0 for a top-level clause (1.), 1 for a sub-clause (1.1), 2 for (1.1.1). NEVER type the number yourself — the renderer numbers clauses.',
    ),
  runs,
})

const listBlockSchema = z.object({
  type: z.literal('list'),
  ordered: z
    .boolean()
    .nullish()
    .describe('True for a numbered list, null or false for bullets.'),
  items: z.array(z.object({ runs })).describe('The list items, in order.'),
})

const tableBlockSchema = z.object({
  type: z.literal('table'),
  header: z
    .array(z.string())
    .nullish()
    .describe('Column headings. Null for a table with no header row.'),
  rows: z
    .array(z.array(z.string()))
    .describe('The body rows; each row is one cell value per column.'),
})

const pageBreakBlockSchema = z.object({
  type: z.literal('pageBreak'),
})

const signatureBlockSchema = z.object({
  type: z.literal('signature'),
  closing: z
    .string()
    .nullish()
    .describe('The complimentary close, e.g. "Sincerely,". Null to omit.'),
  name: z.string().describe('The name that signs the document.'),
  title: z.string().nullish().describe("The signer's title. Null to omit."),
  organization: z
    .string()
    .nullish()
    .describe("The signer's firm or company. Null to omit."),
})

/**
 * A line someone SIGNS — a rule to sign on, a printed name under it, and
 * optionally a dated line beside it.
 *
 * Distinct from `signature`, which is the letter-writer's own sign-off. Without
 * this block an engagement letter can only fake one out of underscores, which is
 * what the spike's output did and why it did not survive contact with Word.
 */
const signatureLineBlockSchema = z.object({
  type: z.literal('signatureLine'),
  label: z
    .string()
    .nullish()
    .describe('Who signs here, e.g. "CLIENT" or "ARTISIAN LAW, PLLC".'),
  name: z
    .string()
    .nullish()
    .describe('The printed name under the rule. Null for a blank line.'),
  title: z.string().nullish().describe('The printed title. Null to omit.'),
  includeDate: z
    .boolean()
    .nullish()
    .describe('True to add a dated line beside the signature rule.'),
})

/** Every built-in block, in the order they are documented. */
const BUILT_IN_BLOCKS = [
  headingBlockSchema,
  paragraphBlockSchema,
  clauseBlockSchema,
  listBlockSchema,
  tableBlockSchema,
  pageBreakBlockSchema,
  signatureBlockSchema,
  signatureLineBlockSchema,
] as const

/**
 * A host-defined block: any object whose `type` is a literal string, so it can
 * join the discriminated union. Pair it with a renderer of the same `type` in
 * `renderDocx`'s `extraRenderers` — the two halves are checked at render time,
 * not here, since a schema and a renderer can be registered from different
 * places.
 */
export type ExtraBlockSchema = z.ZodObject<{ type: z.ZodLiteral<string> }>

export const documentBlockSchema = z.discriminatedUnion('type', BUILT_IN_BLOCKS)

export type DocumentBlock = z.infer<typeof documentBlockSchema>

/** The whole document: a name, optional head matter, and a flat block list. */
export const documentModelSchema = z.object({
  title: z
    .string()
    .describe(
      'The document title. Used as the file name and Word document property; printed at the top only when there is no letterhead.',
    ),
  letterhead: documentLetterheadSchema
    .nullish()
    .describe('Letter head matter. Null for a memo, report, or agreement.'),
  blocks: z
    .array(documentBlockSchema)
    .describe('The body of the document, in order.'),
})

export type DocumentModel = z.infer<typeof documentModelSchema>

/**
 * The document schema widened with host-defined block types.
 *
 * The seam exists so a host can add (say) an `exhibitList` block without forking
 * the SDK. It is cheap to leave open and expensive to retrofit — a closed union
 * baked into a stored tool schema is a migration, not an edit. Nothing in the
 * SDK calls this today.
 *
 * The returned schema validates extras structurally; `renderDocx` must be given
 * a matching `extraRenderers` entry or it throws on the unknown block, which is
 * the loud failure we want over a block silently dropped from the output.
 */
export function documentModelSchemaWith(
  extraBlocks: readonly ExtraBlockSchema[],
): z.ZodType<DocumentModel> {
  if (extraBlocks.length === 0) return documentModelSchema
  // The cast is the price of a runtime-built discriminated union: zod types the
  // member list as a tuple of known shapes, and the extras are only known to the
  // host. The discriminator is still enforced at runtime by
  // `discriminatedUnion` itself.
  const union = z.discriminatedUnion('type', [
    ...BUILT_IN_BLOCKS,
    ...extraBlocks,
  ] as unknown as typeof BUILT_IN_BLOCKS)
  return documentModelSchema.extend({ blocks: z.array(union) })
}
