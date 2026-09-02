import type { z } from 'zod'

import { allTools } from './catalog'

// The catalog as DATA, for a surface that documents the tools rather than calls
// them — a host's "connect the MCP" page, a generated README table.
//
// It exists because the alternative is a hand-written table, and a hand-written
// table of 24 tools drifts the first time someone adds the 25th. Every field
// here is read off the same definitions `wf-mcp` registers and the System
// Copilot binds, so a tool that ships is a tool that is listed, with the
// description the model actually sees.
//
// Deliberately JSON-serializable and zod-free at the boundary: the caller is
// typically a server component that hands the result straight to a client
// component, and a `ZodType` cannot cross that line.

/** One argument of a tool, as documentation. */
export interface WfMcpToolArg {
  name: string
  /** False when the schema accepts `undefined` — i.e. the arg may be omitted. */
  required: boolean
  /** The primitive kind, unwrapped past `optional`/`nullable`. */
  type: string
  /** The `.describe()` text the model is shown, when there is one. */
  description?: string
}

/** One tool, as documentation. */
export interface WfMcpToolDescription {
  name: string
  title: string
  description: string
  /** False for anything that mutates — these exist only behind `--write`. */
  readOnly: boolean
  args: WfMcpToolArg[]
}

/**
 * Peel `optional` / `nullable` / `default` wrappers off a schema.
 *
 * `.nullish()` is two wrappers deep, and the interesting facts — the primitive
 * kind, and (when `.describe()` was called before the wrap rather than after)
 * the description — sit underneath both.
 */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema as z.ZodType & { def?: { innerType?: z.ZodType } }
  // Bounded rather than `while (true)`: a self-referential schema would
  // otherwise spin here, and no real wrapper stack is this deep.
  for (let depth = 0; depth < 8; depth++) {
    const inner = current.def?.innerType
    if (!inner) break
    current = inner
  }
  return current
}

function describeArg(name: string, schema: z.ZodType): WfMcpToolArg {
  const inner = unwrap(schema)
  return {
    name,
    // The schema's own answer to "may this be omitted", rather than a guess
    // from the wrapper names — `.default()` is optional too, and reads as one
    // more wrapper from the outside.
    required: !schema.safeParse(undefined).success,
    type: (inner as { def?: { type?: string } }).def?.type ?? 'unknown',
    description: schema.description ?? inner.description,
  }
}

/**
 * Every tool this build exposes, read and write alike, as plain data.
 *
 * Writes are included and flagged rather than filtered: a page that documents
 * the surface should say what `--write` unlocks. A surface that *serves* tools
 * still gates them with `selectTools`.
 */
export function describeToolCatalog(): WfMcpToolDescription[] {
  return allTools().map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    readOnly: tool.readOnly,
    args: Object.entries(tool.inputSchema).map(([name, schema]) =>
      describeArg(name, schema as z.ZodType),
    ),
  }))
}
