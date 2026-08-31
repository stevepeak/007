import { readTools, type WfMcpTool } from './tools'
import { draftTools } from './tools-drafts'
import { evalRunReadTools, evalRunWriteTools } from './tools-eval-runs'
import { evalReadTools, evalWriteTools } from './tools-evals'

// The catalog — every tool this build knows about, and the gate that decides
// which of them a surface gets.
//
// Kept apart from `server.ts` because the two registration surfaces don't share
// a dependency: the stdio server pulls in `@modelcontextprotocol/sdk`, and the
// System Copilot runs in a Cloudflare Worker where that has no business being
// bundled. Both need the list; only one needs the transport.

/** Every tool this build knows about, read and write alike. */
export function allTools(): WfMcpTool[] {
  return [
    ...readTools(),
    ...evalReadTools(),
    ...evalRunReadTools(),
    ...draftTools(),
    ...evalWriteTools(),
    ...evalRunWriteTools(),
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
