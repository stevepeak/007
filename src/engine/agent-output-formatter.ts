// A comment-preserving pretty-printer for Zod-schema source. Unlike the compiler,
// formatting can't go through JSON Schema (that would strip the author's
// comments), so it works on the token stream directly: it regenerates all
// whitespace, expanding `z.object({ … })` bodies one-field-per-line and keeping
// arrays/enums/calls inline — matching the decompiler's house style — while
// carrying comments through verbatim, either on their own line or trailing the
// code they annotate.

import { ParseError, PUNCT } from './agent-output-scan'

type FmtKind = 'name' | 'string' | 'punct' | 'line-comment' | 'block-comment'
type FmtToken = { kind: FmtKind; value: string; nlBefore: boolean }

// Like the compiler's tokenizer, but keeps comments as tokens and records
// whether a newline preceded each token (so a comment can be re-attached as
// leading vs trailing).
function lexWithComments(src: string): FmtToken[] {
  const out: FmtToken[] = []
  let i = 0
  let nlBefore = false
  const push = (kind: FmtKind, value: string) => {
    out.push({ kind, value, nlBefore })
    nlBefore = false
  }
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\n') {
      nlBefore = true
      i++
      continue
    }
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if ((ch === '/' && src[i + 1] === '/') || ch === '#') {
      let j = ch === '#' ? i + 1 : i + 2
      while (j < src.length && src[j] !== '\n') j++
      // Normalize `#` markers to `//` so formatted output is valid-looking JS.
      const body = src.slice(ch === '#' ? i + 1 : i + 2, j).trim()
      push('line-comment', `// ${body}`.trimEnd())
      i = j
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++
      j = Math.min(src.length, j + 2)
      push('block-comment', src.slice(i, j))
      i = j
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === ch) {
          j++
          break
        }
        j++
      }
      push('string', src.slice(i, j))
      i = j
      continue
    }
    if (/[a-z_$]/i.test(ch)) {
      let j = i + 1
      while (j < src.length && /[\w$]/.test(src[j])) j++
      push('name', src.slice(i, j))
      i = j
      continue
    }
    if (PUNCT.has(ch)) {
      push('punct', ch)
      i++
      continue
    }
    // Anything else (e.g. a stray digit — not part of the grammar) means we
    // can't safely reflow; the caller falls back to the original source.
    throw new ParseError(`Unexpected character "${ch}".`)
  }
  return out
}

/**
 * Reformat Zod-schema source into the canonical house style, preserving any
 * `//`, `#`, or block comments the author wrote (comments live only in the
 * editor — the persisted form is JSON Schema — so formatting must keep them).
 * Best-effort: if the source can't be lexed, it's returned unchanged.
 */
export function formatZodSource(source: string): string {
  if (!source.trim()) return source
  let toks: FmtToken[]
  try {
    toks = lexWithComments(source)
  } catch {
    return source
  }

  // Only `{ … }` (object bodies) expand across lines; `(` and `[` stay inline.
  const stack: { type: '{' | '[' | '('; expanded: boolean }[] = []
  let out = ''
  let indent = 0
  let lineStarted = false

  const nl = () => {
    out += '\n'
    lineStarted = false
  }
  const write = (s: string) => {
    if (!lineStarted) {
      out += '  '.repeat(indent)
      lineStarted = true
    }
    out += s
  }
  const isComment = (t: FmtToken | undefined) =>
    t?.kind === 'line-comment' || t?.kind === 'block-comment'
  // Next token that isn't a comment — used to spot empty `{}` bodies.
  const nextCode = (from: number): FmtToken | undefined => {
    for (let k = from; k < toks.length; k++) {
      if (!isComment(toks[k])) return toks[k]
    }
    return
  }

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]

    if (t.kind === 'line-comment' || t.kind === 'block-comment') {
      if (!t.nlBefore && lineStarted) {
        // Trailing comment — keep it on the same line as the code it follows.
        out += ` ${t.value}`
        if (t.kind === 'line-comment') nl()
      } else {
        if (lineStarted) nl()
        write(t.value)
        nl()
      }
      continue
    }

    if (t.kind === 'punct') {
      switch (t.value) {
        case '{': {
          write('{')
          const expanded = nextCode(k + 1)?.value !== '}'
          stack.push({ type: '{', expanded })
          if (expanded) {
            indent++
            nl()
          }
          break
        }
        case '}': {
          const frame = stack.pop()
          if (frame?.expanded) {
            // Close on its own line; add a trailing comma if the last field
            // didn't already have one (i.e. we're still mid-field-line).
            if (lineStarted) {
              out += ','
              nl()
            }
            indent = Math.max(0, indent - 1)
            write('}')
          } else {
            write('}')
          }
          break
        }
        case '[':
        case '(':
          write(t.value)
          stack.push({ type: t.value, expanded: false })
          break
        case ']':
        case ')':
          stack.pop()
          write(t.value)
          break
        case ',': {
          write(',')
          const top = stack[stack.length - 1]
          const inObjectBody = top?.type === '{' && top.expanded
          // Hold the newline if a same-line comment trails the comma, so the
          // comment stays attached to the field it annotates.
          if (isComment(toks[k + 1]) && !toks[k + 1].nlBefore) break
          if (inObjectBody) nl()
          else out += ' '
          break
        }
        case ':':
          write(': ')
          break
        default:
          write(t.value)
      }
      continue
    }

    // name / string
    write(t.value)
  }

  return out.trimEnd()
}
