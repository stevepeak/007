import bash from 'highlight.js/lib/languages/bash'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import { createLowlight } from 'lowlight'
import type { ReactNode } from 'react'

// ── Syntax highlighting, once, for the whole package ─────────────────────────
//
// Every code surface here — the run viewer's JSON, the playground's output, a
// mocked tool fixture, an agent's Zod schema, the MCP setup snippets — renders
// through `highlightCode`. It used to be two hand-rolled tokenizers (a JSON
// regex and a JS lexer) that agreed on neither the token set nor the palette,
// and a third surface (`CodeBlock`) that gave up and rendered grey text.
//
// `lowlight` is highlight.js without the DOM: it returns a hast tree, which we
// render as React spans. The palette lives HERE rather than in a highlight.js
// stylesheet, so the colours are Tailwind tokens like everything else in this
// UI and there is no theme CSS to ship or keep in sync.
//
// Only the three grammars this package actually renders are registered — the
// full highlight.js build is ~190 languages, none of the rest reachable from
// any screen we have.

export type CodeLanguage = 'json' | 'javascript' | 'bash'

const lowlight = createLowlight()
lowlight.register({ bash, javascript, json })

// highlight.js scope → Tailwind. Unmapped scopes inherit the surrounding text
// colour, which is the right default: a token nobody chose a colour for should
// look like ordinary code, not like an accident.
const SCOPE_CLASS: Record<string, string> = {
  'hljs-attr': 'text-sky-700',
  'hljs-property': 'text-sky-700',
  'hljs-string': 'text-green-700',
  'hljs-regexp': 'text-green-700',
  'hljs-number': 'text-amber-700',
  'hljs-symbol': 'text-amber-700',
  'hljs-literal': 'text-purple-700',
  'hljs-keyword': 'text-purple-600',
  'hljs-built_in': 'text-purple-600',
  'hljs-type': 'text-purple-600',
  'hljs-title': 'text-sky-600',
  'hljs-class': 'text-sky-600',
  'hljs-comment': 'text-neutral-400 italic',
  'hljs-meta': 'text-neutral-400',
  'hljs-punctuation': 'text-neutral-400',
  'hljs-operator': 'text-neutral-400',
}

type HastNode = ReturnType<typeof lowlight.highlight>['children'][number]

function classFor(node: Extract<HastNode, { type: 'element' }>): string {
  const names = node.properties.className
  if (!Array.isArray(names)) return ''
  for (const name of names) {
    if (typeof name !== 'string') continue
    const cls = SCOPE_CLASS[name]
    if (cls) return cls
  }
  return ''
}

function render(nodes: HastNode[], keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = []
  for (const [i, node] of nodes.entries()) {
    const key = `${keyPrefix}${i}`
    if (node.type === 'text') {
      out.push(node.value)
      continue
    }
    if (node.type !== 'element') continue
    const children = render(node.children, `${key}.`)
    const cls = classFor(node)
    out.push(
      cls ? (
        <span key={key} className={cls}>
          {children}
        </span>
      ) : (
        <span key={key}>{children}</span>
      ),
    )
  }
  return out
}

/**
 * Render `code` as coloured spans.
 *
 * The output is character-for-character the input — highlight.js tokenizes, it
 * never rewrites — which is what lets the same call paint a static block AND
 * the layer sitting exactly under `CodeEditor`'s transparent textarea.
 *
 * A half-typed document is expected, not exceptional: highlight.js degrades to
 * best-effort tokens rather than throwing. If it ever does throw, the author's
 * text is returned unhighlighted — losing the colour is recoverable, losing the
 * text is not.
 */
export function highlightCode(
  code: string,
  language: CodeLanguage,
): ReactNode[] {
  if (!code) return []
  try {
    return render(lowlight.highlight(language, code).children)
  } catch {
    return [code]
  }
}
