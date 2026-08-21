// Builds the question the "Expected output" editor hands the Copilot.
//
// This one is deliberately shaped differently from the Transform node's
// expression helper. There, the editor knows both ends — the input shape and the
// required output — so the prompt asks for an answer outright. Here the editor
// knows only the agent: what it is told to do, what it can call, what shape it
// currently returns. What the author actually WANTS out of it is the one thing
// nothing on the page records.
//
// So the prompt carries the context and then hands the turn back: it asks the
// author to describe the result they need (or what they want changed), and tells
// the Copilot not to guess a schema before that answer. A confidently-invented
// set of fields is worse than a question — the author would have to read it
// closely to notice it solved the wrong problem.
//
// Pure (no React, no queries) so the exact text is testable.

/** How much of the agent's instructions to carry before truncating. */
const PROMPT_EXCERPT_LIMIT = 1200

export type AgentSchemaPromptInput = {
  /** The agent's name, so the Copilot can refer to it. */
  agentName: string
  /** Its one-line description, when the author wrote one. */
  agentDescription?: string
  /** The system prompt — the best available statement of what the agent does. */
  instructions: string
  /** Names of the tools it can call; shapes the vocabulary of its results. */
  toolNames: string[]
  /** The current Zod source, when the author has already written one. */
  currentSource: string
}

function excerpt(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n…(truncated)`
}

export function buildAgentSchemaCopilotPrompt(
  input: AgentSchemaPromptInput,
): string {
  const {
    agentName,
    agentDescription,
    instructions,
    toolNames,
    currentSource,
  } = input

  const editing = currentSource.trim().length > 0
  const lines: string[] = [
    editing
      ? `Help me change the structured output schema for my "${agentName}" agent.`
      : `Help me write the structured output schema for my "${agentName}" agent.`,
    '',
  ]

  if (agentDescription?.trim()) {
    lines.push(`What it's for: ${agentDescription.trim()}`, '')
  }

  if (instructions.trim()) {
    lines.push('Its instructions are:', '', excerpt(instructions, PROMPT_EXCERPT_LIMIT), '')
  } else {
    lines.push(
      'It has no instructions written yet, so its job may need clarifying too.',
      '',
    )
  }

  if (toolNames.length > 0) {
    lines.push(`It can call these tools: ${toolNames.join(', ')}.`, '')
  } else {
    lines.push('It calls no tools — it answers from its instructions alone.', '')
  }

  if (editing) {
    lines.push('It currently returns:', '', currentSource.trim(), '')
  }

  lines.push(
    'The schema is written as a Zod object. Only these are supported, because it is',
    'parsed rather than executed:',
    '  z.string(), z.number(), z.boolean(), z.enum([…]), z.array(…), nested z.object({…}),',
    '  and the .optional() / .nullable() / .int() / .describe("…") chains.',
    'No refinements, transforms, unions, records, dates, or custom types.',
    'Use .describe("…") on each field — the agent sees those descriptions, so they',
    'do real work in getting the field filled in correctly.',
    '',
    // The ask-back. Stated as the FIRST thing to do, and paired with an explicit
    // "don't write it yet", because a model handed this much context will
    // otherwise open with a schema and bury the question underneath it.
    editing
      ? 'Before writing anything: ask me what I want changed about the shape above. Once I have answered, give me the full updated z.object({…}) and say what moved.'
      : 'Before writing anything: ask me what the result needs to contain and how it will be used downstream. Once I have answered, give me the z.object({…}) and a short note on each field.',
  )

  return lines.join('\n')
}
