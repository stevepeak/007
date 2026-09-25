import { z } from 'zod'

import { clip, clipTail } from '../server/clip'
import type {
  ToolOption,
  WfDataClient,
  WfRunDetail,
  WfRunSummary,
} from '../server/protocol'

// The tools `wf-mcp` exposes, defined over `WfDataClient` — the same ~70-method
// interface the editor and run viewer use — so an MCP session sees exactly what
// a person sees in the UI, validated by the same dispatcher and recorded in the
// same `wf_change` log.
//
// Two conventions run through the file:
//
//   • Results are CLIPPED (see `server/clip.ts`). A run's step `meta` carries
//     the full LLM prompt, the reasoning trace and every tool call's I/O; one
//     unclipped `get_run` on a real trace is larger than the context it is
//     being read into.
//   • Input schemas avoid `oneOf` / `minItems` and prefer `.nullish()` over
//     `.optional()`. MCP tool inputs are JSON Schema, and strict-mode clients
//     silently DROP constructs they don't support — a schema that is quietly
//     ignored is worse than a loose one, because nothing says so.

/**
 * One MCP tool, in a shape the transport doesn't own.
 *
 * Declared this way rather than by calling `server.registerTool` inline so the
 * same definitions can be registered on a stdio server or a remote one, and
 * read as documentation (`describe.ts`), without being rewritten.
 */
export type WfMcpTool = {
  name: string
  title: string
  description: string
  /**
   * A zod raw shape — what `McpServer.registerTool` takes as `inputSchema`.
   *
   * Spelled as a mutable `Record` rather than `z.ZodRawShape`: as of zod 4.6
   * that alias is `Readonly<...>`, which no longer satisfies the MCP SDK's
   * `ZodRawShapeCompat` (`Record<string, AnySchema>`), and every tool
   * registration stops compiling.
   */
  inputSchema: Record<string, z.ZodType>
  /** False for anything that mutates; gates registration. See `server.ts`. */
  readOnly: boolean
  run: (client: WfDataClient, args: Record<string, unknown>) => Promise<unknown>
}

/**
 * Read a model-supplied argument as a string, or nothing.
 *
 * Not `String(value)`: a model that passes an object or a number for a filter
 * would otherwise send `"[object Object]"` down the wire as a real filter value
 * and get a confidently empty result back. An argument that is not a string is
 * an argument that was not given.
 */
export function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The same, for an id a tool cannot proceed without. */
export function reqString(value: unknown, field: string): string {
  const s = optString(value)
  if (!s) throw new Error(`Missing required argument \`${field}\`.`)
  return s
}

/** Clamp a model-supplied count into a sane window without a JSON-Schema bound. */
export function boundedLimit(
  raw: unknown,
  fallback: number,
  max: number,
): number {
  const n =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback
  return Math.min(Math.max(n, 1), max)
}

/** Steps beyond this are dropped from a `get_run` — the tail is where failures are. */
const MAX_STEPS = 60
const MAX_LOGS = 80

/**
 * Per-field budget in a `get_run` overview, deliberately tighter than the shared
 * default. A real run has ~10 steps with three fat fields each, so the default
 * 4000 turns one overview into ~25k tokens — most of it a prompt the reader has
 * already seen. `get_run_step` exists so this can be aggressive: the overview
 * shows the shape of the run, and anything worth reading in full is one call
 * away.
 */
const RUN_OVERVIEW_FIELD_CHARS = 1000

/** A single step, asked for by name. Generous, but still not unbounded. */
const RUN_STEP_FIELD_CHARS = 60_000

/** A child run's error is a provider message and can carry a whole stack. */
const FAILURE_ERROR_CHARS = 400

/**
 * The shape `get_run` reports a trace in, factored out because
 * `get_feedback_context` answers with the same thing — a complaint is only
 * actionable next to the run that caused it, and two shapes for one trace would
 * mean the model learns the fields twice.
 */
function runOverview(detail: WfRunDetail): unknown {
  return {
    // `run` already carries the workflow name, the run's cost and its token
    // total — they are fields of the summary, not of the envelope.
    run: detail.run,
    versionNumber: detail.versionNumber,
    workflowVersionId: detail.workflowVersionId,
    // A log's `meta` is a progress detail, not the payload — it is the
    // step's own fields that carry what actually happened.
    logs: clipTail(detail.logs, MAX_LOGS, 'log entries').map((l) => {
      return typeof l === 'string' ? l : { ...l, meta: clip(l.meta, 400) }
    }),
    steps: clipTail(detail.steps, MAX_STEPS, 'steps').map((s) => {
      return typeof s === 'string'
        ? s
        : {
            cursor: s.cursor,
            // The per-walk counter. `cursor` is the identity to address a step
            // by; this is the ORDER the engine ran them in, which is what a
            // concurrent graph's trace has to be read against.
            sequence: s.sequence,
            nodeId: s.nodeId,
            nodeKind: s.nodeKind,
            parentNodeId: s.parentNodeId,
            itemIndex: s.itemIndex,
            status: s.status,
            error: s.error,
            costUsd: s.costUsd,
            // Which arm a branch/switch took. Without it a trace shows that a
            // decision node ran and not what it decided, so "why did it go down
            // this path" was unanswerable from the step that answered it.
            branchResult: s.branchResult,
            // The timing the Inspect card shows. A slow run's shape — which node
            // held it up, what overlapped — is these two fields and nothing else.
            startedAt: s.startedAt,
            finishedAt: s.finishedAt,
            durationMs:
              s.startedAt != null && s.finishedAt != null
                ? s.finishedAt - s.startedAt
                : null,
            input: clip(s.input, RUN_OVERVIEW_FIELD_CHARS),
            output: clip(s.output, RUN_OVERVIEW_FIELD_CHARS),
            // `clip` replaces a too-large object with a truncated JSON STRING, so
            // on any real agent step this arrives unparseable — the agent version
            // that ran is in here. `get_run_step` is the way to read it; said
            // once, here, rather than left to be discovered.
            meta: clip(s.meta, RUN_OVERVIEW_FIELD_CHARS),
          }
    }),
    // Presence flags the server sets when it could not return everything. A
    // clipped feed presented as the whole story is how "there is no error in the
    // logs" becomes a wrong conclusion.
    logsTruncated: detail.logsTruncated,
    stepsPartial: detail.stepsPartial,
  }
}

export function readTools(): WfMcpTool[] {
  return [
    {
      name: 'list_agents',
      title: 'List agents',
      description:
        'List every agent — the reusable LLM workers that workflows call — with its model, tools, required prompt variables and declared output. Start here to see what exists.',
      inputSchema: {},
      readOnly: true,
      run: async (client) => await client.listAgents(),
    },

    {
      name: 'get_agent',
      title: 'Get agent',
      description:
        "Read one agent's full config: system prompt, user prompt, allowed tools, model, max turns, sub-agent delegation, and output contract. Returns both the published version and the unsaved draft, which can differ.",
      inputSchema: {
        agentId: z.string().describe('Agent id, from list_agents.'),
      },
      readOnly: true,
      run: async (client, args) => {
        const agentId = reqString(args.agentId, 'agentId')
        const detail = await client.getAgent(agentId)
        return detail ?? { error: `No agent found for id ${agentId}.` }
      },
    },

    {
      name: 'list_workflows',
      title: 'List workflows',
      description:
        'List every workflow — the graphs wiring a trigger through agents and tools to an output — with its latest version, run count, last run time and the agents it references.',
      inputSchema: {},
      readOnly: true,
      run: async (client) => await client.listWorkflows(),
    },

    {
      name: 'get_workflow',
      title: 'Get workflow',
      description:
        "Read one workflow's graph — nodes (trigger/agent/tool/branch/switch/iteration/workflow-call/output) and edges — for both the published version and the unsaved draft. Use to explain or critique how it is wired.",
      inputSchema: {
        workflowId: z.string().describe('Workflow id, from list_workflows.'),
      },
      readOnly: true,
      run: async (client, args) => {
        const workflowId = reqString(args.workflowId, 'workflowId')
        const detail = await client.getWorkflow(workflowId)
        return detail ?? { error: `No workflow found for id ${workflowId}.` }
      },
    },

    {
      name: 'list_runs',
      title: 'List runs',
      description:
        'List runs, newest first. Filter by status to hunt failures, by `workflowVersionId` to ask whether a publish fixed something, and by `since` / `until` to bound the window. Note the two success states: `done` means the Output was reached while background branches were still running, `completed` means every branch finished.',
      inputSchema: {
        status: z
          .string()
          .nullish()
          .describe(
            'One of: running, done, completed, failed, cancelled. Omit for all.',
          ),
        workflowId: z
          .string()
          .nullish()
          .describe('Only runs of this workflow.'),
        triggerKind: z
          .string()
          .nullish()
          .describe('Only runs started by this trigger kind.'),
        search: z
          .string()
          .nullish()
          .describe(
            'Matches workflow name, trigger kind, subject, correlation or note.',
          ),
        workflowVersionId: z
          .string()
          .nullish()
          .describe(
            'Only runs pinned to this published version — from get_run’s `workflowVersionId` or list_workflow_versions. This is how you answer "did the failures stop after v7 shipped?".',
          ),
        since: z
          .number()
          .nullish()
          .describe('Only runs created at or after this epoch-millis timestamp.'),
        until: z
          .number()
          .nullish()
          .describe('Only runs created at or before this epoch-millis timestamp.'),
        limit: z
          .number()
          .nullish()
          .describe('How many runs (default 20, max 100).'),
        offset: z.number().nullish().describe('Rows to skip, for paging.'),
      },
      readOnly: true,
      run: async (client, args) => {
        const num = (v: unknown): number | undefined => { return typeof v === 'number' && Number.isFinite(v) ? v : undefined }
        return await client.listRuns({
          status: optString(args.status),
          workflowId: optString(args.workflowId),
          // The three the handler already accepted and this schema dropped —
          // and a field a schema does not name is a field the dispatcher STRIPS,
          // so passing them was silently doing nothing rather than erroring.
          workflowVersionId: optString(args.workflowVersionId),
          since: num(args.since),
          until: num(args.until),
          triggerKind: optString(args.triggerKind),
          search: optString(args.search),
          limit: boundedLimit(args.limit, 20, 100),
          offset:
            typeof args.offset === 'number' && args.offset > 0
              ? Math.floor(args.offset)
              : undefined,
        })
      },
    },

    {
      name: 'get_run',
      title: 'Get run trace',
      description:
        "The workhorse. An overview of one run's trace: every recorded step with its input, output, LLM reasoning and tool I/O, its timing and the arm any branch took, plus the progress log feed, cost and tokens. Step errors here ARE the failure detail. Each step's fat fields are aggressively truncated — read one in full with get_run_step, using the `cursor` shown here, which is also the only way to read a step's `meta` (where the agent version that actually ran is stamped). `children` appears when the run called other workflows: each is its own run, and a parent can read green while a child failed. The run's workflow graph is NOT included; read it with get_workflow.",
      inputSchema: {
        runId: z.string().describe('Run id, from list_runs or list_feedback.'),
      },
      readOnly: true,
      run: async (client, args) => {
        const runId = reqString(args.runId, 'runId')
        const detail = await client.getRun(runId)
        if (!detail) return { error: `No run found for id ${runId}.` }
        // Child runs, when there are any. A workflow-call node makes its callee a
        // SEPARATE run with its own steps, so a parent's trace shows the call and
        // not what happened inside it — and a parent can read green while a child
        // failed. `list_runs` reports `children.failed > 0` and the child itself
        // was then unreachable, which is a dead end one step from the answer.
        const children: WfRunSummary[] = await client
          .listChildRuns({ parentRunId: runId })
          .catch(() => [])
        return {
          ...(runOverview(detail) as Record<string, unknown>),
          children:
            children.length > 0
              ? {
                  count: children.length,
                  failed: children.filter((c) => c.status === 'failed').length,
                  runs: children.map((c) => ({
                    runId: c.id,
                    workflow: c.workflowName,
                    status: c.status,
                    error: clip(c.error, FAILURE_ERROR_CHARS),
                    triggerKind: c.triggerKind,
                  })),
                  note: 'Each is its own run — read one with get_run(runId). A failure inside a child does not necessarily fail the parent.',
                }
              : undefined,
        }
      },
    },

    {
      name: 'get_run_step',
      title: 'Get one run step',
      description:
        "One step of a run, with its input, output and `meta` (the LLM system + user prompt, the reasoning, and every tool call's arguments and result) essentially unclipped. This is the drill-in for a field get_run truncated. Address the step by the `cursor` get_run shows for it.",
      inputSchema: {
        runId: z.string().describe('Run id.'),
        cursor: z
          .number()
          .describe("The step's `cursor`, as shown by get_run."),
      },
      readOnly: true,
      run: async (client, args) => {
        const runId = reqString(args.runId, 'runId')
        const cursor = args.cursor
        if (typeof cursor !== 'number') {
          throw new TypeError(
            '`cursor` must be the number get_run showed for the step.',
          )
        }
        const detail = await client.getRun(runId)
        if (!detail) return { error: `No run found for id ${runId}.` }
        const step = detail.steps.find((s) => s.cursor === cursor)
        if (!step) {
          return {
            error: `Run ${runId} has no step with cursor ${cursor}.`,
            availableCursors: detail.steps.map((s) => s.cursor),
          }
        }
        return {
          ...step,
          input: clip(step.input, RUN_STEP_FIELD_CHARS),
          output: clip(step.output, RUN_STEP_FIELD_CHARS),
          meta: clip(step.meta, RUN_STEP_FIELD_CHARS),
        }
      },
    },

    {
      name: 'list_feedback',
      title: 'List feedback',
      description:
        'Customer thumbs ratings, newest first, each with the run that produced the rated answer. Thumbs-down rows with a runId are the highest-value input for authoring eval samples — they are real failures someone complained about. Pair with get_run to read what actually happened, draft_sample_from_run to turn one into a test, and triage_feedback to acknowledge it and write down what was done (otherwise the same row comes back next session). `facets` lists the client/matter and rater ids you can filter by.',
      inputSchema: {
        rating: z
          .string()
          .nullish()
          .describe('Filter to "up" or "down". Omit for both.'),
        ackState: z
          .string()
          .nullish()
          .describe('Filter to "acknowledged" or "unacknowledged".'),
        search: z.string().nullish().describe('Free-text match over the rows.'),
        correlationIds: z
          .array(z.string())
          .nullish()
          .describe(
            'Keep only rows from these client/matter groupings — "every complaint from this matter", which is otherwise not expressible. The `correlations` facet in the reply lists the ids that exist.',
          ),
        raterIds: z
          .array(z.string())
          .nullish()
          .describe(
            'Keep only rows from these raters. The `raters` facet lists the ids that exist.',
          ),
        limit: z
          .number()
          .nullish()
          .describe('How many rows (default 25, max 100).'),
      },
      readOnly: true,
      run: async (client, args) => {
        const rating = optString(args.rating)
        const ackState = optString(args.ackState)
        const ids = (raw: unknown): string[] | undefined => {
          const list = (Array.isArray(raw) ? raw : []).filter(
            (v): v is string => typeof v === 'string' && v.length > 0,
          )
          return list.length > 0 ? list : undefined
        }
        const correlationIds = ids(args.correlationIds)
        const raterIds = ids(args.raterIds)
        const result = await client.listFeedback({
          ratings: rating === 'up' || rating === 'down' ? [rating] : undefined,
          ackState:
            ackState === 'acknowledged' || ackState === 'unacknowledged'
              ? ackState
              : undefined,
          correlationIds,
          raterIds,
          search: optString(args.search),
        })
        const limit = boundedLimit(args.limit, 25, 100)
        return {
          total: result.rows.length,
          rows: result.rows.slice(0, limit).map((r) => ({
            ...r,
            body: clip(r.body, 2000),
          })),
          // The facets, but only when nothing was filtered by them yet. They
          // exist to populate the UI's dropdowns, and they are noise to a model
          // that already knows the value it wants — but a model that does NOT
          // cannot otherwise discover that "every complaint from this matter" is
          // even expressible, let alone what the ids look like.
          facets:
            correlationIds || raterIds
              ? undefined
              : {
                  correlations: result.correlations,
                  raters: result.raters,
                },
        }
      },
    },

    {
      name: 'get_feedback_context',
      title: 'Get feedback with its run',
      description:
        "One customer feedback item together with the run that produced the answer they rated: the rating, their note, and the producing run's trace in the same shape get_run returns. Use it to go from a complaint to a concrete recommendation in one call.",
      inputSchema: {
        subjectId: z
          .string()
          .describe('The feedback subject id — the rated message id.'),
      },
      readOnly: true,
      run: async (client, args) => {
        const subjectId = reqString(args.subjectId, 'subjectId')
        const rows = await client.getFeedbackForSubjects({
          subjectIds: [subjectId],
        })
        const feedback = rows[0]
        if (!feedback) {
          return { error: `No feedback found for subject ${subjectId}.` }
        }
        // Rated answers that predate a run, or whose run was purged, still have
        // a rating and a note worth reading — the missing trace is the whole
        // answer to "why", not a reason to fail the call.
        if (!feedback.runId) return { feedback, run: null }
        const detail = await client.getRun(feedback.runId)
        return { feedback, run: detail ? runOverview(detail) : null }
      },
    },

    {
      name: 'get_tool_catalog',
      title: 'Get tool catalog',
      description: [
        'Every tool the platform can give an agent: its name, what it does, whether it reads or writes, the ambient run-scope keys it needs, and its `origin` — `sdk` for a tool the workflow SDK ships (fixed until the package is bumped), `host` for one this deployment wrote (a file in its own repo, changeable today), `connector` for one proxied from a third party’s MCP server (not changeable from either repo — a Refresh or their deploy is the only fix; see list_connectors). The catalog is fixed by the platform: an agent can be given any of these, and nothing else.',
        '',
        'The LIST deliberately carries no schemas — together they are most of a tool’s bytes and made this one call eight times the size of everything else in it, to answer a question the description already answers. Pass `toolIds` to drill into a few by name and get their full `inputSchema` / `outputSchema`, the same way get_run → get_run_step works.',
        '',
        'Read those schemas before writing a Tool node’s `args` or reasoning about what an agent called: an argument name taken from prose instead of from the schema is exactly the drift ART-146 / ART-175 exist to catch. `requiresContext` keys are also explained there — they are ambient scope the host supplies, never arguments an agent sets, and a tool whose scope is empty quietly matches nothing rather than failing.',
      ].join('\n'),
      inputSchema: {
        toolIds: z
          .array(z.string())
          .nullish()
          .describe(
            'Drill in: return these tools WITH their argument and output schemas, instead of the whole list without them.',
          ),
        query: z
          .string()
          .nullish()
          .describe(
            'Case-insensitive substring match on id, name or description.',
          ),
      },
      readOnly: true,
      run: async (client, args) => {
        const tools = await client.listTools()
        const wanted = (Array.isArray(args.toolIds) ? args.toolIds : []).filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
        const query = optString(args.query)?.toLowerCase()

        // The drill-in. `icon` is still dropped (inline SVG for the UI's chips),
        // but the schemas are the whole point of asking by name — and there was
        // no call anywhere in this surface that could produce one tool's argument
        // shape, which is the gap the size argument was quietly paying for.
        if (wanted.length > 0) {
          const byId = new Map(tools.map((t: ToolOption) => [t.id, t]))
          const missing = wanted.filter((id) => !byId.has(id))
          const found = wanted
            .map((id) => byId.get(id))
            .filter((t): t is ToolOption => t != null)
          // Only fetched on the drill-in: the keys are already returned in the
          // list, and it is only here that anyone needs to know what they MEAN.
          const contextFields = found.some(
            (t) => (t.requiresContext ?? []).length > 0,
          )
            ? await client.listToolContextFields().catch(() => [])
            : []
          return {
            tools: found.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              kind: t.kind,
              origin: t.origin,
              sideEffect: t.sideEffect ?? null,
              requiresContext: (t.requiresContext ?? []).map((key) => {
                const field = contextFields.find((f) => f.key === key)
                return field
                  ? {
                      key,
                      label: field.label,
                      description: field.description,
                      required: field.required,
                    }
                  : { key }
              }),
              inputSchema: t.inputSchema,
              outputSchema: t.outputSchema,
            })),
            missing: missing.length > 0 ? missing : undefined,
            note:
              missing.length > 0
                ? `No tool in this catalog with id: ${missing.join(', ')}. A connector tool is \`mcp:<connector>:<tool>\` and stops being listed entirely when its connector is disconnected — list_connectors says which.`
                : undefined,
          }
        }

        // Projected, not passed through. `icon` is inline SVG markup for the
        // UI's chips, and the two JSON Schemas are most of a tool's bytes —
        // together they made this one call 48k, eight times the rest of the
        // catalog, to answer a question ("what does this tool do") the
        // description already answers. `requiresContext` stays because it is
        // short and it is the field whose absence silently makes a tool match
        // nothing.
        const listed = tools.filter((t: ToolOption) => {
          if (!query) return true
          return `${t.id} ${t.name} ${t.description ?? ''}`
            .toLowerCase()
            .includes(query)
        })
        return {
          count: listed.length,
          tools: listed.map((t: ToolOption) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            kind: t.kind,
            // Cheap (one word) and it decides where a fix would even go, which
            // the name and description never reveal.
            origin: t.origin,
            sideEffect: t.sideEffect ?? null,
            requiresContext: t.requiresContext,
          })),
          note: 'Schemas are omitted here — pass `toolIds` for the argument shapes of the ones you need.',
        }
      },
    },
  ]
}
