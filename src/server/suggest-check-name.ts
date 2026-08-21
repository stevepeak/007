import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'

import type { RunContext } from '../engine/config'

// Naming an eval Check from its rubric.
//
// A judge Check asserts something in free-text prose, so — unlike the
// deterministic checks, which can name themselves off their own fields — it
// needs a model to compress that prose into an assertion: "The response should
// mention the alimony amount somewhere in the title" → "Has correct title".
//
// This exists because the reason Checks go unnamed is that naming is *extra
// work* on top of writing the rubric. The suggestion removes the work; the
// author accepts it, sees a well-formed name, and starts writing their own that
// way. It is only ever offered — never written for them.

const suggestionSchema = z.object({
  name: z
    .string()
    .describe(
      'A short assertion naming what the rubric checks for. 2–5 words, starting with a third-person verb.',
    ),
})

/** Trim a model's answer down to something that fits a title field. */
export function cleanSuggestedName(raw: string): string {
  let name = raw.trim()
  // Models like to wrap the answer in quotes or end it with a period; neither
  // belongs in a name.
  name = name.replaceAll(/^["'“”]+|["'“”]+$/g, '').replace(/[.!]+$/, '')
  // A model that ignored the brief and returned a sentence gets truncated to
  // its first clause rather than filling the title bar with prose.
  const clause = name.split(/[,;:—]/)[0].trim()
  if (clause.length >= 3) name = clause
  if (name.length > 60) name = `${name.slice(0, 60).trimEnd()}…`
  return name
}

/**
 * Suggest an assertion-voice name for a judge rubric. Throws on a provider or
 * parse failure — the caller decides what to do, and every current caller
 * simply drops the suggestion (the field keeps its example placeholder).
 */
export async function suggestCheckNameFromRubric(input: {
  /** The host's model factory (from `WfSdkConfig.getModel`). */
  getModel: (modelId: string, ctx: RunContext) => LanguageModel
  modelId: string
  /** The host's live bindings, passed through to `getModel`. Opaque to the SDK. */
  env: unknown
  rubric: string
}): Promise<string> {
  const model = input.getModel(input.modelId, {
    triggerKind: '__suggest_check_name__',
    // Naming a rubric is a compression task, not a reasoning one — and this
    // call sits in front of a text field the author is waiting on, so latency
    // is the budget that matters.
    reasoning: false,
    env: input.env,
    promptVariables: {},
  })

  const { object } = await generateObject({
    model,
    schema: suggestionSchema,
    prompt: [
      'Name an evaluation check, given the rubric it grades against.',
      '',
      'The name is an assertion about the response being graded — it completes',
      'the sentence "this response…". Start with a third-person verb such as',
      'Has, Mentions, Cites, Avoids, Asks for, Calls, or Stays. Keep it to 2–5',
      'words. Name the specific thing being checked, do not restate the whole',
      'rubric, and do not describe the mechanism (never "judge", "check",',
      '"test", "LLM", or "rubric").',
      '',
      'Examples:',
      'Rubric: "The title should be something mentioning alimony"',
      'Name: Has correct title',
      'Rubric: "Penalize any response that tells the user what they should do legally"',
      'Name: Avoids legal advice',
      'Rubric: "The answer must cite the statute it relies on, by number"',
      'Name: Cites the statute',
      '',
      `Rubric: ${JSON.stringify(input.rubric)}`,
      'Name:',
    ].join('\n'),
  })

  return cleanSuggestedName(object.name)
}
