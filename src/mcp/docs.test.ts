import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'

import { WF_NODE_KINDS } from '../engine/graph-kinds'
import {
  agentConfigSchema,
  nodeExecutionSchema,
  subAgentsConfigSchema,
  workflowEdgeSchema,
  workflowNodeSchema,
} from '../engine/graph-schema'

import { allTools } from './catalog'
import { readTopicSources } from './docs/read-sources'
import {
  DOC_PLACEHOLDERS,
  docTopics,
  findTopic,
  OVERVIEW_TOPIC,
  renderTopic,
} from './docs/registry'
import { DOC_SOURCES } from './docs/sources.generated'
import { PATCH_OPS } from './tools-workflows'

// The MCP docs are only worth reading if they describe THIS build. Prose does
// not fail to compile when the code moves under it, so every way the docs can
// drift from the code is a test here — and each failure names the topic file
// to edit. See AGENTS.md § "The MCP documentation".

/** Peel wrappers (`.default()`, `.optional()`, `.refine()`, `preprocess`) off a schema. */
function unwrapObject(schema: z.ZodType): Record<string, z.ZodType> | null {
  let current = schema as z.ZodType & {
    def?: { innerType?: z.ZodType; out?: z.ZodType; in?: z.ZodType }
    shape?: Record<string, z.ZodType>
  }
  for (let depth = 0; depth < 8; depth++) {
    if (current.shape) return current.shape
    const next = current.def?.innerType ?? current.def?.out
    if (!next) return null
    current = next
  }
  return null
}

function keysOf(schema: z.ZodType): string[] {
  return Object.keys(unwrapObject(schema) ?? {})
}

function topicText(id: string): string {
  const topic = findTopic(id)
  if (!topic) throw new Error(`docs topic ${id} is missing`)
  return topic.body
}

/** Keys the text never mentions as `key` (or `key:` / `config.key`). */
function undocumented(text: string, keys: string[]): string[] {
  return keys.filter((k) => {
    return !new RegExp(`\`[^\`]*\\b${k}\\b[^\`]*\``).test(text)
  })
}

describe('MCP docs ↔ sources', () => {
  test('sources.generated.ts matches topics/ — run `bun run docs:mcp`', () => {
    expect(DOC_SOURCES).toEqual(readTopicSources())
  })

  test('every topic parses and the overview exists', () => {
    expect(docTopics().length).toBeGreaterThan(5)
    expect(findTopic(OVERVIEW_TOPIC)).toBeDefined()
  })
})

describe('MCP docs ↔ the engine', () => {
  test('every node kind has a page', () => {
    const missing = WF_NODE_KINDS.filter((k) => !findTopic(`nodes/${k}`))
    expect(missing).toEqual([])
  })

  test('every node kind’s page names every config key', () => {
    const gaps: Record<string, string[]> = {}
    for (const option of workflowNodeSchema.options) {
      const kind = (option.shape.kind as z.ZodLiteral<string>).value
      const keys = keysOf(option.shape.config as z.ZodType)
      const missing = undocumented(topicText(`nodes/${kind}`), keys)
      if (missing.length > 0) gaps[`topics/nodes/${kind}.md`] = missing
    }
    expect(gaps).toEqual({})
  })

  test('`execution` names every per-node policy field and edge field', () => {
    const text = topicText('execution')
    expect(undocumented(text, keysOf(nodeExecutionSchema))).toEqual([])
    expect(undocumented(text, ['fastTrack', 'condition', 'informUser'])).toEqual(
      [],
    )
  })

  test('`graph` names every edge field', () => {
    expect(undocumented(topicText('graph'), keysOf(workflowEdgeSchema))).toEqual(
      [],
    )
  })

  test('`agents` names every agent config key', () => {
    expect(undocumented(topicText('agents'), keysOf(agentConfigSchema))).toEqual(
      [],
    )
  })

  test('`agents/sub-agents` names every delegation key', () => {
    expect(
      undocumented(topicText('agents/sub-agents'), keysOf(subAgentsConfigSchema)),
    ).toEqual([])
  })
})

describe('MCP docs ↔ the catalog', () => {
  // `patch_workflow_draft` op names look like tool names and are documented as
  // such in `authoring`; they are real, just not tools.
  const real = new Set<string>([
    ...allTools().map((t) => t.name),
    ...PATCH_OPS,
  ])
  const toolish =
    /`([a-z]+(?:_[a-z0-9]+)+)(?:\(|`)/g
  const verbs =
    /^(?:list|get|create|update|delete|run|draft|patch|publish|validate|discard|set|refresh|retry|cancel|resume|triage|upsert)_/

  test('every MCP tool a page names exists', () => {
    const phantom: string[] = []
    for (const topic of docTopics()) {
      for (const m of topic.body.matchAll(toolish)) {
        const name = m[1] ?? ''
        if (verbs.test(name) && !real.has(name)) {
          phantom.push(`${topic.id}: ${name}`)
        }
      }
    }
    expect(phantom).toEqual([])
  })

  test('`authoring` documents every patch_workflow_draft op', () => {
    expect(undocumented(topicText('authoring'), [...PATCH_OPS])).toEqual([])
  })

  test('every [[link]] resolves to a topic', () => {
    const broken: string[] = []
    for (const topic of docTopics()) {
      for (const m of topic.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
        if (!docTopics().some((t) => t.id === m[1])) {
          broken.push(`${topic.id} → ${m[1]}`)
        }
      }
    }
    expect(broken).toEqual([])
  })

  test('every {{placeholder}} is one the renderer fills', () => {
    const known = new Set<string>(DOC_PLACEHOLDERS)
    const unknown: string[] = []
    for (const topic of docTopics()) {
      for (const m of topic.body.matchAll(/\{\{([a-z-]+)\}\}/g)) {
        if (!known.has(m[1] ?? '')) unknown.push(`${topic.id}: ${m[0]}`)
      }
    }
    expect(unknown).toEqual([])
  })

  test('the overview renders the dictionaries', () => {
    const tools = allTools()
    const text = renderTopic(findTopic(OVERVIEW_TOPIC)!, tools)
    for (const kind of WF_NODE_KINDS) expect(text).toContain(`\`${kind}\``)
    for (const t of tools) expect(text).toContain(`\`${t.name}\``)
    expect(text).not.toMatch(/\{\{[a-z-]+\}\}/)
  })
})

describe('MCP docs are host-neutral', () => {
  // 007 is a public SDK. A host's product, customers and tools have no place in
  // its manual — host-specific behaviour belongs in that host's tool
  // descriptions.
  test('no host or domain names', () => {
    const banned =
      /\b(?:sidebar|goodbridge|artisan|1121|attorney|lawyer|dingduff|jev)\b/i
    const hits = docTopics()
      .filter((t) => banned.test(t.body))
      .map((t) => `${t.id}: ${banned.exec(t.body)?.[0]}`)
    expect(hits).toEqual([])
  })
})
