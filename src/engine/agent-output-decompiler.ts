// The JSON Schema → Zod source decompiler.

import type { JsonSchema } from './agent-output-scan'

/**
 * Best-effort inverse of `compileZodSource`: render a JSON Schema back to
 * editable Zod source, so an agent whose output schema was authored in code
 * (and therefore has an empty round-trip `source`) still shows its real shape in
 * the editor instead of a blank box. Covers the same subset the compiler
 * accepts — object / string / number / integer / boolean / enum / array, the
 * `anyOf`-with-null nullable shape, and descriptions. Anything outside that
 * subset degrades to `z.string()` so the result always stays parseable. Returns
 * '' for a missing or empty-object schema (nothing meaningful to show).
 */
export function zodSourceFromJsonSchema(
  schema: JsonSchema | undefined,
): string {
  if (!schema || typeof schema !== 'object') return ''
  const props = schema.properties as Record<string, JsonSchema> | undefined
  if (schema.type === 'object' && (!props || Object.keys(props).length === 0)) {
    return ''
  }
  return renderNode(schema, 0)
}

function quote(text: string): string {
  return JSON.stringify(text)
}

function renderKey(key: string): string {
  return /^[A-Z_$][\w$]*$/i.test(key) ? key : quote(key)
}

function renderNode(node: JsonSchema, depth: number): string {
  const description =
    typeof node.description === 'string' ? node.description : undefined
  const suffix = description ? `.describe(${quote(description)})` : ''

  // Nullable — Zod v4 emits `anyOf: [<inner>, { type: 'null' }]`, with any
  // description hoisted onto this outer node (rendered via `suffix`).
  if (Array.isArray(node.anyOf)) {
    const members = node.anyOf as JsonSchema[]
    const nonNull = members.filter(
      (m) => !(m && typeof m === 'object' && m.type === 'null'),
    )
    const nullable = nonNull.length !== members.length
    const inner = nonNull[0] ?? { type: 'string' }
    return `${renderNode(inner, depth)}${nullable ? '.nullable()' : ''}${suffix}`
  }

  switch (node.type) {
    case 'string':
      if (Array.isArray(node.enum) && node.enum.length > 0) {
        const vals = (node.enum as unknown[])
          .map((v) => quote(String(v)))
          .join(', ')
        return `z.enum([${vals}])${suffix}`
      }
      return `z.string()${suffix}`
    case 'number':
      return `z.number()${suffix}`
    case 'integer':
      return `z.number().int()${suffix}`
    case 'boolean':
      return `z.boolean()${suffix}`
    case 'array': {
      const items =
        node.items && typeof node.items === 'object'
          ? renderNode(node.items as JsonSchema, depth)
          : 'z.string()'
      return `z.array(${items})${suffix}`
    }
    case 'object': {
      const props = (node.properties as Record<string, JsonSchema>) ?? {}
      const keys = Object.keys(props)
      if (keys.length === 0) return `z.object({})${suffix}`
      const pad = '  '.repeat(depth + 1)
      const close = '  '.repeat(depth)
      const body = keys
        .map((k) => `${pad}${renderKey(k)}: ${renderNode(props[k], depth + 1)},`)
        .join('\n')
      return `z.object({\n${body}\n${close}})${suffix}`
    }
    default:
      return `z.string()${suffix}`
  }
}
