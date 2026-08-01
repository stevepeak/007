// The safe Zod-source → JSON Schema compiler that powers the structured-output
// authoring UI.
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

import { type JsonSchema, ParseError, PUNCT } from './agent-output-scan'

export type CompileResult =
  | { ok: true; schema: JsonSchema; fields: string[] }
  | { ok: false; error: string }

// ---- Tokenizer -------------------------------------------------------------

type Token = { kind: 'name' | 'punct' | 'string'; value: string; at: number }

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    // Comments — annotation only, dropped before parsing. Line comments start
    // with `//` or `#` and run to the newline; block comments are `/* … */`.
    if ((ch === '/' && src[i + 1] === '/') || ch === '#') {
      let j = ch === '#' ? i + 1 : i + 2
      while (j < src.length && src[j] !== '\n') j++
      i = j
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++
      if (j >= src.length) throw new ParseError('Unterminated block comment.')
      i = j + 2
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
        case 'nullable':
          this.expect('punct', ')')
          // Mirror Zod v4's JSON Schema output: a union of the type with null.
          // A following `.describe()` then spreads the description onto the
          // outer node, matching how the seeded schemas serialize.
          schema = { anyOf: [schema, { type: 'null' }] }
          break
        case 'int':
          this.expect('punct', ')')
          if (schema.type !== 'number' && schema.type !== 'integer') {
            throw new ParseError('.int() applies to z.number().')
          }
          schema = { type: 'integer' }
          break
        case 'describe': {
          const text = this.expect('string')
          this.expect('punct', ')')
          schema = { ...schema, description: text.value }
          break
        }
        default:
          throw new ParseError(
            `Unsupported method ".${method.value}()". Use .optional(), .nullable(), .int(), .array(), or .describe("…").`,
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
      const { schema } = this.parseExpr()
      properties[key] = schema
      // Strict structured outputs (OpenAI/Venice `response_format: json_schema`)
      // require EVERY property to appear in `required`. A key left OUT of
      // `required` makes the provider rewrite the field as an `anyOf` union —
      // and for an array that rewrite drops `items`, which Venice rejects with a
      // 400 ("array schema missing items"). So every field is always required.
      // `.optional()` is still accepted in the source (authoring intent) but no
      // longer relaxes the schema; an unfilled field comes back as an empty
      // value, which downstream normalizers already tolerate.
      required.push(key)
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
