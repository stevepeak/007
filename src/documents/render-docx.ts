// The deterministic renderer: `DocumentModel` → `.docx` bytes.
//
// Pure. No bindings, no `fs`, no network — the whole thing is a function of its
// input, which is what makes it unit-testable without a Worker and safe to run
// in either one. The host half (R2, a `document` row, a download route) lives
// outside the SDK entirely.
//
// `docx` is an OPTIONAL peer dependency. It is imported statically here because
// `@stevepeak/007/documents` is its own subpath export: a host that never
// generates a document never imports this module and never pays for the library
// (measured: 369 KB raw / 106 KB gzip, zero Node builtins).
//
// TWO RULES THIS FILE OWNS, and the model never touches:
//
//   1. NUMBERING. The model supplies a clause `level`; the renderer supplies
//      every digit. A model that types "3.2" into its own text will eventually
//      type "3.2" twice, and multi-level legal numbering (1 / 1.1 / 1.1.1) is
//      the single most likely source of "this doesn't look like our documents".
//   2. LAYOUT. Where the date sits relative to the recipient block, what "Re:"
//      looks like, how far a signature rule runs. The model supplies facts.

import {
  AlignmentType,
  BorderStyle,
  convertInchesToTwip,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  type ParagraphChild,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'

import type {
  DocumentBlock,
  DocumentLetterhead,
  DocumentModel,
  DocumentRun,
} from './model'

/** Numbering reference for multi-level clause numbering (1. / 1.1 / 1.1.1). */
const CLAUSE_NUMBERING = 'wf-clause'
/** Numbering reference for an ordered `list` block. */
const LIST_NUMBERING = 'wf-list'

/** A rendered block is one or more body children — paragraphs and/or tables. */
type BodyChild = Paragraph | Table

/**
 * What a renderer may read and mutate while walking the block list.
 *
 * `nextInstance` is the whole reason this is a context object rather than a pure
 * per-block function: numbering restart is a property of the SEQUENCE, not of
 * any one block (see {@link RenderState}).
 */
export type RenderContext = {
  /** Render a run list to `docx` text runs — for a host-defined block. */
  runs: (runs: readonly DocumentRun[]) => TextRun[]
  /** Claim a fresh concrete numbering instance, restarting its counter at 1. */
  nextInstance: () => number
}

/**
 * A host-registered renderer for a block type the SDK does not know.
 *
 * Receives the block as authored — the host owns its shape, having supplied the
 * matching schema to `documentModelSchemaWith` — and returns the body children
 * to splice in at that position.
 */
export type BlockRenderer = (
  block: Record<string, unknown>,
  ctx: RenderContext,
) => readonly BodyChild[]

export type RenderDocxOptions = {
  /**
   * Renderers for host-defined block types, keyed by the block's `type`. The
   * other half of the `extraBlocks` seam on the model. An unknown block with no
   * renderer throws rather than being skipped — a document silently missing a
   * clause is worse than one that failed to render.
   */
  extraRenderers?: Readonly<Record<string, BlockRenderer>>
}

/** Mutable walk state. Only numbering needs any. */
type RenderState = {
  /**
   * The concrete numbering instance clauses are currently counting in.
   *
   * Word restarts a list when it is a NEW instance of the numbering definition,
   * so "clause numbering restarts under each heading" is expressed by claiming a
   * new instance at every heading rather than by any per-paragraph override.
   * Without this the first clause of section 2 continues at 6. — which is
   * exactly what the spike's engagement letter did.
   */
  clauseInstance: number
  /** Monotonic source of instance ids, shared by clauses and ordered lists. */
  instances: number
}

function textRuns(runs: readonly DocumentRun[]): TextRun[] {
  return runs.map(
    (r) =>
      new TextRun({
        text: r.text,
        bold: r.bold ?? false,
        italics: r.italic ?? false,
        underline: r.underline ? {} : undefined,
      }),
  )
}

const HEADING_BY_LEVEL = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const

/**
 * Strip a `Re:` (or `RE:` / `re :`) the model wrote into the subject itself.
 *
 * Models put the label in the value constantly — it reads like part of the
 * subject line — and the renderer prepends its own, so the letter went out
 * saying `Re: Re: Unpaid invoices`. Stripping here rather than rejecting in the
 * schema keeps a well-meaning model's letter renderable; the schema's
 * `.describe()` still asks for the bare subject.
 */
export function stripReLabel(subject: string): string {
  let out = subject.trim()
  // Loop, because "Re: Re: …" happens too.
  while (/^re\s*:/i.test(out)) {
    out = out.slice(out.indexOf(':') + 1).trim()
  }
  return out
}

function letterheadChildren(head: DocumentLetterhead): BodyChild[] {
  const out: BodyChild[] = []
  const line = (text: string, opts?: { bold?: boolean }) =>
    new Paragraph({
      children: [new TextRun({ text, bold: opts?.bold ?? false })],
    })

  for (const l of head.senderLines ?? []) out.push(line(l, { bold: true }))
  if (head.senderLines?.length) out.push(new Paragraph({}))
  if (head.date) out.push(line(head.date))
  if (head.deliveryMethod) {
    out.push(new Paragraph({}))
    out.push(line(head.deliveryMethod, { bold: true }))
  }
  if (head.recipientLines?.length) {
    out.push(new Paragraph({}))
    for (const l of head.recipientLines) out.push(line(l))
  }
  if (head.subject) {
    const subject = stripReLabel(head.subject)
    if (subject) {
      out.push(new Paragraph({}))
      out.push(
        new Paragraph({
          children: [new TextRun({ text: `Re: ${subject}`, bold: true })],
        }),
      )
    }
  }
  if (head.salutation) {
    out.push(new Paragraph({}))
    out.push(line(head.salutation))
  }
  if (out.length > 0) out.push(new Paragraph({}))
  return out
}

/** A ruled line to sign on: an empty paragraph carrying a bottom border. */
function signatureRule(widthInches: number): Paragraph {
  return new Paragraph({
    spacing: { before: 360 },
    // The rule is the paragraph's own bottom border, not a run of underscores —
    // underscores wrap, shift with the font, and are not a line to Word.
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: '000000' },
    },
    indent: { right: convertInchesToTwip(6.5 - widthInches) },
  })
}

function signatureLineChildren(block: {
  label?: string | null
  name?: string | null
  title?: string | null
  includeDate?: boolean | null
}): BodyChild[] {
  const stack = (widthInches: number): Paragraph[] => {
    const out: Paragraph[] = [signatureRule(widthInches)]
    if (block.name) {
      out.push(new Paragraph({ children: [new TextRun({ text: block.name })] }))
    }
    if (block.title) {
      out.push(
        new Paragraph({
          children: [new TextRun({ text: block.title, italics: true })],
        }),
      )
    }
    return out
  }

  const out: BodyChild[] = []
  if (block.label) {
    out.push(
      new Paragraph({
        spacing: { before: 360 },
        children: [new TextRun({ text: block.label, bold: true })],
      }),
    )
  }
  if (!block.includeDate) {
    out.push(...stack(3.5))
    return out
  }
  // Signature and date sit side by side, which is a two-column layout — so it is
  // a borderless table, the only construct Word lays out that way reliably.
  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        insideHorizontal: {
          style: BorderStyle.NONE,
          size: 0,
          color: 'FFFFFF',
        },
        insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 65, type: WidthType.PERCENTAGE },
              children: stack(3.5),
            }),
            new TableCell({
              width: { size: 35, type: WidthType.PERCENTAGE },
              children: [
                signatureRule(2),
                new Paragraph({ children: [new TextRun({ text: 'Date' })] }),
              ],
            }),
          ],
        }),
      ],
    }),
  )
  return out
}

function renderBlock(
  block: DocumentBlock,
  state: RenderState,
  options: RenderDocxOptions,
): readonly BodyChild[] {
  switch (block.type) {
    case 'heading':
      // Every heading opens a new numbering scope — see `RenderState`.
      state.clauseInstance = ++state.instances
      return [
        new Paragraph({
          heading: HEADING_BY_LEVEL[block.level],
          children: [new TextRun({ text: block.text, bold: true })],
        }),
      ]

    case 'paragraph':
      return [new Paragraph({ children: textRuns(block.runs) })]

    case 'clause':
      return [
        new Paragraph({
          numbering: {
            reference: CLAUSE_NUMBERING,
            level: block.level,
            instance: state.clauseInstance,
          },
          children: textRuns(block.runs),
        }),
      ]

    case 'list': {
      // A fresh instance per list block, so two lists in one document each start
      // at 1 rather than the second continuing the first.
      const instance = ++state.instances
      return block.items.map((item) =>
        block.ordered
          ? new Paragraph({
              numbering: { reference: LIST_NUMBERING, level: 0, instance },
              children: textRuns(item.runs),
            })
          : new Paragraph({
              bullet: { level: 0 },
              children: textRuns(item.runs),
            }),
      )
    }

    case 'table': {
      const cell = (text: string, bold: boolean) =>
        new TableCell({
          children: [
            new Paragraph({ children: [new TextRun({ text, bold })] }),
          ],
        })
      const rows: TableRow[] = []
      if (block.header?.length) {
        rows.push(
          new TableRow({
            tableHeader: true,
            children: block.header.map((h) => cell(h, true)),
          }),
        )
      }
      for (const row of block.rows) {
        rows.push(new TableRow({ children: row.map((c) => cell(c, false)) }))
      }
      // A table with no rows at all is not renderable OOXML; emit nothing rather
      // than a document Word refuses to open.
      if (rows.length === 0) return []
      return [
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }),
      ]
    }

    case 'pageBreak':
      return [new Paragraph({ children: [new PageBreak()] })]

    case 'signature': {
      const out: Paragraph[] = []
      if (block.closing) {
        out.push(
          new Paragraph({
            spacing: { before: 360 },
            children: [new TextRun({ text: block.closing })],
          }),
        )
      }
      // Three blank lines: the space a wet signature goes in.
      out.push(new Paragraph({}), new Paragraph({}), new Paragraph({}))
      out.push(
        new Paragraph({
          children: [new TextRun({ text: block.name, bold: true })],
        }),
      )
      if (block.title) {
        out.push(
          new Paragraph({
            children: [new TextRun({ text: block.title, italics: true })],
          }),
        )
      }
      if (block.organization) {
        out.push(
          new Paragraph({
            children: [new TextRun({ text: block.organization })],
          }),
        )
      }
      return out
    }

    case 'signatureLine':
      return signatureLineChildren(block)

    default: {
      // Not reachable for a built-in block — this is the `extraBlocks` seam.
      const unknown = block as { type?: unknown }
      const type = typeof unknown.type === 'string' ? unknown.type : 'unknown'
      const renderer = options.extraRenderers?.[type]
      if (!renderer) {
        throw new Error(
          `No renderer for document block type '${type}'. Register one via renderDocx's extraRenderers.`,
        )
      }
      return renderer(block, {
        runs: textRuns,
        nextInstance: () => ++state.instances,
      })
    }
  }
}

/**
 * The clause numbering definition: three levels, decimal, each one prefixing its
 * parents — `1.`, `1.1`, `1.1.1` — indented a half inch per level.
 *
 * Declared once and instanced per section rather than defined three times: the
 * levels are the SHAPE of the numbering, the instance is where its counter
 * starts, and conflating them is what makes numbering "mysteriously" continue
 * across sections.
 */
const NUMBERING_CONFIG = [
  {
    reference: CLAUSE_NUMBERING,
    levels: [0, 1, 2].map((level) => ({
      level,
      format: LevelFormat.DECIMAL,
      // `1.` at the top level, `1.1` / `1.1.1` below it — the convention every
      // legal document uses, and the reason the trailing dot is level-0 only.
      text:
        Array.from({ length: level + 1 }, (_, i) => `%${i + 1}`).join('.') +
        (level === 0 ? '.' : ''),
      alignment: AlignmentType.START,
      style: {
        paragraph: {
          indent: {
            left: convertInchesToTwip(0.5 * (level + 1)),
            hanging: convertInchesToTwip(0.5),
          },
        },
      },
    })),
  },
  {
    reference: LIST_NUMBERING,
    levels: [
      {
        level: 0,
        format: LevelFormat.DECIMAL,
        text: '%1.',
        alignment: AlignmentType.START,
        style: {
          paragraph: {
            indent: {
              left: convertInchesToTwip(0.5),
              hanging: convertInchesToTwip(0.25),
            },
          },
        },
      },
    ],
  },
]

/**
 * Render a document model to `.docx` bytes.
 *
 * Returns a `Uint8Array` via `Packer.toArrayBuffer` — the browser-shaped path,
 * so nothing here depends on a Node `Buffer` and the same code runs in a Worker.
 * The caller decides where the bytes go; this never touches storage.
 */
export async function renderDocx(
  model: DocumentModel,
  options: RenderDocxOptions = {},
): Promise<Uint8Array> {
  const state: RenderState = { clauseInstance: 0, instances: 0 }
  const children: BodyChild[] = []

  if (model.letterhead) {
    children.push(...letterheadChildren(model.letterhead))
  } else if (model.title) {
    // A letter's visible head is its letterhead; printing the title above it
    // would repeat the subject line. Everything else — a memo, a report, an
    // agreement — wants its title on the page.
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [new TextRun({ text: model.title, bold: true, size: 28 })],
      }),
    )
  }

  for (const block of model.blocks) {
    children.push(...renderBlock(block, state, options))
  }

  const doc = new Document({
    title: model.title,
    // Times New Roman 12pt (half-points), the default every legal document
    // arrives in. `size` is in half-points; `24` is 12pt.
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 24 } },
      },
    },
    numbering: { config: NUMBERING_CONFIG },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        children,
      },
    ],
  })

  return new Uint8Array(await Packer.toArrayBuffer(doc))
}

/** Re-exported so a host block renderer can build runs the same way we do. */
export type { ParagraphChild }
