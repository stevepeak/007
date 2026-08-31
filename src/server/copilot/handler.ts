import type { UIMessage } from 'ai'
import { z } from 'zod'

import type { RunContext } from '../../engine/config'
import { createWfSdkHandlers } from '../handlers'
import type { CreateWfSdkHandlersOptions } from '../handlers/shared'
import { createLocalWfDataClient } from '../local-client'

import { runCopilot } from './run-copilot'
import {
  buildCopilotSystemPrompt,
  type CopilotContext,
} from './system-prompt'
import { createCopilotTools } from './tools'

// The System Copilot request handler — an ephemeral, read-only agentic chat over
// the platform's own agents/tools/workflows/runs/feedback. It runs NO workflow
// and persists NOTHING: no message rows, no wf_run. The response is a streaming
// UIMessage stream; the client (useChat) holds the only copy of the conversation.
//
// It reuses the SAME host seams the data handler does — because it now reuses
// the data handler itself: its tools are the shared `wf-mcp` definitions bound
// to a client that dispatches in-process through `createWfSdkHandlers`. So a
// copilot tool call is validated, audited and auth-gated exactly like the same
// read from the editor, and the copilot cannot see anything the caller's own
// browser could not ask for. The SDK itself stays auth-free; the host gatekeeps
// who may reach the mounted route.

const bodySchema = z.object({
  subject: z.enum([
    'workflow',
    'agent',
    'tool',
    'eval',
    'run',
    'feedback',
    // Browsing the hub / section lists — no single asset in focus. The copilot
    // answers platform-wide (see `buildCopilotSystemPrompt`).
    'system',
  ]),
  subjectId: z.string().optional(),
  runId: z.string().optional(),
  feedbackSubjectId: z.string().optional(),
  /** The model the user picked in the dock's model button (a catalog id). */
  modelId: z.string().optional(),
  // Trust the AI SDK for the full UIMessage shape; only validate the envelope.
  messages: z
    .array(z.object({ role: z.string(), parts: z.array(z.unknown()) }))
    .min(1),
})

/**
 * Everything the DATA route needs, plus the two copilot-only knobs.
 *
 * Stated as the data handler's own options because the copilot dispatches
 * through them — a host can hand the same object to both routes, and a seam
 * added to one surface can't go missing on the other.
 */
export type HandleCopilotOptions<TDeps> = CreateWfSdkHandlersOptions<TDeps> & {
  /**
   * Model used when the request carries no `modelId` (first load, before the
   * dock's picker has resolved the enabled-models list). Omit to require one.
   */
  defaultModelId?: string
  /** Max tool-calling rounds before the copilot must answer. Defaults to 12. */
  maxSteps?: number
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function handleCopilotRequest<TDeps>(
  req: Request,
  opts: HandleCopilotOptions<TDeps>,
): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Auth first — the host's gate throws for anyone who may not reach the surface.
  try {
    await opts.resolveContext(req)
  } catch {
    return json({ error: 'Forbidden' }, 403)
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400)
  }
  const { subject, subjectId, runId, feedbackSubjectId, modelId, messages } =
    parsed.data

  const chosenModelId = modelId ?? opts.defaultModelId
  if (!chosenModelId) {
    return json({ error: 'No model selected.' }, 400)
  }

  const env = opts.resolveEnv ? await opts.resolveEnv(req) : undefined

  // The copilot's own view of the data surface: the mounted dispatcher, called
  // in-process with this request's credentials. Built per request because that
  // is what it is scoped to.
  const client = createLocalWfDataClient({
    handler: createWfSdkHandlers(opts),
    request: req,
  })

  // For the feedback surface, resolve the producing run up front so the system
  // prompt can point the model straight at it.
  let resolvedRunId: string | undefined
  if (subject === 'feedback' && feedbackSubjectId) {
    const rows = await client.getFeedbackForSubjects({
      subjectIds: [feedbackSubjectId],
    })
    resolvedRunId = rows[0]?.runId ?? undefined
  }

  const ctx: CopilotContext = {
    subject,
    subjectId,
    runId,
    feedbackSubjectId,
    resolvedRunId,
  }

  // Resolve the picked model through the host's provider seam. `reasoning` is
  // left undefined → the host's default (thinking on), which the copilot wants:
  // its value is reasoning over multi-step run traces.
  const runContext: RunContext = { triggerKind: 'copilot', env }
  const model = opts.config.getModel(chosenModelId, runContext)

  return await runCopilot({
    model,
    system: buildCopilotSystemPrompt(ctx),
    messages: messages as unknown as UIMessage[],
    tools: createCopilotTools(client),
    maxSteps: opts.maxSteps,
  })
}
