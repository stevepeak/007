import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

// The subpath table in guide.md IS the integration contract — it's how a host
// learns which entry point to import and, more importantly, which runtime each
// one is safe in (`/cloudflare/runtime` imports `cloudflare:workers` and blows
// up in a Node route; the guide is where that warning lives).
//
// It had drifted: three real public entry points — ./analytics,
// ./cloudflare/analytics-engine and ./ui/run-progress — shipped undocumented.
// Nothing catches that class of drift except a test, because both sides are
// "correct" on their own.

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  name: string
  exports: Record<string, unknown>
}
const guide = readFileSync(`${root}guide.md`, 'utf8')

/** Every `@stevepeak/007…` entry named in the guide's subpath table. */
function documentedSubpaths(): Set<string> {
  const found = new Set<string>()
  for (const line of guide.split('\n')) {
    if (!line.startsWith('|')) continue
    const m = /^\|\s*`(@stevepeak\/007[^`]*)`/.exec(line)
    if (!m) continue
    const sub = m[1].slice(pkg.name.length)
    found.add(sub === '' ? '.' : `.${sub}`)
  }
  return found
}

describe('package exports ↔ guide.md subpath table', () => {
  test('every published subpath is documented', () => {
    const documented = documentedSubpaths()
    const undocumented = Object.keys(pkg.exports).filter(
      (k) => !documented.has(k),
    )
    expect(undocumented).toEqual([])
  })

  test('every documented subpath is actually published', () => {
    const published = new Set(Object.keys(pkg.exports))
    const phantom = [...documentedSubpaths()].filter((k) => !published.has(k))
    expect(phantom).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Which entry points may contain a browser.
//
// `runEval` used to live in `ui/hooks-evals.ts`. Nothing in it was React — it
// touches a `WfDataClient` and `setTimeout` — but the MODULE imported
// react-query, so `wf-mcp` could author eval Samples and not run them. Moving
// it to `eval/run-eval.ts` is what unblocked headless runs.
//
// The move is only worth as much as it stays true, and the way it stops being
// true is quiet: someone adds one import to a file `eval/` already reaches, and
// the barrel drags React back into a bun process. Nothing else catches it —
// typecheck won't, because both projects compile.

const SRC = `${root}src/`

/** Bare specifiers that mean "this file is browser code". */
const BROWSER_ONLY = [/^react$/, /^react\//, /^react-dom/, /^@tanstack\//]

/** Every `from '…'` / `import('…')` specifier in a source file. */
function specifiersOf(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const found: string[] = []
  // One quantified class rather than `\s*\(?\s*` — two adjacent
  // whitespace quantifiers are a backtracking hazard on a hostile string.
  const re = /(?:from|import)[\s(]*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) found.push(m[1] ?? '')
  return found
}

/** Resolve a relative specifier the way the bundler does; null if it isn't one. */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const dir = fromFile.slice(0, fromFile.lastIndexOf('/'))
  const parts = `${dir}/${spec}`.split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  const base = `/${stack.join('/')}`
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Every source file an entry point reaches, itself included. */
function closureOf(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of specifiersOf(file)) {
      const resolved = resolveRelative(file, spec)
      if (resolved) queue.push(resolved)
    }
  }
  return [...seen]
}

describe('non-UI entry points stay free of the browser', () => {
  const entries = Object.entries(pkg.exports)
    .filter(([sub]) => !sub.startsWith('./ui'))
    .map(([sub, target]) => [sub, `${root}${String(target).slice(2)}`] as const)
    .filter(([, file]) => file.endsWith('.ts'))

  // A walker that silently resolved nothing would pass every case below.
  test('the walker actually traverses', () => {
    expect(entries.length).toBeGreaterThan(5)
    const evalClosure = closureOf(`${SRC}eval/index.ts`)
    expect(evalClosure.length).toBeGreaterThan(10)
    expect(evalClosure).toContain(`${SRC}eval/run-eval.ts`)
  })

  for (const [sub, file] of entries) {
    test(`${sub} imports no React and no @tanstack`, () => {
      const offenders: string[] = []
      for (const f of closureOf(file)) {
        // A file under src/ui is browser code by construction, whatever it
        // happens to import today.
        if (f.startsWith(`${SRC}ui/`)) {
          offenders.push(`${sub} reaches ${f.slice(SRC.length)}`)
          continue
        }
        for (const spec of specifiersOf(f)) {
          if (BROWSER_ONLY.some((re) => re.test(spec))) {
            offenders.push(`${f.slice(SRC.length)} imports '${spec}'`)
          }
        }
      }
      expect(offenders).toEqual([])
    })
  }
})
