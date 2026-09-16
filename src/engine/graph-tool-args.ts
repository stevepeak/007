import type { JsonSchema } from './agent-output-scan'
import type { ToolNode, WorkflowGraph, WorkflowNode } from './graph'
import type { GraphIssue } from './graph-issues'

// Tool-node argument drift. A Tool node stores its args as bindings authored
// against the tool's input schema AT AUTHORING TIME — and the schema keeps
// moving after that. Nothing reconciles the two: `executeToolNode` runs
// `inputSchema.parse(rawArgs)` and the run fails, at the node, on the first
// message that reaches it. The failure that motivated this (ART-146) was a
// renamed field (`note` → `internalNote` / `publicNote`) plus a boolean stored
// as the string "false" — three ZodErrors, visible only after a customer was
// told "your attorney has been notified" while nothing had been written.
//
// This lint is the author-time counterpart of that parse. It is deliberately a
// pure function over JSON Schema (not zod): the editor holds JSON Schema from
// `listTools`, the server holds zod and converts with `toJsonSchema`, and one
// function over the common form keeps the two surfaces from disagreeing about
// what is wrong. It cannot see through a `ref` binding — an upstream value is
// unknown until the run — so those pass; a wrong-shaped ref stays a run-time
// error, as it is today.

/** Input schema per tool id — `undefined` for a tool that declares none. */
export type ToolInputSchemas = ReadonlyMap<string, JsonSchema | undefined>

const JSON_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
])

/**
 * The JSON types a property schema admits, or null when it is opaque — no
 * `type`, a `$ref`, a union of two real shapes, `{}` from an unrepresentable
 * zod node. Opaque means "don't judge", never "reject".
 */
function admittedTypes(schema: JsonSchema | undefined): Set<string> | null {
  if (!schema) return null
  const out = new Set<string>()
  const add = (t: unknown) => {
    if (t === 'integer') out.add('number')
    else if (typeof t === 'string' && JSON_TYPES.has(t)) out.add(t)
  }
  const type = schema.type
  if (typeof type === 'string') add(type)
  else if (Array.isArray(type)) for (const t of type) add(t)
  const branches = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined
  if (Array.isArray(branches)) {
    for (const b of branches) {
      const inner = admittedTypes(b)
      // One opaque branch makes the whole union opaque.
      if (!inner) return null
      for (const t of inner) out.add(t)
    }
  }
  return out.size > 0 ? out : null
}

/** The `enum` a property schema pins, across a nullable wrapper. */
function admittedEnum(schema: JsonSchema | undefined): unknown[] | null {
  if (!schema) return null
  if (Array.isArray(schema.enum)) return schema.enum as unknown[]
  const branches = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined
  if (!Array.isArray(branches)) return null
  const enums = branches
    .filter((b) => b?.type !== 'null')
    .map((b) => (Array.isArray(b?.enum) ? (b.enum as unknown[]) : null))
  const only = enums[0]
  if (enums.length !== 1 || !only) return null
  const nullable = branches.some((b) => b?.type === 'null')
  return nullable ? [...only, null] : only
}

function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v === 'object' ? 'object' : typeof v
}

function describe(v: unknown): string {
  const s = JSON.stringify(v)
  return s.length > 40 ? `${s.slice(0, 37)}…` : s
}

/**
 * Every tool node in the graph — including those inside iteration subgraphs,
 * which are the ones an author is least likely to re-open after a schema
 * change.
 */
function* toolNodes(nodes: WorkflowNode[]): Generator<ToolNode> {
  for (const n of nodes) {
    if (n.kind === 'tool') yield n
    else if (n.kind === 'iteration') yield* toolNodes(n.config.subgraph.nodes)
  }
}

/**
 * Issues where a Tool node's args no longer fit the tool's declared input:
 *
 * - the tool id is not in the catalog at all (renamed, or a connector that
 *   was disconnected) — error
 * - an arg key the schema does not declare (a field that was renamed away;
 *   the engine drops it silently and the value is lost) — error
 * - a required field with no binding at all (the engine sends `undefined`) —
 *   error
 * - a literal whose JSON type the field does not admit, or a value outside the
 *   field's enum — error
 *
 * Errors, all of them, because each one is a guaranteed ZodError at the node
 * rather than a degraded run. A tool with no input schema, or a property whose
 * schema is opaque, is not judged.
 */
export function collectToolArgIssues(
  graph: WorkflowGraph,
  tools: ToolInputSchemas,
): GraphIssue[] {
  const issues: GraphIssue[] = []
  for (const node of toolNodes(graph.nodes)) {
    const base = { nodeId: node.id, nodeLabel: node.label } as const
    const toolId = node.config.toolId
    if (!tools.has(toolId)) {
      issues.push({
        ...base,
        severity: 'error',
        message: `Tool "${toolId}" is not in the tool catalog, so this node cannot run. Pick a tool that exists.`,
      })
      continue
    }
    const schema = tools.get(toolId)
    if (!schema || schema.type !== 'object') continue
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>
    const required = new Set((schema.required as string[] | undefined) ?? [])
    const args = node.config.args

    for (const key of required) {
      if (args[key] == null) {
        issues.push({
          ...base,
          severity: 'error',
          message: `Required argument "${key}" of ${toolId} isn’t linked to any data — the run sends it as undefined and the tool rejects the call.`,
        })
      }
    }

    for (const [key, binding] of Object.entries(args)) {
      const prop = props[key]
      if (!prop) {
        issues.push({
          ...base,
          severity: 'error',
          message: `Argument "${key}" is not an input of ${toolId} any more — the value is dropped before the tool runs. Remove it, or bind the field it was renamed to.`,
        })
        continue
      }
      if (binding.kind !== 'literal') continue
      const value = binding.value
      const types = admittedTypes(prop)
      const actual = jsonTypeOf(value)
      if (types && !types.has(actual)) {
        const want = [...types].join(' or ')
        const meant = actual === 'string' ? coerce(value as string) : value
        const hint =
          actual === 'string' && types.has(jsonTypeOf(meant))
            ? ` Store the ${want} ${describe(meant)}, not the text ${describe(value)}.`
            : ''
        issues.push({
          ...base,
          severity: 'error',
          message: `Argument "${key}" of ${toolId} expects ${want} but the literal is ${actual} ${describe(value)} — the tool rejects the call.${hint}`,
        })
        continue
      }
      const options = admittedEnum(prop)
      if (options && !options.includes(value)) {
        issues.push({
          ...base,
          severity: 'error',
          message: `Argument "${key}" of ${toolId} must be one of ${options.map(describe).join(', ')} — the literal is ${describe(value)}.`,
        })
      }
    }
  }
  return issues
}

/** What a text literal was probably meant to be — "false" → false, "3" → 3. */
function coerce(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  const n = Number(raw)
  return raw.trim() !== '' && !Number.isNaN(n) ? n : raw
}
