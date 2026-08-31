import type { ToolSet } from 'ai'

import { allTools, selectTools } from '../../mcp/catalog'
import { createWfToolSet } from '../../mcp/tool-set'
import type { WfDataClient } from '../protocol'

// The System Copilot's tools — the same definitions `wf-mcp` exposes, bound to
// an in-process data client instead of stdio.
//
// This file used to hold its own list of eight, wrapping the same storage
// accessors the MCP tools wrap. Two lists meant two sets of descriptions, and a
// tool description is prompt: they would have diverged in what the model DID,
// while each read fine on its own. Now the copilot picks up new tools (and
// every fix to an old one) by existing.
//
// READ-ONLY, deliberately, and enforced by the same `selectTools` gate the MCP
// server uses rather than by a shorter list. The copilot is an in-app chat
// reachable by any firm staffer on the surface they happen to be looking at;
// `wf-mcp --write` is a flag a developer types. Same tools, different blast
// radius, so the answer to "should it be able to publish an agent version or
// launch a paid eval sweep" is different — and if that changes, it changes by
// passing `true` here, not by re-listing anything.

export function createCopilotTools(client: WfDataClient): ToolSet {
  return createWfToolSet(client, selectTools(allTools(), false))
}
