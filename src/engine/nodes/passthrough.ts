import { resolveBinding } from '../binding'
import type { PassthroughNode } from '../graph'

export type PassthroughNodeResult = {
  output: unknown
}

export type ExecutePassthroughNodeArgs = {
  node: PassthroughNode
  /** The prior node's output — forwarded unchanged in identity mode (no config). */
  input: unknown
  /** Per-node output cache. Keys are node ids, values are the node's `output` —
   * so a `value`/`fields` ref resolves against an upstream node's output exactly
   * like agent/tool/branch input bindings do. */
  nodeOutputs: Map<string, unknown>
  /**
   * Deep-rehydrates blob-ref args (a large upstream value spilled to storage) to
   * their real value before it is forwarded, matching the tool/agent nodes.
   * Omitted → resolved values pass through unchanged.
   */
  rehydrate?: (value: unknown) => Promise<unknown>
}

// The Passthrough node is a deterministic identity/reshape step — no LLM, no
// tool, no I/O. It exists to re-surface an upstream value in a shape the author
// controls, which is what lets a "data already exists" branch arm feed a Race
// the SAME shape its sibling arm produces (a Branch emits its decision, not its
// input, and a Race blindly forwards whichever arm wins — so the converging arm
// needs a node that emits the data itself). Three modes, checked in order:
//   • `value`  → resolve that one binding and emit it UNWRAPPED.
//   • `fields` → build an object, one key per resolved binding.
//   • neither  → forward the incoming `input` untouched (pure identity).
// The schema already rejects setting both `value` and `fields`.
export async function executePassthroughNode(
  deps: ExecutePassthroughNodeArgs,
): Promise<PassthroughNodeResult> {
  const { node, input, nodeOutputs, rehydrate } = deps
  const { value, fields } = node.config

  const resolve = async (
    binding: Parameters<typeof resolveBinding>[0],
    name: string,
  ): Promise<unknown> => {
    const raw = resolveBinding(binding, nodeOutputs, { nodeId: node.id, name })
    return rehydrate ? await rehydrate(raw) : raw
  }

  if (value) {
    return { output: await resolve(value, 'value') }
  }

  if (fields && Object.keys(fields).length > 0) {
    const output: Record<string, unknown> = {}
    for (const [name, binding] of Object.entries(fields)) {
      output[name] = await resolve(binding, name)
    }
    return { output }
  }

  // Identity: nothing configured, forward the input straight through.
  return { output: input }
}
