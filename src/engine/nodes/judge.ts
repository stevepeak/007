import { generateObject } from 'ai'
import { z } from 'zod'

import type { ModelFactory } from '../config'
import type { JudgeNode } from '../graph'

// Schema the small model is forced to satisfy. The result drives which
// outgoing edge the scheduler follows; reasoning is persisted on the step row
// for the inspector.
const judgeOutputSchema = z.object({
  result: z.enum(['yes', 'no']),
  reasoning: z.string().min(1).max(500),
})

export type JudgeNodeResult = {
  result: 'yes' | 'no'
  reasoning: string
  meta: {
    model: string
    testQuestion: string
    usage?: { inputTokens?: number; outputTokens?: number }
  }
}

function stringifyContext(input: unknown): string {
  if (typeof input === 'string') {
    return input
  }
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

export type ExecuteJudgeNodeDeps = {
  node: JudgeNode
  /** The prior node's output — provides context for the test question. */
  input: unknown
  getModel: ModelFactory
}

export async function executeJudgeNode(
  deps: ExecuteJudgeNodeDeps,
): Promise<JudgeNodeResult> {
  const { node, input, getModel } = deps
  const model = getModel(node.config.modelId)
  const context = stringifyContext(input)

  const { object, usage } = await generateObject({
    model,
    schema: judgeOutputSchema,
    system:
      'You are a routing classifier. Answer the test question with yes or no based on the provided context. Be decisive — if uncertain, lean toward the answer that lets the workflow proceed.',
    prompt: `Context:\n${context}\n\nTest question: ${node.config.testQuestion}\n\nAnswer the question with yes or no and a one-sentence rationale.`,
  })

  return {
    result: object.result,
    reasoning: object.reasoning,
    meta: {
      model: node.config.modelId,
      testQuestion: node.config.testQuestion,
      usage: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          }
        : undefined,
    },
  }
}
