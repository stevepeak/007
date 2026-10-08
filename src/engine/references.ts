// Inline references: links a model writes into text that a host renders as
// interactive chips — "open this record", "jump to this passage".
//
// Framework-free on purpose (no `ai`, no zod, no React): the engine writes the
// prompt block and checks provenance with it, a host's chat renderer parses it,
// a tool or an Output node unwraps it to plain text. One grammar, one module,
// every consumer — so the format can't drift between whoever writes a reference
// and whoever reads one.
//
// The grammar is an ordinary markdown link, so any surface that does NOT
// decorate it still shows readable text:
//
//   [label](#ref:<kind>/<id>[/<anchor>] "<quote>")
//
//   • kind   — a {@link ReferenceKind} id the host declared.
//   • id     — the record's id, copied from a tool result or an upstream input.
//   • anchor — optional, kind-defined location inside the record.
//   • quote  — optional verbatim excerpt, carried as the markdown link TITLE.
//              A title may hold spaces, a URL may not — and models are poor at
//              percent-encoding, so the free-text part goes where it needs none.
//
// The href is `#`-prefixed rather than a custom scheme because markdown
// renderers sanitize unknown schemes away; a fragment link survives them all.

/**
 * A kind of thing a reference can point at, declared ONCE by the host and
 * shared by every agent, tool and renderer that deals in it.
 */
export type ReferenceKind = {
  /** Short stable key written into the link — `[a-z][a-z0-9_-]*`. */
  id: string
  /** Name shown in the agent editor. */
  label: string
  /** One line for the editor: what a reference of this kind points at. */
  description: string
  /**
   * Told to the model: when to reference this kind, and which field of which
   * tool result the id is copied from.
   */
  guidance: string
  /**
   * When set, a reference may carry an anchor, and this tells the model where
   * the value comes from. Unset → anchors are dropped by {@link checkReferences}.
   */
  anchor?: string
  /** Whether a reference may carry a verbatim quote the host can locate. */
  quote?: boolean
  /** One worked example, rendered into the prompt in the exact syntax. */
  example: Omit<Reference, 'kind'>
}

/** One reference, as written in text and as carried in structured output. */
export type Reference = {
  kind: string
  id: string
  anchor?: string
  quote?: string
  /** The link text the reader sees. */
  label: string
}

/** A reference located in a string — `[start, end)` spans the whole link. */
export type ReferenceMatch = Reference & {
  start: number
  end: number
  raw: string
}

export const REFERENCE_HREF_PREFIX = '#ref:'

const KIND_ID_RE = /^[a-z][a-z0-9_-]*$/

/** Whether `id` is usable as a {@link ReferenceKind} id. */
export function isReferenceKindId(id: string): boolean {
  return KIND_ID_RE.test(id)
}

// `encodeURIComponent` leaves `(`/`)` alone, and an unbalanced paren ends a
// markdown link destination early — so encode those too.
function encodeSegment(s: string): string {
  return encodeURIComponent(s).replaceAll('(', '%28').replaceAll(')', '%29')
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    // A model that half-encoded a value: keep what it wrote.
    return s
  }
}

/** The `#ref:…` href for a reference (no label, no quote). */
export function referenceHref(
  ref: Pick<Reference, 'kind' | 'id' | 'anchor'>,
): string {
  const anchor = ref.anchor ? `/${encodeSegment(ref.anchor)}` : ''
  return `${REFERENCE_HREF_PREFIX}${ref.kind}/${encodeSegment(ref.id)}${anchor}`
}

/** A reference as markdown, exactly as the model is asked to write it. */
export function stringifyReference(ref: Reference): string {
  const label = ref.label.replaceAll(/[[\]\n]/g, ' ').trim() || ref.id
  const quote = ref.quote
    ? ` "${ref.quote.replaceAll(/["\n]/g, ' ').trim()}"`
    : ''
  return `[${label}](${referenceHref(ref)}${quote})`
}

/**
 * Parse a `#ref:…` href. Returns null for anything else, so a renderer can hand
 * it every link and let the non-references through.
 */
export function parseReferenceHref(
  href: string,
): Pick<Reference, 'kind' | 'id' | 'anchor'> | null {
  if (!href.startsWith(REFERENCE_HREF_PREFIX)) return null
  const rest = href.slice(REFERENCE_HREF_PREFIX.length)
  const [kind, id, ...anchorParts] = rest.split('/')
  if (!kind || !isReferenceKindId(kind) || !id) return null
  const anchor = anchorParts.join('/')
  return {
    kind,
    id: decodeSegment(id),
    ...(anchor ? { anchor: decodeSegment(anchor) } : {}),
  }
}

// One complete reference link: label, `#ref:` destination, optional title in
// double quotes. Only COMPLETE links match, so a reference still streaming in
// stays plain text until its closing paren arrives.
const REFERENCE_LINK_RE =
  /\[([^\]\n]*)\]\((#ref:[^\s)"]+)(?:\s+"([^"\n]*)")?\s*\)/g

// Splits text into alternating [prose, code, prose, …] segments: a reference
// inside a code span or fence is an example, not a reference.
const CODE_RE = /(```[\s\S]*?```|`[^`\n]*`)/

/** Every reference in `text`, in order, skipping code spans and fences. */
export function parseReferences(text: string): ReferenceMatch[] {
  const out: ReferenceMatch[] = []
  if (!text) return out
  let offset = 0
  for (const [i, segment] of text.split(CODE_RE).entries()) {
    if (i % 2 === 0) {
      for (const m of segment.matchAll(REFERENCE_LINK_RE)) {
        const parsed = parseReferenceHref(m[2] ?? '')
        if (!parsed) continue
        const start = offset + (m.index ?? 0)
        const quote = m[3]?.trim()
        out.push({
          ...parsed,
          label: (m[1] ?? '').trim() || parsed.id,
          ...(quote ? { quote } : {}),
          start,
          end: start + m[0].length,
          raw: m[0],
        })
      }
    }
    offset += segment.length
  }
  return out
}

/**
 * Rewrite each reference in `text` through `fn` — return a string to replace
 * the link, or null to leave it as written. The primitive under
 * {@link stripReferences} and {@link checkReferences}.
 */
export function mapReferences(
  text: string,
  fn: (ref: ReferenceMatch) => string | null,
): string {
  const refs = parseReferences(text)
  if (refs.length === 0) return text
  let out = ''
  let at = 0
  for (const ref of refs) {
    const next = fn(ref)
    if (next == null) continue
    out += text.slice(at, ref.start) + next
    at = ref.end
  }
  return out + text.slice(at)
}

/**
 * `text` with every reference replaced by its label — for any surface that
 * can't render chips (email, an external system, a plain-text export).
 */
export function stripReferences(text: string): string {
  return mapReferences(text, (ref) => ref.label)
}

/** Distinct references by `kind`/`id`/`anchor`, first occurrence wins. */
export function uniqueReferences(refs: readonly Reference[]): Reference[] {
  const seen = new Set<string>()
  const out: Reference[] = []
  for (const r of refs) {
    const key = `${r.kind}\u0000${r.id}\u0000${r.anchor ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      kind: r.kind,
      id: r.id,
      label: r.label,
      ...(r.anchor ? { anchor: r.anchor } : {}),
      ...(r.quote ? { quote: r.quote } : {}),
    })
  }
  return out
}

/**
 * The system-prompt section that teaches a model the grammar and the enabled
 * kinds. Appended by the engine after the author's own prompt, so an author
 * never writes — or gets wrong — the syntax.
 */
export function referencePromptBlock(kinds: readonly ReferenceKind[]): string {
  if (kinds.length === 0) return ''
  const anyAnchor = kinds.some((k) => k.anchor)
  const anyQuote = kinds.some((k) => k.quote)
  const lines = [
    '## Referencing sources',
    '',
    'Your answer is shown with interactive references. Whenever a statement relies on a source, link to it inline, right after the statement, using a markdown link in exactly this form:',
    '',
    `    [label](#ref:<kind>/<id>${anyAnchor ? '/<anchor>' : ''}${anyQuote ? ' "<quote>"' : ''})`,
    '',
    '- `<kind>` is one of the kinds listed below.',
    '- `<id>` is copied exactly from a tool result or from the input you were given. Never invent, shorten or guess an id.',
  ]
  if (anyAnchor) {
    lines.push(
      '- `/<anchor>` is optional and only for kinds that describe one; copy it exactly, and leave it out when unsure.',
    )
  }
  if (anyQuote) {
    lines.push(
      '- `"<quote>"` is optional and only for kinds that allow one: a short excerpt (a few words to one sentence) copied verbatim from the source, without double quotes inside it.',
    )
  }
  lines.push(
    '- `label` is the readable text the reader sees — a name or a short description, never the raw id.',
    '- Reference every source you relied on. Links already present in your input are valid references; you may reuse them as written.',
    '- A reference whose id does not appear in your tool results or input is removed before anyone sees it.',
    '- Do not put references inside code blocks.',
  )
  for (const kind of kinds) {
    lines.push('', `### ${kind.label} (\`${kind.id}\`)`, '', kind.guidance)
    if (kind.anchor) lines.push('', `Anchor: ${kind.anchor}`)
    lines.push(
      '',
      `Example: ${stringifyReference({ kind: kind.id, ...kind.example })}`,
    )
  }
  return lines.join('\n')
}

/** Why a reference was changed or removed by {@link checkReferences}. */
export type ReferenceIssue = {
  kind: string
  id: string
  /**
   * `unknown-kind` — not a kind enabled here; the link became its label.
   * `unsourced` — the id appears in no evidence; the link became its label.
   * `anchor-dropped` / `quote-dropped` — the kind takes none (or the anchor
   * was unsourced); the reference was kept without it.
   */
  problem: 'unknown-kind' | 'unsourced' | 'anchor-dropped' | 'quote-dropped'
}

/**
 * The provenance check. Every reference in `text` must name an enabled kind and
 * an id that appears somewhere in `evidence` — the tool results, bound inputs
 * and messages the model actually saw. Anything else is a hallucination and is
 * rewritten to its plain label rather than failing the run: the answer is still
 * an answer, just with one less chip.
 *
 * `evidence` must NOT include the prompt block from
 * {@link referencePromptBlock}, or the worked examples' ids would pass.
 *
 * The check is a substring test, so it is only as strong as the ids are
 * distinctive: a UUID can't appear by accident, a one-character id can.
 */
export function checkReferences(args: {
  text: string
  kinds: readonly ReferenceKind[]
  evidence: string
}): { text: string; references: Reference[]; issues: ReferenceIssue[] } {
  const byId = new Map(args.kinds.map((k) => [k.id, k]))
  const issues: ReferenceIssue[] = []
  const kept: Reference[] = []
  const text = mapReferences(args.text, (ref) => {
    const kind = byId.get(ref.kind)
    if (!kind) {
      issues.push({ kind: ref.kind, id: ref.id, problem: 'unknown-kind' })
      return ref.label
    }
    if (!args.evidence.includes(ref.id)) {
      issues.push({ kind: ref.kind, id: ref.id, problem: 'unsourced' })
      return ref.label
    }
    let { anchor, quote } = ref
    if (anchor && (!kind.anchor || !args.evidence.includes(anchor))) {
      issues.push({ kind: ref.kind, id: ref.id, problem: 'anchor-dropped' })
      anchor = undefined
    }
    if (quote && !kind.quote) {
      issues.push({ kind: ref.kind, id: ref.id, problem: 'quote-dropped' })
      quote = undefined
    }
    const clean: Reference = {
      kind: ref.kind,
      id: ref.id,
      label: ref.label,
      ...(anchor ? { anchor } : {}),
      ...(quote ? { quote } : {}),
    }
    kept.push(clean)
    // Re-serialize only when something changed, so a valid link stays
    // byte-for-byte what the model wrote.
    return anchor === ref.anchor && quote === ref.quote
      ? null
      : stringifyReference(clean)
  })
  return { text, references: uniqueReferences(kept), issues }
}

/**
 * Validate a host's kind catalog: well-formed, distinct ids. Returns problem
 * strings (empty when fine) in the same style as `defineWfConfig`.
 */
export function referenceKindProblems(
  kinds: readonly ReferenceKind[],
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const k of kinds) {
    if (!isReferenceKindId(k.id)) {
      problems.push(
        `reference kind '${k.id}' must match ${KIND_ID_RE.source} (it is written into links)`,
      )
    }
    if (seen.has(k.id)) problems.push(`reference kind '${k.id}' is declared twice`)
    seen.add(k.id)
  }
  return problems
}
