import {
  NODE_KIND_CATEGORY_ORDER,
  NODE_KIND_REGISTRY,
  WF_NODE_KINDS,
} from '../../engine/graph-kinds'

import { DOC_SOURCES } from './sources.generated'

// The documentation an MCP client can pull with `get_docs`.
//
// Topics are Markdown files under `topics/`, compiled into `sources.generated.ts`
// (see `build.ts`). Three things are NOT hand-written, because a hand-written
// list is the first thing to go stale: the node-kind dictionary (read from
// `NODE_KIND_REGISTRY`), the MCP tool dictionary (read from the live catalog)
// and the topic index (read from the topics themselves). A topic asks for one
// with a `{{placeholder}}` line; `docs.test.ts` fails on a placeholder nothing
// expands.
//
// Cross-references are written `[[topic-id]]` and are checked by the same test.

export type DocTopic = {
  /** Path under `topics/` without `.md` — `execution`, `nodes/race`. */
  id: string
  title: string
  /** One line: what a reader will learn. Shown in the index. */
  summary: string
  /** Sort key within the index. Lower comes first. */
  order: number
  /** Markdown, frontmatter removed, placeholders NOT yet expanded. */
  body: string
}

/** A tool as the dictionary shows it — the subset of `WfMcpTool` it needs. */
export type DocToolEntry = {
  name: string
  title: string
  readOnly: boolean
}

export const OVERVIEW_TOPIC = 'overview'

function parseTopic(id: string, source: string): DocTopic {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source)
  if (!match) throw new Error(`docs topic ${id} has no frontmatter`)
  const meta: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const { title, summary } = meta
  if (!title || !summary) {
    throw new Error(`docs topic ${id} needs a title and a summary`)
  }
  return {
    id,
    title,
    summary,
    order: Number(meta.order ?? 1000),
    body: source.slice(match[0].length).trim(),
  }
}

let cache: DocTopic[] | undefined

/** Every topic, in index order. */
export function docTopics(): DocTopic[] {
  cache ??= Object.entries(DOC_SOURCES)
    .map(([id, src]) => parseTopic(id, src))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return cache
}

/**
 * Resolve what a model typed to a topic.
 *
 * Forgiving on purpose: `race`, `Race`, `nodes/race` and `nodes.race` all mean
 * the Race node's page. A model that guesses a near-miss id should land on the
 * page, not on an error it has to recover from.
 */
export function findTopic(raw: string): DocTopic | undefined {
  const want = raw
    .trim()
    .toLowerCase()
    .replace(/\.md$/, '')
    .replaceAll(/[.\s]+/g, '/')
  const topics = docTopics()
  return (
    topics.find((t) => t.id === want) ??
    topics.find((t) => t.id === `nodes/${want}`) ??
    topics.find((t) => t.id.split('/').at(-1) === want)
  )
}

/** Closest ids to a miss — substring either way, then shared words. */
export function suggestTopics(raw: string): string[] {
  const want = raw.trim().toLowerCase()
  const words = want.split(/[^a-z0-9]+/).filter((w) => w.length > 2)
  return docTopics()
    .filter((t) => {
      const hay = `${t.id} ${t.title}`.toLowerCase()
      return (
        hay.includes(want) ||
        want.includes(t.id) ||
        words.some((w) => hay.includes(w))
      )
    })
    .map((t) => t.id)
    .slice(0, 8)
}

function topicIndex(): string {
  return docTopics()
    .map((t) => `- \`${t.id}\` — **${t.title}.** ${t.summary}`)
    .join('\n')
}

function nodeKindTable(): string {
  const rows: string[] = []
  for (const category of NODE_KIND_CATEGORY_ORDER) {
    for (const kind of WF_NODE_KINDS) {
      const d = NODE_KIND_REGISTRY[kind]
      if ((d.palette?.category ?? 'Other') !== category) continue
      const what =
        d.palette?.description ??
        (kind === 'trigger'
          ? 'How the run starts — one per graph, created with the workflow.'
          : 'The run’s answer — names its value with `config.source`.')
      const traits = [
        d.decision ? 'routes' : null,
        d.bookend ? 'never executes' : null,
      ].filter(Boolean)
      rows.push(
        `| \`${kind}\` | ${category} | ${what}${traits.length > 0 ? ` _(${traits.join(', ')})_` : ''} | \`nodes/${kind}\` |`,
      )
    }
  }
  return [
    '| kind | group | what it does | docs |',
    '| ---- | ----- | ------------ | ---- |',
    ...rows,
  ].join('\n')
}

function toolTable(tools: DocToolEntry[]): string {
  const row = (t: DocToolEntry) => `| \`${t.name}\` | ${t.title} |`
  const reads = tools.filter((t) => t.readOnly)
  const writes = tools.filter((t) => !t.readOnly)
  return [
    `**Read (${reads.length})** — available on every connection.`,
    '',
    '| tool | what it is for |',
    '| ---- | -------------- |',
    ...reads.map(row),
    '',
    `**Write (${writes.length})** — registered only on a connection authorized for writes. If you cannot see one, this session is read-only.`,
    '',
    '| tool | what it is for |',
    '| ---- | -------------- |',
    ...writes.map(row),
  ].join('\n')
}

/** The placeholders a topic may use, and what fills them. */
export const DOC_PLACEHOLDERS = ['topics', 'node-kinds', 'mcp-tools'] as const

export function renderTopic(topic: DocTopic, tools: DocToolEntry[]): string {
  const fill: Record<(typeof DOC_PLACEHOLDERS)[number], () => string> = {
    topics: topicIndex,
    'node-kinds': nodeKindTable,
    'mcp-tools': () => toolTable(tools),
  }
  const body = topic.body.replaceAll(/\{\{([a-z-]+)\}\}/g, (whole: string, name: string) => {
    const render = (fill as Record<string, (() => string) | undefined>)[name]
    return render ? render() : whole
  })
  return `# ${topic.title}\n\n${body}\n`
}

// ── Search ──────────────────────────────────────────────────────────────────

export type DocSearchHit = {
  topic: string
  heading: string
  text: string
}

/** A topic cut at its `##` headings — the unit a search returns. */
function sections(topic: DocTopic): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = []
  let heading = topic.title
  let lines: string[] = []
  const flush = () => {
    const text = lines.join('\n').trim()
    if (text) out.push({ heading, text })
  }
  for (const line of topic.body.split('\n')) {
    const m = /^## (\S.*)$/.exec(line)
    if (m) {
      flush()
      heading = m[1] ?? heading
      lines = []
    } else {
      lines.push(line)
    }
  }
  flush()
  return out
}

/**
 * Sections that mention the query's words, best first.
 *
 * Plain term matching rather than anything clever: the vocabulary here is
 * exact (`fastTrack`, `continueOnError`, `race`), and a reader searching for a
 * config key wants the sections that say it. A section matching more of the
 * terms outranks one repeating a single term; the title and heading count
 * double, so the section ABOUT a thing beats one that mentions it in passing.
 */
export function searchDocs(query: string, limit = 6): DocSearchHit[] {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .filter((w) => w.length > 1),
    ),
  ]
  if (terms.length === 0) return []
  const scored: (DocSearchHit & { score: number })[] = []
  for (const topic of docTopics()) {
    for (const s of sections(topic)) {
      const head = `${topic.title} ${s.heading}`.toLowerCase()
      const body = s.text.toLowerCase()
      let matched = 0
      let weight = 0
      for (const term of terms) {
        const inHead = head.includes(term)
        const count = body.split(term).length - 1
        if (inHead || count > 0) matched++
        weight += (inHead ? 3 : 0) + Math.min(count, 5)
      }
      if (matched === 0) continue
      scored.push({
        topic: topic.id,
        heading: s.heading,
        text: s.text,
        score: matched * 100 + weight,
      })
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...hit }) => hit)
}
