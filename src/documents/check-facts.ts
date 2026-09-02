// `checkFacts` — the deterministic guardrail that decides whether a generated
// document is allowed to exist.
//
// WHY THIS IS A MECHANISM AND NOT A PROMPT. Given a brief that asked for a table
// of invoice figures it was never given, four models under the same strict
// schema invented: Claude Sonnet 4.6 fifteen unsupported numbers, Venice
// deepseek-v4-flash twelve, deepseek-v4-pro four, gpt-54-mini zero. Every
// invented figure was plausible and formatted exactly like a real one —
// `84,200`, `7,919.06`, `243,546.25`. Three conclusions, all of which point the
// same way:
//
//   • The most capable model was the WORST. It wrote the most thorough memo and
//     so invented proportionally more. Capability does not protect you here.
//   • Same-model variance is enormous — deepseek-flash produced 7, 9 and 12
//     across three runs of one task. A clean run is not evidence of anything.
//   • The one model that got it right did so by ABSTAINING visibly: it filled
//     every cell with `TBD` / "Not yet calculable from the current file". That
//     is a behaviour to prompt for, not a property to select a model on.
//
// So the check is deterministic or it is nothing: every figure in the document
// must be present in the bound `facts`, or be a legitimate arithmetic derivation
// of them. No LLM, no judgement, no dependencies.
//
// This is also why the tool contract is `{ facts, document }` and not just
// `{ document }` — the facts arrive as BOUND DATA, separately from the prose the
// model wrote, so there is something independent to check the prose against.
//
// It doubles as the eval grader: a deterministic pass/fail beats an LLM judge
// for exactly this property.

import type { DocumentBlock, DocumentModel } from './model'

/** One figure the document states that the facts do not support. */
export type UnsupportedFigure = {
  /** The figure exactly as written, e.g. `$84,200.00`. */
  text: string
  /** Its normalized numeric value — what the comparison actually used. */
  value: number
  /** The sentence it appeared in, so an agent can find and fix it. */
  context: string
}

export type FactCheckResult = {
  /** True when every checked figure traces back to the supplied facts. */
  ok: boolean
  /** Every figure that does not. Empty when `ok`. */
  unsupported: UnsupportedFigure[]
  /** How many distinct figures were checked — 0 means nothing was assertable. */
  checked: number
}

/**
 * How many facts may be combined into one derivation, and how many distinct sums
 * we are willing to enumerate.
 *
 * Both caps exist for the same reason, and it is NOT performance. A large sum
 * space is a large set of coincidences: with fifteen numbers pulled out of a
 * fact bundle, some subset lands on almost any four- or five-digit figure a
 * model might invent, and the guardrail quietly stops guarding. A legitimate
 * total sums a handful of line items, so bounding the term count is what keeps
 * the derivation allowance an allowance rather than a hole.
 *
 * Exceeding the sum cap makes the check STRICTER (a real derivation may go
 * unrecognized and be reported), never laxer — the correct direction for a
 * guardrail to fail in.
 */
const MAX_DERIVATION_TERMS = 8
const MAX_DERIVATION_SUMS = 50_000

/** Value equality in cents: `$525`, `525.00` and `$525.00` are one fact. */
function cents(value: number): number {
  return Math.round(value * 100)
}

/**
 * Every figure-shaped token in a string.
 *
 * A comma only continues the number when three digits follow it, so "March 4,
 * 2026" reads as `4` and `2026` rather than as `4,` — an early version matched
 * the trailing comma and reported the day of the month as an unsupported
 * figure. Classification of what is *checkable* happens in {@link isCheckable},
 * on the match plus its surroundings, because that is where the context (a `%`
 * after it, a `$` before it) lives.
 */
const FIGURE_RE = /(?:\$ ?)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g

function parseFigure(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '')
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

/**
 * Whether a figure found in the DOCUMENT is one we hold the model accountable
 * for. Facts are never filtered — they are authoritative by definition.
 *
 * The filter exists to keep the false-positive rate at zero, which is the only
 * thing that makes a hard-failing guardrail usable. Everything excluded here was
 * excluded because it appears in correct documents and carries no factual claim:
 *
 *   • Anything under 1,000 written plainly — "thirty (30) days", "section 4",
 *     "1.5" in a rate. A fabricated figure that small is not what this catches.
 *   • Percentages — a rate is a term of the agreement, not a computed amount.
 *   • A bare four-digit year (1900–2100) — dates are everywhere and are not
 *     claims about money. An invoice numbered `2026` slips through; that is the
 *     trade this makes, knowingly.
 *
 * A `$` prefix or a thousands separator overrides all of it: `$525` and `84,200`
 * are always checked, whatever their magnitude.
 */
function isCheckable(match: string, before: string, after: string): boolean {
  const value = parseFigure(match)
  if (value === null) return false
  const isMoney = match.startsWith('$') || before.trimEnd().endsWith('$')
  if (isMoney) return true
  // A rate, not an amount.
  if (/^\s*%/.test(after)) return false
  const grouped = match.includes(',')
  if (grouped) return true
  if (value < 1000) return false
  const bare = !match.includes('.')
  if (bare && value >= 1900 && value <= 2100) return false
  return true
}

/** The sentence a figure sits in, trimmed to something an agent can act on. */
function contextAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60)
  const end = Math.min(text.length, index + length + 60)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

/** Every numeric value mentioned anywhere in the bound facts. */
export function factValues(facts: unknown): number[] {
  const out = new Set<number>()
  const visit = (node: unknown): void => {
    if (typeof node === 'number' && Number.isFinite(node)) {
      out.add(node)
      return
    }
    if (typeof node === 'string') {
      for (const m of node.matchAll(FIGURE_RE)) {
        const value = parseFigure(m[0])
        if (value !== null) out.add(value)
      }
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const value of Object.values(node)) visit(value)
    }
  }
  visit(facts)
  return [...out]
}

/**
 * The facts that may take part in a derivation.
 *
 * Narrower than {@link factValues} on purpose. A fact bundle is full of numbers
 * that are not quantities — the `11` and the `02` inside `2025-11-02`, a
 * `deadlineDays: 14` — and letting them into the sum space buys nothing (no
 * document totals up the days of the month) while manufacturing coincidences
 * that let a fabricated figure pass. Same year and magnitude rules the document
 * side uses, for the same reason.
 */
function derivationTerms(values: readonly number[]): number[] {
  return values.filter((v) => {
    if (v < 100) return false
    return !(Number.isInteger(v) && v >= 1900 && v <= 2100)
  })
}

/**
 * Every value reachable by summing between two and {@link MAX_DERIVATION_TERMS}
 * of the facts — the derivation allowance.
 *
 * A demand letter that states three invoice amounts and then their total is
 * doing arithmetic, not inventing: `161,965` was the one figure flagged across
 * the whole corpus of correct documents, and it is exactly the sum of the three
 * supplied amounts. Sums only — a total or a balance is the derivation a
 * document legitimately performs, whereas admitting products or percentages
 * would let an invented interest figure through by coincidence. Two terms
 * minimum, because a single term is already supported outright.
 */
function derivableSums(values: readonly number[]): Set<number> {
  const terms = derivationTerms(values)
    .map(cents)
    .filter((c) => c !== 0)
  // Reachable sums grouped by how many terms produced them, so the term cap can
  // be enforced as the space is built rather than filtered afterwards.
  const bySize: Set<number>[] = [new Set([0])]
  for (let i = 1; i <= MAX_DERIVATION_TERMS; i++) bySize.push(new Set())
  let total = 0
  for (const term of terms) {
    for (let size = MAX_DERIVATION_TERMS - 1; size >= 0; size--) {
      for (const sum of bySize[size]) {
        if (total >= MAX_DERIVATION_SUMS) break
        if (bySize[size + 1].add(sum + term)) total++
      }
    }
  }
  const out = new Set<number>()
  for (let size = 2; size <= MAX_DERIVATION_TERMS; size++) {
    for (const sum of bySize[size]) out.add(sum)
  }
  return out
}

/** Every string the document puts on the page, in reading order. */
export function documentText(document: DocumentModel): string[] {
  const out: string[] = []
  const head = document.letterhead
  if (head) {
    out.push(
      ...(head.senderLines ?? []),
      ...(head.recipientLines ?? []),
      ...[head.date, head.deliveryMethod, head.subject, head.salutation].filter(
        (v): v is string => typeof v === 'string',
      ),
    )
  }
  // The title is checked too: a fabricated amount in the title is still a
  // fabricated amount, and it lands in the file name.
  out.push(document.title)
  for (const block of document.blocks) out.push(...blockText(block))
  return out.filter((line) => line.trim().length > 0)
}

function blockText(block: DocumentBlock): string[] {
  switch (block.type) {
    case 'heading':
      return [block.text]
    case 'paragraph':
    case 'clause':
      // One string per block, not per run: a figure split across runs by bolding
      // ("**$84,200**.00") must still read as one number.
      return [block.runs.map((r) => r.text).join('')]
    case 'list':
      return block.items.map((item) => item.runs.map((r) => r.text).join(''))
    case 'table':
      return [...(block.header ?? []), ...block.rows.flat()]
    case 'signature':
      return [
        block.closing,
        block.name,
        block.title,
        block.organization,
      ].filter((v): v is string => typeof v === 'string')
    case 'signatureLine':
      return [block.label, block.name, block.title].filter(
        (v): v is string => typeof v === 'string',
      )
    case 'pageBreak':
      return []
    default: {
      // A host-defined block (see `documentModelSchemaWith`). Its shape is the
      // host's, so pull every string out of it generically rather than skipping
      // it — an unchecked block would be a hole in the guardrail.
      const out: string[] = []
      const visit = (node: unknown): void => {
        if (typeof node === 'string') out.push(node)
        else if (Array.isArray(node)) for (const item of node) visit(item)
        else if (node !== null && typeof node === 'object') {
          for (const value of Object.values(node)) visit(value)
        }
      }
      visit(block)
      return out
    }
  }
}

/**
 * Assert every figure the document states is supported by the bound facts.
 *
 * Pure and dependency-free — no model, no bindings, no I/O — so it runs
 * identically in a workflow step, in a test, and as an eval grader.
 *
 * Abstention passes: `TBD`, "Not yet calculable from the current file", a blank
 * `___` — none of them contain a checkable figure, so a document that visibly
 * declines to state a number it was not given is CORRECT by this check. That is
 * the behaviour being enforced, not merely tolerated.
 */
export function checkFacts(
  facts: unknown,
  document: DocumentModel,
): FactCheckResult {
  const supported = new Set(factValues(facts).map(cents))
  const derivable = derivableSums(factValues(facts))
  const unsupported: UnsupportedFigure[] = []
  const seen = new Set<number>()
  let checked = 0

  for (const line of documentText(document)) {
    for (const match of line.matchAll(FIGURE_RE)) {
      const raw = match[0]
      const index = match.index
      if (
        !isCheckable(raw, line.slice(0, index), line.slice(index + raw.length))
      )
        continue
      const value = parseFigure(raw)
      if (value === null) continue
      const key = cents(value)
      // Report a figure once however often the document repeats it — a demand
      // letter states its total in the table, the clause, and the closing.
      if (seen.has(key)) continue
      seen.add(key)
      checked++
      if (supported.has(key) || derivable.has(key)) continue
      unsupported.push({
        text: raw,
        value,
        context: contextAround(line, index, raw.length),
      })
    }
  }

  return { ok: unsupported.length === 0, unsupported, checked }
}

/**
 * The failure as a message for the model that wrote the document.
 *
 * Phrased as an instruction rather than a report because it is returned to the
 * agent as a hard error to retry against: naming the figures and telling it to
 * abstain is what turns a rejection into a corrected document, and abstention is
 * the behaviour the whole check exists to produce.
 */
export function factCheckErrorMessage(result: FactCheckResult): string {
  const lines = result.unsupported.map(
    (f) => `  • ${f.text} — in "${f.context}"`,
  )
  return [
    `The document states ${result.unsupported.length} figure(s) that the supplied facts do not support:`,
    ...lines,
    '',
    'Every amount, identifier, and total must come from the facts you were given, or be a sum of them.',
    'Do not estimate or infer a figure you were not given: write "TBD" or state that it is not yet calculable, and rewrite the document.',
  ].join('\n')
}
