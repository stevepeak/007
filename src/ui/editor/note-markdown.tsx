import { Fragment, type ReactNode } from 'react'

// A tiny, dependency-free Markdown renderer for the sticky Note node. It covers
// the subset a note actually needs — headings, bold/italic, inline & fenced
// code, links, unordered/ordered lists, blockquotes, and horizontal rules — and
// renders everything through real React elements (never `dangerouslySetInnerHTML`),
// so untrusted note text can't inject markup. Anything it doesn't recognise
// falls through as plain paragraph text.

// ── Inline spans ────────────────────────────────────────────────────────────
// Bold (**/__), italic (*/_), inline code (`…`), and links ([text](url)). Parsed
// left-to-right; the first matching token at each position wins. Unmatched
// markers render literally.
const INLINE_RE =
  /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+?)`|\[([^\]]+?)\]\(([^)\s]+?)\)/

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let i = 0
  while (rest.length > 0) {
    const m = INLINE_RE.exec(rest)
    if (!m) {
      out.push(rest)
      break
    }
    if (m.index > 0) out.push(rest.slice(0, m.index))
    const key = `${keyPrefix}-${i++}`
    if (m[1]) {
      out.push(<strong key={key}>{renderInline(m[2], key)}</strong>)
    } else if (m[3]) {
      out.push(<em key={key}>{renderInline(m[4], key)}</em>)
    } else if (m[5] !== undefined) {
      out.push(
        <code
          key={key}
          className="rounded bg-black/5 px-1 py-0.5 font-mono text-[0.85em]"
        >
          {m[5]}
        </code>,
      )
    } else if (m[6] !== undefined && m[7] !== undefined) {
      const href = /^https?:\/\//.test(m[7]) ? m[7] : undefined
      out.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-700 underline"
          // Don't let a link click start a node drag / selection change.
          onClick={(e) => e.stopPropagation()}
        >
          {renderInline(m[6], key)}
        </a>,
      )
    }
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

// ── Blocks ──────────────────────────────────────────────────────────────────
// Group consecutive lines into block elements. A single pass over the lines is
// enough for the supported grammar.
export function NoteMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let key = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Fenced code block.
    if (/^```/.test(line.trim())) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i])
        i++
      }
      blocks.push(
        <pre
          key={key++}
          className="my-1 overflow-x-auto rounded bg-black/5 p-2 font-mono text-[0.8em] leading-snug"
        >
          <code>{code.join('\n')}</code>
        </pre>,
      )
      continue
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push(<hr key={key++} className="my-2 border-black/10" />)
      continue
    }

    // Heading (#..######).
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const sizes = [
        'text-lg font-semibold',
        'text-base font-semibold',
        'text-sm font-semibold',
        'text-sm font-medium',
        'text-xs font-semibold',
        'text-xs font-medium',
      ]
      const Tag = `h${level}` as 'h1'
      blocks.push(
        <Tag key={key++} className={`mt-1 mb-0.5 ${sizes[level - 1]}`}>
          {renderInline(heading[2], `h${key}`)}
        </Tag>,
      )
      continue
    }

    // Blockquote (one or more consecutive `>` lines).
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      i--
      blocks.push(
        <blockquote
          key={key++}
          className="my-1 border-l-2 border-black/20 pl-2 text-black/70 italic"
        >
          {renderInline(quote.join(' '), `q${key}`)}
        </blockquote>,
      )
      continue
    }

    // Lists — a run of bullet (-, *, +) or ordered (1.) items.
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      const itemRe = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/
      while (i < lines.length && itemRe.test(lines[i])) {
        items.push(lines[i].replace(itemRe, ''))
        i++
      }
      i--
      const listItems = items.map((it, idx) => (
        <li key={idx}>{renderInline(it, `li${key}-${idx}`)}</li>
      ))
      blocks.push(
        ordered ? (
          <ol key={key++} className="my-1 list-decimal pl-5">
            {listItems}
          </ol>
        ) : (
          <ul key={key++} className="my-1 list-disc pl-5">
            {listItems}
          </ul>
        ),
      )
      continue
    }

    // Blank line → paragraph break (skip; grouping below handles spacing).
    if (line.trim() === '') continue

    // Otherwise a paragraph: gather following non-blank, non-special lines.
    const para: string[] = [line]
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() !== '' &&
      !/^(#{1,6}\s|```|\s*>\s?|\s*([-*+]|\d+\.)\s+|(-{3,}|\*{3,}|_{3,})$)/.test(
        lines[i + 1],
      )
    ) {
      para.push(lines[i + 1])
      i++
    }
    blocks.push(
      <p key={key++} className="my-1 leading-snug">
        {para.map((p, idx) => (
          <Fragment key={idx}>
            {idx > 0 ? <br /> : null}
            {renderInline(p, `p${key}-${idx}`)}
          </Fragment>
        ))}
      </p>,
    )
  }

  return <>{blocks}</>
}
