import type { UIMessage } from 'ai'
import { z } from 'zod'

import type { RunContext, WfSdkConfig } from '../../engine/config'
import { getFeedbackForSubjects } from '../../storage'
import type { WfDb } from '../../storage/client'
import type { WfServerContext } from '../handlers/shared'

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
// It reuses the SAME host seams the data handler does — `config.getModel`
// (models are the ONE thing the host supplies), `config.toolRegistry`,
// `resolveDb`, `resolveEnv`, and `resolveContext` (the host's auth gate). The SDK
// itself stays auth-free; the host gatekeeps who may reach the mounted route.

const bodySchema = z.object({
  subject: z.enum(['workflow', 'agent', 'tool', 'eval', 'run', 'feedback']),
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

export type HandleCopilotOptions<TDeps> = {
  /** The host injection contract — only the model factory + tool registry are used. */
  config: Pick<WfSdkConfig<TDeps>, 'getModel' | 'toolRegistry'>
  /** Request-scoped wf storage (from the host's D1 binding). */
  resolveDb: (req: Request) => WfDb | Promise<WfDb>
  /**
   * The host's auth gate. Throw to reject (the SDK answers 403); the SDK is
   * otherwise auth-free. Mirrors `createWfSdkHandlers`' `resolveContext`.
   */
  resolveContext: (req: Request) => WfServerContext | Promise<WfServerContext>
  /** Host live bindings (Cloudflare `env`), handed to `config.getModel`. */
  resolveEnv?: (req: Request) => unknown
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

  const wfDb = await opts.resolveDb(req)
  const env = opts.resolveEnv ? opts.resolveEnv(req) : undefined

  // For the feedback surface, resolve the producing run up front so the system
  // prompt can point the model straight at it.
  let resolvedRunId: string | undefined
  if (subject === 'feedback' && feedbackSubjectId) {
    const rows = await getFeedbackForSubjects(wfDb, [feedbackSubjectId])
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
    tools: createCopilotTools({ wfDb, toolRegistry: opts.config.toolRegistry }),
    maxSteps: opts.maxSteps,
  })
}
