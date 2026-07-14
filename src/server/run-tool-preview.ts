import { rehydrateBlobRefs } from '../engine/blob-ref'
import type { RunContext, WfSdkConfig } from '../engine/config'
import type { ToolNode } from '../engine/graph'
import { executeToolNode } from '../engine/nodes/tool'

import type { WfToolPreviewResult } from './protocol'

// Playground seam — runs a *single* tool in isolation against scratch args, with
// no graph and no run record. Unlike the agent playground (which *simulates*
// tools), this executes the REAL tool: it builds the host's live per-run deps
// (`buildRunDeps`) and calls the tool's own `execute`, exactly as a Tool node
// would inside a run. So it can hit external services, incur cost, and mutate
// real data — the UI must make that explicit before the user runs it.
//
// It reuses the exact node executor a real workflow uses (`executeToolNode`), so
// what the user sees here matches production behavior: the args are validated
// and defaulted through the tool's declared input schema before it runs.
//
// Like `executeAgentPreview`, this is invoked from a host-injected handler so the
// host can supply live bindings (`env`) via the RunContext; the SDK stays
// env/auth-free.

export async function executeToolPreview<TDeps>(opts: {
  /** The registry id of the tool to run. */
  toolId: string
  /** The scratch arguments to call it with (validated by the tool's schema). */
  args: Record<string, unknown>
  /**
   * The host's SDK config — its `toolRegistry` (to resolve + run the tool) and
   * `buildRunDeps` (to construct the real per-run deps the tool consumes). A
   * `resolveBlobRef`, when set, rehydrates any blob-ref args.
   */
  wfConfig: Pick<
    WfSdkConfig<TDeps>,
    'toolRegistry' | 'buildRunDeps' | 'resolveBlobRef'
  >
  /** Per-run context carrying `env` + tenant scope, passed to `buildRunDeps`. */
  runContext: RunContext
}): Promise<WfToolPreviewResult> {
  const { toolId, args, wfConfig, runContext } = opts

  // Build the REAL per-run deps — this is what makes the call hit live services.
  const toolDeps = await wfConfig.buildRunDeps(runContext)

  // A one-node graph fragment: the tool with each arg bound as a literal. The
  // node executor materializes the bindings, validates them through the tool's
  // input schema (applying defaults), then invokes the tool.
  const node: ToolNode = {
    id: 'playground',
    kind: 'tool',
    label: 'Playground',
    position: { x: 0, y: 0 },
    config: {
      toolId,
      args: Object.fromEntries(
        Object.entries(args).map(([k, v]) => [k, { kind: 'literal', value: v }]),
      ),
    },
  }

  const startedAt = Date.now()
  const result = await executeToolNode<TDeps>({
    node,
    nodeOutputs: new Map(),
    toolRegistry: wfConfig.toolRegistry,
    toolDeps,
    rehydrate: wfConfig.resolveBlobRef
      ? (value) =>
          rehydrateBlobRefs(value, (ref) =>
            wfConfig.resolveBlobRef!(ref, toolDeps),
          )
      : undefined,
  })
  const durationMs = Date.now() - startedAt

  return { output: result.output, args: result.meta.args, durationMs }
}
