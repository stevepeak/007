import {
  convertToModelMessages,
  generateObject,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  NoObjectGeneratedError,
  wrapLanguageModel,
} from 'ai'

import { BOOLEAN_OUTPUT_SCHEMA } from '../agent-output'
import type { JsonSchema } from '../agent-output-scan'
import type { AgentOutput } from '../graph'
import { MODEL_MAX_RETRIES } from '../model-budget'
import type { StreamSink } from '../stream-sink'
import { strictifyJsonSchema } from '../strict-schema'

import {
  armTotalBudget,
  logModelCallEnd,
  logModelCallStart,
  runGuarded,
  type BudgetGuard,
} from './agent-generation-guard'
import {
  recordedMessages,
  type AgentNodeMeta,
  type AgentNodeResult,
  type RunAgentGenerationArgs,
} from './agent-generation-types'

// Everything about asking a model for an OBJECT rather than prose: the schema it
// is held to, the call that issues it, how the answer is read back, and how it is
// shaped into a node result.
//
// Two paths reach a structured answer and they share every piece here, which is
// the reason this is one module rather than a branch inside each:
//
//   • `runStructuredGeneration` — one round-trip, no tools to call. Below.
//   • the tool loop's answering turn — `withResponseFormat` puts the schema on
//     the one turn that was denied tools, `parseObject` reads it back, and
//     `issueStructured` is the transcript-formatting fallback when the model
//     answered early in prose. See `agent-generation.ts`.

/**
 * How many times one structured call may be issued before giving up.
 *
 * A structured call can come back unusable in a way the AI SDK does NOT retry:
 * `maxRetries` covers transport-level rejections (429, 503), while a response
 * that arrives intact but isn't the object the schema asked for — truncated
 * mid-JSON, or valid JSON of the wrong shape — throws `NoObjectGeneratedError`
 * on the first occurrence. Observed in production as a body consisting of a
 * lone `{`.
 *
 * The dispatch's step-level retry does eventually catch it, but at the price of
 * replaying the ENTIRE node closure after a backoff — for a document-reading
 * agent, that's the whole source re-sent to the model seconds later. Re-issuing
 * the one call here is the cheap fix for a flake; the step retry stays as the
 * backstop for a failure that survives it. Both attempts run under the same
 * total-budget guard, so this can't extend a node past its budget.
 */
const STRUCTURED_MAX_ATTEMPTS = 2

// generateObject path — the structured-object and YES/NO output kinds, when
// there is nothing to call: no tools, or one turn (which never calls tools —
// see `prepareStep`). One round-trip, the parsed object as the node output.
// A structured agent WITH tools and room to call them runs the tool loop below
// instead, and takes its object from the loop's final turn.
export async function runStructuredGeneration(
  args: RunAgentGenerationArgs,
): Promise<AgentNodeResult> {
  const {
    model,
    modelId,
    output,
    contextLength,
    systemPrompt,
    messages,
    sink,
    budget,
  } = args
  // Only reached for the object / boolean kinds, so the schema is always there.
  const schema = structuredSchema(output)!
  const startedAt = logModelCallStart(sink, modelId, { mode: output.kind })
  // `generateObject` accepts no `timeout` config — only `abortSignal` — and
  // every attempt shares the one guard, so the total budget bounds the node
  // however many times the call is re-issued.
  const guard = armTotalBudget(budget)
  const messagesForModel = await convertToModelMessages(messages)
  const result = await runGuarded(sink, modelId, startedAt, guard, () => {
    return issueStructured({
      model,
      modelId,
      systemPrompt,
      messages: messagesForModel,
      schema,
      guard,
      sink,
    })
  })
  logModelCallEnd(sink, modelId, startedAt, {
    finishReason: result.finishReason,
  })
  const meta: AgentNodeMeta = {
    model: modelId,
    systemPrompt,
    messages: recordedMessages(messages),
    steps: [
      {
        stepNumber: 0,
        finishReason: result.finishReason,
        text: JSON.stringify(result.object),
        toolCalls: [],
        usage: result.usage
          ? {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            }
          : undefined,
      },
    ],
    totalUsage: {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    },
    ...(contextLength != null ? { contextLength } : {}),
  }
  return structuredResult(output, result.object, meta)
}

/**
 * One structured call, re-issued once if the object comes back unusable.
 *
 * Only an unusable OBJECT is re-issued. A provider rejection has already
 * exhausted `maxRetries` inside the call, and an overrun means there is no
 * budget left to spend on another round-trip. Callers run it under
 * `runGuarded`, which owns the guard's lifetime and the failure log line.
 */
export async function issueStructured(args: {
  model: LanguageModel
  modelId: string
  systemPrompt: string
  messages: ModelMessage[]
  schema: JsonSchema
  guard: Pick<BudgetGuard, 'signal' | 'overran'>
  sink?: StreamSink
}) {
  const { model, modelId, systemPrompt, messages, schema, guard, sink } = args
  for (let attempt = 1; ; attempt++) {
    try {
      return await generateObject({
        model,
        system: systemPrompt,
        messages,
        schema: jsonSchema(schema),
        abortSignal: guard.signal,
        maxRetries: MODEL_MAX_RETRIES,
      })
    } catch (err) {
      if (
        attempt >= STRUCTURED_MAX_ATTEMPTS ||
        !NoObjectGeneratedError.isInstance(err) ||
        guard.overran()
      ) {
        throw err
      }
      // The retry is otherwise invisible: `runGuarded` logs the outcome of
      // the LAST attempt only, so without this line a run that flaked and
      // recovered looks identical to one that worked first time.
      void sink?.log?.({
        level: 'warn',
        message: `⟳ ${modelId} returned no usable object (finish: ${err.finishReason ?? 'unknown'}) — re-issuing`,
        meta: { attempt, finishReason: err.finishReason },
      })
    }
  }
}

/**
 * Shape a parsed structured object into the node result. A YES/NO agent doubles
 * as a decision: its `answer` routes the node's yes/no edges (the `object` kind
 * produces data only, never routes). The full decision object still flows
 * downstream as the node's output. Shared by both structured paths — the
 * single-call one and the tool loop's final turn — so the two can't drift.
 */
export function structuredResult(
  output: AgentOutput,
  object: unknown,
  meta: AgentNodeMeta,
): AgentNodeResult {
  const obj = object as Record<string, unknown>
  if (output.kind === 'boolean') {
    return {
      output: obj,
      meta,
      decision: obj.answer ? 'yes' : 'no',
      decisionReasoning: typeof obj.reason === 'string' ? obj.reason : '',
    }
  }
  return { output: obj, meta }
}

/**
 * The strict JSON Schema a structured kind asks the model for; null for text.
 *
 * Run through `strictifyJsonSchema` even though the Zod-source compiler already
 * emits the strict shape: an `object` schema can also arrive from a stored agent
 * config written before the compiler enforced it, and a schema the provider
 * silently drops looks like a flaky model, not a bad schema.
 */
export function structuredSchema(output: AgentOutput): Record<string, unknown> | null {
  if (output.kind === 'text') return null
  return strictifyJsonSchema(
    output.kind === 'object' ? output.schema : BOOLEAN_OUTPUT_SCHEMA,
  )
}

export function parseObject(text: string, answered: boolean): unknown {
  if (!answered || text.trim() === '') return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The same model, with the schema forced onto its response format.
 *
 * The schema reaches the provider on the ANSWERING turn only. A provider that
 * enforces a response format with constrained decoding never emits a tool call
 * under it — measured on Venice/DeepSeek: the same prompt calls the tool every
 * time without `response_format` and answers straight away, in JSON, every time
 * with it. So research turns go out bare and `prepareStep` swaps this in for
 * exactly the turn where tools are denied.
 *
 * A model given by ID can't be wrapped, and neither can a text agent's (there is
 * no schema): both get the model back unchanged, and the tool loop's
 * transcript-formatting call does the shaping instead.
 */
export function withResponseFormat(
  model: LanguageModel,
  schema: Record<string, unknown> | null,
): LanguageModel {
  if (!schema || typeof model === 'string') return model
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: ({ params }) => {
        return Promise.resolve({
          ...params,
          responseFormat: { type: 'json' as const, schema },
        })
      },
    },
  })
}
