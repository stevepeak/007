// Shared lexer primitives for the Zod-source tooling. The compiler and formatter
// each have their OWN tokenizer — the compiler unescapes string literals and
// drops comments, while the formatter preserves comments and raw literals — so
// only the genuinely common pieces live here: the JSON-Schema value shape both
// ultimately speak, the punctuation set both recognize, and the parse-error type
// both throw.

export type JsonSchema = Record<string, unknown>

export class ParseError extends Error {}

export const PUNCT = new Set(['.', '(', ')', '{', '}', '[', ']', ',', ':'])
