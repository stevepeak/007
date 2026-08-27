import { resolveBinding } from '../binding'
import type { TextNode } from '../graph'
import {
  inferPromptVariables,
  substitutePromptVariables,
} from '../prompt-variables'

export type TextNodeResult = {
  output: string
}

export type ExecuteTextNodeArgs = {
  node: TextNode
  /** Per-node output cache. Keys are node ids, values are the node's `output` —
   * so an `inputs` ref resolves against an upstream node's output exactly like
   * an agent's prompt-variable bindings do. Nothing here reads the incoming
   * edge: an edge carries sequencing, never content. */
  nodeOutputs: Map<string, unknown>
  /**
   * Deep-rehydrates blob-ref values (a large upstream value spilled to storage)
   * before they are interpolated, matching the agent/tool/transform nodes.
   * Omitted → resolved values are used as-is.
   */
  rehydrate?: (value: unknown) => Promise<unknown>
}

// The Text node composes a block of text. The body is Markdown with `${name}`
// tokens — the same grammar an agent's prompt uses — and each token is filled
// from a binding into an upstream node's output. It emits the filled-in string.
//
// Deterministic and I/O-free, like passthrough and transform: same inputs always
// give the same output, so it is safe to replay in a durable step.
//
// Both failure modes THROW rather than degrade, which is the same call the agent
// node makes on an unbound conversation and the Output node makes on an unbound
// source. The alternative is worse than a failed run: the two silent outcomes
// are a literal `${clientName}` reaching a human, or an empty string standing in
// for a name — and a Text node exists precisely to produce something a person
// reads.
export async function executeTextNode(
  deps: ExecuteTextNodeArgs,
): Promise<TextNodeResult> {
  const { node, nodeOutputs, rehydrate } = deps
  const { body, inputs } = node.config
  const self = node.label || `Text node ${node.id}`

  if (!body.trim()) {
    throw new Error(`${self} has no text — write the text it should produce.`)
  }

  const referenced = inferPromptVariables(body)
  const unbound = referenced.filter((name) => inputs[name] == null)
  if (unbound.length > 0) {
    throw new Error(
      `${self} has ${unbound.length === 1 ? 'an unbound variable' : 'unbound variables'}: ${unbound
        .map((n) => `\${${n}}`)
        .join(', ')}. Bind ${unbound.length === 1 ? 'it' : 'each'} to an upstream value in the workflow editor.`,
    )
  }

  // Only the variables the body actually uses are resolved. A stale binding left
  // behind by an edit is not an error — it costs nothing and deleting it is the
  // author's call — but resolving it would be, since its ref may point at a node
  // that has since been removed.
  const vars: Record<string, string> = {}
  for (const name of referenced) {
    let value = resolveBinding(inputs[name], nodeOutputs, {
      nodeId: node.id,
      name,
    })
    if (rehydrate) value = await rehydrate(value)
    vars[name] =
      typeof value === 'string'
        ? value
        : value == null
          ? ''
          : JSON.stringify(value)
  }

  return { output: substitutePromptVariables(body, vars) }
}
