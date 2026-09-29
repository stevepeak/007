import { convertToModelMessages, generateText, stepCountIs, streamText } from 'ai'

import { errorFeedLine } from '../error-detail'
import { MODEL_MAX_RETRIES } from '../model-budget'
import { strictifyToolSet } from '../strict-schema'

import {
  canStreamAnswer,
  driveGenerate,
  driveStream,
} from './agent-generation-drive'
import type { DriveArgs, LoopOutcome } from './agent-generation-drive'
import {
  armTotalBudget,
  logModelCallEnd,
  logModelCallStart,
  markNoOutput,
  runGuarded,
} from './agent-generation-guard'
import {
  runStructuredGeneration,
  structuredResult,
  structuredSchema,
  withResponseFormat,
} from './agent-generation-structured'
import {
  createLoopState,
  createOnStepFinish,
  createPrepareStep,
  type AgentLoopState,
} from './agent-generation-turn'
import {
  recordedMessages,
  type AgentNodeMeta,
  type AgentNodeResult,
  type RunAgentGenerationArgs,
} from './agent-generation-types'

// The shared model-loop core, factored out of `executeAgentNode` so a spawned
// sub-agent (see `nodes/sub-agent.ts`) runs the IDENTICAL generation logic — one
// place owns the generateObject / YES-NO / tool-calling-loop behavior, so the two
// entry points can never drift. Callers resolve the model, system prompt,
// messages, and tool set; this owns only how the model is driven and how the
// result is shaped into an {@link AgentNodeResult}.
//
// The pieces live beside this file, one concern each, and this module is the loop
// that composes them:
//   • `-types`      the request/result contract and the recorded meta
//   • `-guard`      the total-budget clock, and which failures are fatal
//   • `-turn`       per-turn policy (`prepareStep`) and tracing (`onStepFinish`)
//   • `-drive`      the two ways the one options object is run
//   • `-structured` everything about asking for an object rather than prose

// Re-exported so every consumer's import path is unchanged — the loop used to be
// one file and these are the symbols it published.
export {
  AGENT_NO_OUTPUT,
  isFatalAgentError,
  TOTAL_BUDGET_OVERRUN,
} from './agent-generation-guard'
export { stepAgentVersion } from './agent-generation-types'
export type {
  AgentNodeMeta,
  AgentNodeResult,
  RunAgentGenerationArgs,
} from './agent-generation-types'

/**
 * The tool-calling agent loop: one `generateText`/`streamText` call whose policy
 * is re-decided every turn.
 *
 * A structured agent runs the SAME loop as a text one — same turn ceiling,
 * context guard, spend budget — and differs only in what its final turn has to
 * write: the schema's object rather than prose. `withResponseFormat` puts the
 * schema on the answering turn only; see `-structured` for why research turns go
 * out bare.
 */
async function runToolLoop(
  args: RunAgentGenerationArgs,
): Promise<AgentNodeResult> {
  const {
    model,
    modelId,
    output,
    maxTurns,
    requireToolFirstTurn,
    toolTokenBudget,
    contextLength,
    answerReservePercent,
    streamReasoning,
    streamToolCalls,
    systemPrompt,
    messages,
    tools,
    toolStatusLabels,
    sink,
    budget,
  } = args
  const schema = structuredSchema(output)
  const answeringModel = withResponseFormat(model, schema)
  const state = createLoopState()
  const guard = armTotalBudget(budget)

  // Heartbeat before the loop opens. Until `onStepFinish` fires — a full model
  // round-trip away — this is the only evidence the node is alive, so it names
  // what it's about to do rather than just that it started.
  const startedAt = logModelCallStart(sink, modelId, {
    mode: output.kind,
    tools: Object.keys(tools),
    maxTurns,
    budgetSeconds: budget && Math.round(budget.totalMs / 1000),
  })
  const messagesForModel = await convertToModelMessages(messages)

  const streamAnswer = canStreamAnswer(sink, schema)

  const callOptions = {
    model,
    system: systemPrompt,
    messages: messagesForModel,
    tools,
    stopWhen: stepCountIs(maxTurns),
    prepareStep: createPrepareStep({
      state,
      modelId,
      maxTurns,
      answeringModel,
      hasTools: Object.keys(tools).length > 0,
      contextLength,
      answerReservePercent,
      toolTokenBudget,
      requireToolFirstTurn,
      sink,
    }),
    // Per-round-trip and per-tool watchdogs, native to the AI SDK: each is armed
    // and cleared around its own call, so a single stalled request or hung tool
    // fails fast instead of silently consuming the node's whole window.
    // `abortSignal` carries our separate total-budget guard.
    timeout: budget && { stepMs: budget.stepMs, toolMs: budget.toolMs },
    abortSignal: guard.signal,
    maxRetries: MODEL_MAX_RETRIES,
    onStepFinish: createOnStepFinish({
      state,
      modelId,
      maxTurns,
      streamReasoning,
      streamToolCalls,
      toolStatusLabels,
      sink,
    }),
  }

  const driveArgs: DriveArgs = {
    state,
    model,
    modelId,
    maxTurns,
    schema,
    systemPrompt,
    messagesForModel,
    guard,
    sink,
  }
  const result = await runGuarded(sink, modelId, startedAt, guard, () => {
    return streamAnswer
      ? driveStream(() => streamText(callOptions), driveArgs)
      : driveGenerate(() => generateText(callOptions), driveArgs)
  })
  logModelCallEnd(sink, modelId, startedAt, {
    finishReason: result.finishReason,
    steps: state.stepTraces.length,
    ...state.totalUsage,
  })

  if (result.text.trim() === '') {
    throwForEmptyAnswer(result, state, maxTurns)
  }

  const meta: AgentNodeMeta = {
    model: modelId,
    systemPrompt,
    messages: recordedMessages(messages),
    steps: state.stepTraces,
    totalUsage: state.totalUsage,
    ...(contextLength != null ? { contextLength } : {}),
    ...(state.stoppedOnTokenBudget ? { stoppedOnTokenBudget: true } : {}),
    ...(state.stoppedOnContextLimit ? { stoppedOnContextLimit: true } : {}),
  }
  if (schema) {
    // Either the answering turn's parsed text or the transcript call's object.
    // The one way to get here without one is a failed final round-trip that still
    // carried text — which a text agent returns as its answer, but a structured
    // one has nothing to shape.
    if (result.object === undefined) {
      throw new Error(
        `Agent's model call failed after ${state.stepTraces.length} of ${maxTurns} turns ` +
          `(finish reason: ${result.finishReason}) before it produced the structured result.`,
      )
    }
    return structuredResult(output, result.object, meta)
  }
  return { output: { text: result.text }, meta }
}

/**
 * Diagnose a loop that finished with no answer text, and throw saying which
 * fault it was. Never returns.
 *
 * A text agent that returns nothing has failed, and must say so here. The node
 * itself is happy to hand an empty string downstream, and everything after it —
 * the Output node, the chat message — faithfully carries the emptiness all the
 * way to a blank bubble the reader can only read as "it broke, silently".
 * `prepareStep` removes the ordinary cause; anything still landing here is a
 * genuine fault.
 *
 * WHICH fault, though, is the whole diagnosis, and for a long time this said
 * "produced no answer after N of M turns" to all of them — including the case
 * where the model call simply failed on turn 2 of 10. That reads as a turn
 * ceiling that was never reached, and it sent readers (and the chat's copy)
 * looking for a prompt problem instead of a provider outage. Four outcomes, four
 * messages, and only the last two are a wall a retry would hit again — those are
 * the ones marked fatal.
 */
function throwForEmptyAnswer(
  result: LoopOutcome,
  state: AgentLoopState,
  maxTurns: number,
): never {
  const turns = state.stepTraces.length
  const toolCount = state.stepTraces.reduce((n, s) => n + s.toolCalls.length, 0)
  // The model call itself failed and we caught the provider's own error on the
  // way past. Rethrow it UNWRAPPED: `apiErrorDetail` reads `APICallError` /
  // `RetryError` natively, so the status code, the response body and — the part
  // that decides whether the engine retries — `isRetryable` all survive. Wrapping
  // it in a message here would throw every one of those away, which is what made
  // this class of failure undiagnosable.
  if (result.streamError instanceof Error) throw result.streamError
  // The chunk's `error` is typed `unknown` — a provider is free to put a string
  // or a plain object there, and JS is free to throw one, but nothing downstream
  // can read a stack off it. Name it instead of rethrowing it.
  if (result.streamError !== undefined) {
    throw new Error(
      `Agent's model call failed: ${errorFeedLine(result.streamError)}`,
    )
  }
  if (result.finishReason === 'error') {
    // Same fault, but the error part never arrived (or carried nothing) —
    // deliberately NOT marked fatal, since unlike a turn ceiling there's no
    // evidence a second attempt hits the same wall.
    throw new Error(
      `Agent's model call failed after ${turns} of ${maxTurns} turns ` +
        `(finish reason: error), and the provider reported no error detail. ` +
        `It called ${toolCount} tools and wrote no text.`,
    )
  }
  if (result.finishReason === 'length') {
    // The answering turn ran out of output tokens — on a reasoning model,
    // typically spent entirely inside `<think>`. Fatal: the same prompt reasons
    // its way to the same cliff.
    throw markNoOutput(
      new Error(
        `Agent was cut off before it wrote an answer, after ${turns} of ` +
          `${maxTurns} turns (finish reason: length). It called ${toolCount} tools ` +
          `and wrote no text.`,
      ),
    )
  }
  throw markNoOutput(
    new Error(
      `Agent produced no answer after ${turns} of ${maxTurns} turns ` +
        `(finish reason: ${result.finishReason}). It called ` +
        `${toolCount} tools and wrote no text.`,
    ),
  )
}

export async function runAgentGeneration(
  args: RunAgentGenerationArgs,
): Promise<AgentNodeResult> {
  // The one place every tool set reaches a model — the agent node's registry
  // tools, a sub-agent's synthesized spawn tools, the playground's mocks — so it
  // is the one place the strict-dialect conversion belongs. Doing it per tool
  // definition instead would mean a tool authored anywhere else silently ships a
  // schema the provider drops. See `../strict-schema`.
  const prepared: RunAgentGenerationArgs = {
    ...args,
    tools: strictifyToolSet(args.tools),
  }
  // A structured agent takes the single-call path only when the loop would have
  // nothing to do: no tools, or one turn — which `prepareStep` makes the
  // answering turn, denying tools. Anything else is a real loop that happens to
  // end in an object. Gating on `maxTurns` as well as on tools keeps every stored
  // config that could never call its tools on exactly the call it made before;
  // only agents that were actually being denied their tools change.
  const structured =
    prepared.output.kind === 'object' || prepared.output.kind === 'boolean'
  const nothingToCall =
    Object.keys(prepared.tools).length === 0 || prepared.maxTurns < 2
  if (structured && nothingToCall) {
    return await runStructuredGeneration(prepared)
  }
  return await runToolLoop(prepared)
}
