import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import type { ToolRegistry } from '../../engine/tool-registry'
import {
  getAgent,
  getFeedbackForSubjects,
  getRun,
  getWorkflow,
  listAgents,
  listRuns,
  listWorkflows,
} from '../../storage'
import type { WfDb } from '../../storage/client'

// The System Copilot's READ-ONLY tools. Every tool wraps a 007 storage
// accessor, so the copilot sees exactly what the editor/run-viewer see. These
// are all reads; write actions (edit an agent draft, publish a version) are a
// deliberate future addition behind an explicit gate.
//
// Payloads can be large (a run's step `meta` carries full LLM prompts + tool
// I/O), so results are clipped — the model drills in with follow-up calls rather
// than swallowing one giant blob.

// Clip any value to a bounded JSON string so a single tool result can't blow the
// context window. Used on the fat fields (step input/output/meta).
function clip(value: unknown, max = 4000): unknown {
  if (value == null) return value
  const json = JSON.stringify(value)
  if (json.length <= max) return value
  return `${json.slice(0, max)}… [truncated ${json.length - max} chars — ask for a specific node to see more]`
}

// Declared as a named schema so `execute` can recover its parsed shape via
// `z.infer` (the loose-arg pattern the AI SDK's `tool()` needs — see below).
const LIST_RUNS_INPUT_SCHEMA = z.object({
  status: z
    .enum(['running', 'done', 'completed', 'failed', 'cancelled'])
    .optional()
    .describe(
      'Only runs in this state. `done` = the Output was reached but background branches were still running; `completed` = every branch finished.',
    ),
  workflowId: z.string().optional().describe('Only runs of this workflow.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('How many runs to return (default 20).'),
})

export function createCopilotTools<TDeps>({
  wfDb,
  toolRegistry,
}: {
  wfDb: WfDb
  toolRegistry: ToolRegistry<TDeps>
}): ToolSet {
  return {
    list_agents: tool({
      description:
        'List every agent (name, description, model, tools) — the reusable LLM workers that workflows call. Start here to see what agents exist.',
      inputSchema: z.object({}),
      execute: async () => await listAgents(wfDb),
    }),

    get_agent: tool({
      description:
        "Inspect one agent's full config — its system prompt, allowed tools, model, max turns, and sub-agent delegation. Use to advise on improving an agent.",
      inputSchema: z.object({
        agentId: z.string().describe('The agent id (from list_agents).'),
      }),
      execute: async (rawArgs) => {
        const { agentId } = rawArgs as { agentId: string }
        const detail = await getAgent(wfDb, agentId)
        if (!detail) return { error: `No agent found for id ${agentId}.` }
        return detail
      },
    }),

    list_workflows: tool({
      description:
        'List every workflow (the graphs that wire triggers → agents/tools → output). Use to find the workflow behind a behavior.',
      inputSchema: z.object({}),
      execute: async () => await listWorkflows(wfDb),
    }),

    get_workflow: tool({
      description:
        "Read one workflow's current graph — its nodes (trigger/agent/tool/branch/iteration/output) and edges. Use to explain or critique how it's wired.",
      inputSchema: z.object({
        workflowId: z
          .string()
          .describe('The workflow id (from list_workflows).'),
      }),
      execute: async (rawArgs) => {
        const { workflowId } = rawArgs as { workflowId: string }
        const detail = await getWorkflow(wfDb, workflowId)
        if (!detail) return { error: `No workflow found for id ${workflowId}.` }
        return detail
      },
    }),

    list_runs: tool({
      description:
        'List recent workflow runs, newest first. Filter by status to hunt failures (e.g. status "failed"). Each run links to the workflow version that produced it.',
      inputSchema: LIST_RUNS_INPUT_SCHEMA,
      // The AI SDK types `execute`'s arg loosely; recover the real shape from the
      // same schema (mirrors the SDK's built-in tools, e.g. tavily). Destructuring
      // an inferred-typed param here collapses the `tool()` overload inference.
      execute: async (rawArgs) => {
        const { status, workflowId, limit } = rawArgs as z.infer<
          typeof LIST_RUNS_INPUT_SCHEMA
        >
        return await listRuns(wfDb, { status, workflowId, limit: limit ?? 20 })
      },
    }),

    get_run: tool({
      description:
        "The workhorse. Load one run's full trace: every step (agent/tool node) with its inputs, outputs, LLM reasoning, tool calls, errors, plus cost, tokens, and the frozen manifest of which agent/tool versions ran. Use to diagnose WHY a run produced its output. Step errors here ARE the failure detail (also viewable in Sentry via the run's trace link).",
      inputSchema: z.object({
        runId: z.string().describe('The run id (from list_runs or feedback).'),
      }),
      execute: async (rawArgs) => {
        const { runId } = rawArgs as { runId: string }
        const detail = await getRun(wfDb, runId)
        if (!detail) return { error: `No run found for id ${runId}.` }
        return {
          run: detail.run,
          workflowName: detail.workflowName,
          versionNumber: detail.versionNumber,
          costUsd: detail.costUsd,
          totalTokens: detail.totalTokens,
          logs: detail.logs,
          steps: detail.steps.map((s) => ({
            nodeId: s.nodeId,
            nodeKind: s.nodeKind,
            status: s.status,
            error: s.error,
            input: clip(s.input),
            output: clip(s.output),
            meta: clip(s.meta),
          })),
        }
      },
    }),

    get_tool_catalog: tool({
      description:
        'List every tool the platform exposes to agents (name, description, and whether it reads or writes). Use to know what an agent could be given, or to explain a tool.',
      inputSchema: z.object({}),
      execute: () =>
        [...toolRegistry].map(([id, entry]) => ({
          id,
          name: entry.name,
          description: entry.description ?? null,
          kind: entry.kind,
          sideEffect: entry.sideEffect ?? null,
        })),
    }),

    get_feedback_context: tool({
      description:
        "Load a customer feedback item and the run that produced the answer they rated. Returns the rating (up/down), their note, an excerpt of the answer, and the full producing run's trace. Use this to recommend how to improve the output.",
      inputSchema: z.object({
        subjectId: z
          .string()
          .describe('The feedback subject id (the rated message id).'),
      }),
      execute: async (rawArgs) => {
        const { subjectId } = rawArgs as { subjectId: string }
        const rows = await getFeedbackForSubjects(wfDb, [subjectId])
        const feedback = rows[0]
        if (!feedback) {
          return { error: `No feedback found for subject ${subjectId}.` }
        }
        const runId = feedback.runId
        if (!runId) return { feedback, run: null }
        const detail = await getRun(wfDb, runId)
        return {
          feedback,
          run: detail
            ? {
                run: detail.run,
                workflowName: detail.workflowName,
                versionNumber: detail.versionNumber,
                costUsd: detail.costUsd,
                totalTokens: detail.totalTokens,
                steps: detail.steps.map((s) => ({
                  nodeId: s.nodeId,
                  nodeKind: s.nodeKind,
                  status: s.status,
                  error: s.error,
                  input: clip(s.input),
                  output: clip(s.output),
                  meta: clip(s.meta),
                })),
              }
            : null,
        }
      },
    }),
  }
}
