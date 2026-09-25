import { readTools, type WfMcpTool } from './tools'
import { agentReadTools, agentWriteTools } from './tools-agents'
import {
  connectorReadTools,
  connectorWriteTools,
} from './tools-connectors'
import { draftTools } from './tools-drafts'
import { evalRunReadTools, evalRunWriteTools } from './tools-eval-runs'
import { evalReadTools, evalWriteTools } from './tools-evals'
import { metaWriteTools } from './tools-meta'
import { platformReadTools, platformWriteTools } from './tools-platform'
import { workflowReadTools, workflowWriteTools } from './tools-workflows'

// The catalog — every tool this build knows about, and the gate that decides
// which of them a surface gets.
//
// Kept apart from `server.ts` so the list can be read without the transport:
// the stdio server pulls in `@modelcontextprotocol/sdk`, and `describe.ts` (a
// host's "connect the MCP" page) runs in a Cloudflare Worker where that has no
// business being bundled.

/** Every tool this build knows about, read and write alike. */
export function allTools(): WfMcpTool[] {
  return [
    ...readTools(),
    ...platformReadTools(),
    ...connectorReadTools(),
    ...agentReadTools(),
    ...evalReadTools(),
    ...evalRunReadTools(),
    ...workflowReadTools(),
    ...draftTools(),
    ...evalWriteTools(),
    ...evalRunWriteTools(),
    ...metaWriteTools(),
    ...platformWriteTools(),
    ...connectorWriteTools(),
    ...agentWriteTools(),
    ...workflowWriteTools(),
  ]
}

/**
 * The write gate, in one place for every surface.
 *
 * It filters the LIST rather than guarding a handler, so a read-only surface
 * doesn't merely refuse writes — it has no write tools at all, nothing in the
 * model's context suggests one exists, and no amount of prompting can produce a
 * call to one. Refusing at call time would leave the affordance visible and the
 * refusal a matter of the handler being reached.
 */
export function selectTools(tools: WfMcpTool[], write: boolean): WfMcpTool[] {
  return write ? tools : tools.filter((t) => t.readOnly)
}
