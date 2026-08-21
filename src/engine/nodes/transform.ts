import jsonata from 'jsonata'
import { z } from 'zod'

import { resolveBinding } from '../binding'
import type { TransformNode } from '../graph'
import type { TransformOutputShape } from '../graph-kinds'

export type TransformNodeResult = {
  output: unknown
}

export type ExecuteTransformNodeArgs = {
  node: TransformNode
  /** The prior node's output — the expression's input when no `source` is bound. */
  input: unknown
  /** Per-node output cache, so `source`/`inputs` refs resolve against any
   * upstream node's output exactly like agent/tool/branch bindings do. */
  nodeOutputs: Map<string, unknown>
  /**
   * Deep-rehydrates blob-ref values (a large upstream value spilled to storage)
   * before the expression sees them, matching the tool/agent/passthrough nodes.
   * Omitted → resolved values pass through unchanged.
   */
  rehydrate?: (value: unknown) => Promise<unknown>
}

// Guardrails for a hostile or merely careless expression. JSONata lets an author
// define recursive lambdas, so an expression is not guaranteed to terminate.
// The two guards catch DIFFERENT runaways and neither subsumes the other:
//
//   • `stack` catches non-tail recursion (`1 + $f($x+1)`) — the frame count
//     grows, so depth is measurable. Fires in milliseconds, everywhere.
//   • `timeout` catches tail recursion (`$f($x+1)`), which JSONata deliberately
//     optimises into a loop: depth stays flat forever, so `stack` never sees it.
//
// The second guard does not work in a Worker. workerd freezes `Date.now()`
// between I/O operations, and a runaway expression performs no I/O — so the
// clock JSONata compares against never advances and the timeout cannot fire.
// It is set regardless (it works under Node, which is where the tests run), but
// the real backstop for a tail-recursive loop in production is the platform's
// own CPU limit killing the step. That is an acceptable place to land: the node
// fails, the run fails, and the cause is an authoring bug in a pure function
// with no side effects to unwind.
//
// The timeout is deliberately far above any legitimate use — reshaping a
// thread's worth of records runs in single-digit milliseconds.
const EVAL_TIMEOUT_MS = 2_000
const MAX_STACK_DEPTH = 200

/**
 * Shapes a transform can assert its result against.
 *
 * Declaring one is optional but worth it wherever the consumer is strict, and
 * `conversation` is the motivating case in both directions:
 *
 *   • The engine's own check on an agent's bound conversation is `Array.isArray`
 *     and nothing more, so a wrong element shape sails past it and detonates
 *     inside the AI SDK ("Unsupported role: firm"). That error is not classified
 *     fatal, so on the durable backend the agent node retries the full schedule
 *     before anyone sees it — minutes of nothing for a deterministic typo.
 *
 *   • JSONata collapses a single-element sequence to a bare value. A one-message
 *     thread therefore yields an OBJECT where every longer thread yields an
 *     array; `Array.isArray` says no, and the author is told the conversation is
 *     "not bound" on a node that is plainly bound. Wrapping the expression in
 *     JSONata's `[...]` array constructor is the fix, but nothing surfaces the
 *     need until a one-message thread shows up in production.
 *
 * Asserting here converts both into a failure at the transform, naming the node
 * and the offending element.
 */
const conversationShape = z.array(
  z.object({
    id: z.string().optional(),
    role: z.enum(['system', 'user', 'assistant']),
    parts: z.array(z.object({ type: z.string() }).loose()).min(1),
  }),
)

const OUTPUT_SHAPES: Record<TransformOutputShape, z.ZodType> = {
  conversation: conversationShape,
}

/** What an author should read when their expression produced the wrong thing. */
const SHAPE_HINTS: Record<TransformOutputShape, string> = {
  conversation:
    'Each message needs `role` ("user" | "assistant" | "system") and a non-empty `parts` array. A single-message result must still be an array — wrap the expression in JSONata\'s `[ ... ]` array constructor.',
}

// The Transform node runs a JSONata expression over an upstream value and emits
// the result. It is the reshape step the binding language cannot be: bindings
// ADDRESS data (dotted keys, positional indices) where this REWORKS it, which is
// what a boundary between two disagreeing contracts needs — database rows on one
// side, AI-SDK messages on the other.
//
// Deterministic and I/O-free, like passthrough: same inputs always give the same
// output, so it is safe to replay in a durable step.
export async function executeTransformNode(
  deps: ExecuteTransformNodeArgs,
): Promise<TransformNodeResult> {
  const { node, input, nodeOutputs, rehydrate } = deps
  const { source, inputs, expression, outputShape } = node.config
  const self = node.label || `Transform node ${node.id}`

  if (!expression.trim()) {
    throw new Error(
      `${self} has no expression — write a JSONata expression for the shape it should emit.`,
    )
  }

  const resolve = async (
    binding: Parameters<typeof resolveBinding>[0],
    name: string,
  ): Promise<unknown> => {
    const raw = resolveBinding(binding, nodeOutputs, { nodeId: node.id, name })
    return rehydrate ? await rehydrate(raw) : raw
  }

  // `$` — the value the expression walks. An explicit `source` wins; with none,
  // fall back to the incoming edge so the common one-parent reshape needs no
  // binding at all.
  const subject = source ? await resolve(source, 'source') : input

  // `$name` — extra producers, so one transform can combine several upstreams
  // without a join node in front of it.
  const bindings: Record<string, unknown> = {}
  for (const [name, binding] of Object.entries(inputs)) {
    bindings[name] = await resolve(binding, name)
  }

  let compiled: ReturnType<typeof jsonata>
  try {
    // Guardrails belong to the compiled expression, not the evaluate call —
    // JSONata reads them from this closure on every evaluation.
    compiled = jsonata(expression, {
      timeout: EVAL_TIMEOUT_MS,
      stack: MAX_STACK_DEPTH,
    })
  } catch (err) {
    // A parse error carries a position and token; surface both, since the
    // editor's author-time check uses this same compile and an author who got
    // past it is looking at a genuinely surprising failure.
    throw new Error(`${self} has an invalid JSONata expression: ${messageOf(err)}`)
  }

  let result: unknown
  try {
    result = await compiled.evaluate(subject, bindings)
  } catch (err) {
    throw new Error(`${self} failed to evaluate its expression: ${messageOf(err)}`)
  }

  if (outputShape) {
    const parsed = OUTPUT_SHAPES[outputShape].safeParse(result)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.length ? ` at \`${issue.path.join('.')}\`` : ''
      throw new Error(
        `${self} was declared to emit a ${outputShape}, but its result does not match${where}: ${issue?.message ?? 'invalid shape'}. ${SHAPE_HINTS[outputShape]}`,
      )
    }
  }

  return { output: result }
}

// JSONata rejects with plain objects (`{ code, position, token, message }`), not
// Errors, so the usual `err.message` read comes back undefined for exactly the
// failures an author most needs to see.
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string; position?: number }
    const parts = [e.message ?? e.code ?? 'unknown error']
    if (typeof e.position === 'number') parts.push(`(at position ${e.position})`)
    return parts.join(' ')
  }
  return String(err)
}
