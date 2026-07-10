// An agent's "expected output" contract and the safe Zod-source → JSON Schema
// compiler that powers the structured-output authoring UI.
//
// The author writes a real Zod schema, e.g.
//
//   z.object({
//     summary: z.string(),
//     riskScore: z.number(),
//     isUrgent: z.boolean(),
//     parties: z.array(z.string()).optional(),
//   })
//
// which we compile to a JSON Schema fed to `generateObject`.
//
// SAFETY: the source is NEVER evaluated. It is tokenized and walked by the
// hand-written recursive-descent parser below, which recognizes only a fixed
// whitelist of `z.*` builders and produces plain JSON Schema data. Anything
// outside the grammar is a hard error, so there is no path from author input to
// code execution — the worst a hostile string can do is fail to compile.

export type JsonSchema = Record<string, unknown>

export type CompileResult =
  | { ok: true; schema: JsonSchema; fields: string[] }
  | { ok: false; error: string }

// ---- Tokenizer -------------------------------------------------------------

type Token = { kind: 'name' | 'punct' | 'string'; value: string; at: number }

class ParseError extends Error {}

const PUNCT = new Set(['.', '(', ')', '{', '}', '[', ']', ',', ':'])

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      let val = ''
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          val += src[j + 1]
          j += 2
          continue
        }
        val += src[j]
        j++
      }
      if (j >= src.length) throw new ParseError('Unterminated string literal.')
      tokens.push({ kind: 'string', value: val, at: i })
      i = j + 1
      continue
    }
    if (/[a-z_$]/i.test(ch)) {
      let j = i + 1
      while (j < src.length && /[\w$]/.test(src[j])) j++
      tokens.push({ kind: 'name', value: src.slice(i, j), at: i })
      i = j
      continue
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch, at: i })
      i++
      continue
    }
    throw new ParseError(`Unexpected character "${ch}".`)
  }
  return tokens
}

// ---- Parser ----------------------------------------------------------------

class Parser {
  private pos = 0
  constructor(private readonly toks: Token[]) {}

  private peek(): Token | undefined {
    return this.toks[this.pos]
  }
  private atEnd(): boolean {
    return this.pos >= this.toks.length
  }
  private expect(kind: Token['kind'], value?: string): Token {
    const t = this.toks[this.pos]
    if (!t || t.kind !== kind || (value !== undefined && t.value !== value)) {
      const want = value ?? kind
      throw new ParseError(
        t
          ? `Expected "${want}" but found "${t.value}".`
          : `Expected "${want}".`,
      )
    }
    this.pos++
    return t
  }

  parseRoot(): JsonSchema {
    const { schema } = this.parseExpr()
    if (!this.atEnd()) {
      throw new ParseError(
        `Unexpected "${this.peek()!.value}" after the schema.`,
      )
    }
    if (schema.type !== 'object') {
      throw new ParseError('The output must be a z.object({ … }).')
    }
    return schema
  }

  // expr := "z" "." builder chain*
  private parseExpr(): { schema: JsonSchema; optional: boolean } {
    this.expect('name', 'z')
    this.expect('punct', '.')
    let schema = this.parseBuilder()
    let optional = false
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '.') {
      this.pos++ // consume '.'
      const method = this.expect('name')
      this.expect('punct', '(')
      switch (method.value) {
        case 'optional':
          this.expect('punct', ')')
          optional = true
          break
        case 'array':
          this.expect('punct', ')')
          schema = { type: 'array', items: schema }
          break
        case 'describe': {
          const text = this.expect('string')
          this.expect('punct', ')')
          schema = { ...schema, description: text.value }
          break
        }
        default:
          throw new ParseError(
            `Unsupported method ".${method.value}()". Use .optional(), .array(), or .describe("…").`,
          )
      }
    }
    return { schema, optional }
  }

  private parseBuilder(): JsonSchema {
    const name = this.expect('name')
    switch (name.value) {
      case 'string':
        this.expect('punct', '(')
        this.expect('punct', ')')
        return { type: 'string' }
      case 'number':
        this.expect('punct', '(')
        this.expect('punct', ')')
        return { type: 'number' }
      case 'boolean':
        this.expect('punct', '(')
        this.expect('punct', ')')
        return { type: 'boolean' }
      case 'enum':
        return this.parseEnum()
      case 'array':
        return this.parseArrayCall()
      case 'object':
        return this.parseObjectCall()
      default:
        throw new ParseError(
          `Unsupported type "z.${name.value}(…)". Use z.string(), z.number(), z.boolean(), z.enum([…]), z.array(…), or z.object({ … }).`,
        )
    }
  }

  private parseEnum(): JsonSchema {
    this.expect('punct', '(')
    this.expect('punct', '[')
    const values: string[] = []
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) {
      values.push(this.expect('string').value)
      if (this.peek()?.kind === 'punct' && this.peek()!.value === ',')
        this.pos++
      else break
    }
    this.expect('punct', ']')
    this.expect('punct', ')')
    if (values.length === 0)
      throw new ParseError('z.enum([…]) needs at least one value.')
    return { type: 'string', enum: values }
  }

  private parseArrayCall(): JsonSchema {
    this.expect('punct', '(')
    const { schema } = this.parseExpr()
    this.expect('punct', ')')
    return { type: 'array', items: schema }
  }

  private parseObjectCall(): JsonSchema {
    this.expect('punct', '(')
    this.expect('punct', '{')
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      const key = this.parseKey()
      if (Object.hasOwn(properties, key)) {
        throw new ParseError(`Duplicate field "${key}".`)
      }
      this.expect('punct', ':')
      const { schema, optional } = this.parseExpr()
      properties[key] = schema
      if (!optional) required.push(key)
      if (this.peek()?.kind === 'punct' && this.peek()!.value === ',')
        this.pos++
      else break
    }
    this.expect('punct', '}')
    this.expect('punct', ')')
    if (Object.keys(properties).length === 0) {
      throw new ParseError('z.object({ … }) needs at least one field.')
    }
    return { type: 'object', properties, required, additionalProperties: false }
  }

  private parseKey(): string {
    const t = this.peek()
    if (t?.kind === 'name' || t?.kind === 'string') {
      this.pos++
      return t.value
    }
    throw new ParseError(
      t
        ? `Expected a field name but found "${t.value}".`
        : 'Expected a field name.',
    )
  }
}

/**
 * Compile a Zod-schema source string into a JSON Schema. Supports the common
 * structured-output subset: z.string/number/boolean/enum, z.array(...),
 * z.object({...}) (nestable), plus the .optional(), .array(), and .describe()
 * chains. The root must be a z.object. Never evaluates the source.
 */
export function compileZodSource(source: string): CompileResult {
  const trimmed = source.trim()
  if (!trimmed) {
    return {
      ok: false,
      error: 'Describe the output shape with z.object({ … }).',
    }
  }
  try {
    const schema = new Parser(tokenize(trimmed)).parseRoot()
    const fields = Object.keys(
      (schema.properties as Record<string, unknown>) ?? {},
    )
    return { ok: true, schema, fields }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof ParseError ? err.message : 'Could not parse the schema.',
    }
  }
}

// A stable JSON Schema for the YES/NO output kind — a boolean `answer` plus a
// short `reason` explaining the decision (surfaced for routing/gate audits).
export const BOOLEAN_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    answer: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['answer', 'reason'],
  additionalProperties: false,
}

// The JSON Schema for the plain-text output kind — the agent's final answer
// under a single `text` field. Mirrors the `{ text }` shape agent nodes emit.
export const TEXT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
}

// The concrete output shape an agent produces, as JSON Schema — so downstream
// nodes can see (and map into) an agent's fields regardless of output kind.
// `AgentOutput` is typed structurally to avoid a runtime import cycle with
// `graph.ts` (which defines it and does not import this module).
export function agentOutputJsonSchema(output: {
  kind: 'text' | 'boolean' | 'object'
  schema?: JsonSchema
}): JsonSchema {
  if (output.kind === 'text') return TEXT_OUTPUT_SCHEMA
  if (output.kind === 'boolean') return BOOLEAN_OUTPUT_SCHEMA
  return output.schema ?? { type: 'object' }
}
