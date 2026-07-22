import type { FeatureRequestNode } from '../graph'

export type FeatureRequestNodeResult = {
  output: unknown
  meta: {
    description: string
  }
}

export type ExecuteFeatureRequestNodeArgs = {
  node: FeatureRequestNode
  input: unknown
}

// The Feature Request node is a pure pass-through placeholder. It performs no
// work — it forwards its input straight through as its output so the run
// continues unchanged. Its only payload is the author's free-text `description`
// of a capability they'd like here in the future, captured so the idea isn't
// lost. Swap this body out when the requested behavior is actually built.
export function executeFeatureRequestNode(
  deps: ExecuteFeatureRequestNodeArgs,
): Promise<FeatureRequestNodeResult> {
  return Promise.resolve({
    output: deps.input,
    meta: { description: deps.node.config.description },
  })
}
