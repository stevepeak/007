import type { TransformOutputShape } from '../../engine'

import type { DataField } from './node-io'

// Builds the question the Transform inspector hands the Copilot.
//
// The whole value of the affordance is that the user does not have to describe
// their data — the editor already knows its shape, so the question arrives
// carrying it. A bare "help me write JSONata" would make the Copilot guess at
// field names and hand back an expression against an imagined record; including
// the real outline is what makes the answer runnable.
//
// Kept as a pure function (no React, no queries) so the exact text is testable.

/** What each declared output shape actually has to look like, in prose. */
const SHAPE_REQUIREMENTS: Record<TransformOutputShape, string> = {
  conversation: [
    'The result must be an array of AI-SDK UIMessage objects. Each element needs:',
    '  - "role": "user", "assistant" or "system" — no other value is accepted.',
    '  - "parts": a non-empty array of content parts, e.g. [{ "type": "text", "text": "…" }].',
    '  - "id" is optional.',
    'If the source records use roles outside that set, map them onto one of the three',
    'and fold the distinction into the text instead of inventing a new role.',
  ].join('\n'),
}

/** Renders a field tree as an indented `name: type` outline, depth-capped. */
function outline(fields: DataField[], depth = 0): string[] {
  if (depth > 3) return []
  const pad = '  '.repeat(depth + 1)
  return fields.flatMap((f) => {
    const note = f.description ? ` — ${f.description}` : ''
    const line = `${pad}${f.key}: ${f.type}${note}`
    // An array's element shape matters more than the array itself here: the
    // expression will be mapping over those elements.
    const nested = f.type === 'array' ? (f.items ?? []) : (f.children ?? [])
    return [line, ...outline(nested, depth + 1)]
  })
}

export type TransformPromptInput = {
  /** The transform node's own label, so the Copilot can refer to it. */
  nodeLabel: string
  /** Where the input comes from, in the author's words ("Find Chat · messages"). */
  sourceLabel: string | null
  /** Top-level fields of the bound value. */
  sourceFields: DataField[]
  /** The bound value's own type — "array", "object", "unknown", … */
  sourceType: string
  /** A declared output shape, when the author picked one. */
  outputShape?: TransformOutputShape
  /** Whatever is already in the expression box, if anything. */
  currentExpression: string
}

export function buildTransformCopilotPrompt(
  input: TransformPromptInput,
): string {
  const {
    nodeLabel,
    sourceLabel,
    sourceFields,
    sourceType,
    outputShape,
    currentExpression,
  } = input

  const lines: string[] = [
    `Help me write a JSONata expression for the "${nodeLabel}" transform step in my workflow.`,
    '',
  ]

  // The input shape. When the editor can't resolve it (an unconfigured upstream,
  // or a producer whose output is genuinely opaque), say so plainly rather than
  // presenting an empty outline as if it were the real shape.
  const where = sourceLabel ? ` It comes from ${sourceLabel}.` : ''
  if (sourceFields.length > 0) {
    lines.push(
      `The expression runs over a value of type \`${sourceType}\`.${where} Its shape is:`,
      '',
      ...outline(sourceFields),
      '',
    )
  } else if (sourceType !== 'unknown') {
    lines.push(
      `The expression runs over a value of type \`${sourceType}\`.${where} The editor cannot see its field names, so ask me for a sample if you need one.`,
      '',
    )
  } else {
    lines.push(
      `The expression runs over an upstream value whose shape the editor cannot determine.${where} Ask me for a sample of it before writing anything.`,
      '',
    )
  }

  if (outputShape) {
    lines.push(
      `It has to produce a "${outputShape}".`,
      SHAPE_REQUIREMENTS[outputShape],
      '',
    )
  } else {
    lines.push('Ask me what the result needs to look like.', '')
  }

  if (currentExpression.trim()) {
    lines.push(
      "Here's what I have so far — tell me what's wrong with it and give me a corrected version:",
      '',
      currentExpression.trim(),
      '',
    )
  }

  lines.push(
    'Notes on the dialect, so the expression actually runs:',
    '  - `$` is the input value described above; any extra values I bind are `$name`.',
    '  - JSONata collapses a single-element result to a bare value, so if the result',
    '    must always be a list, wrap the whole expression in the `[ ... ]` array',
    '    constructor — otherwise a one-element input silently returns an object.',
    '',
    'Reply with the expression itself, then a short explanation of how it maps each field.',
  )

  return lines.join('\n')
}
