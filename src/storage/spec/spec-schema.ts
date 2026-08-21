// The portable "spec" — a flattened, version-controlled JSON representation of
// the *desired state* of a host's agents, workflows and evals. It is what
// `exportSpec` writes out of a DB and `importSpec` reconciles back into one
// (local or prod, any host project). It deliberately captures only the current
// published payload + identity + wiring, NOT version history, drafts or runs —
// git is the history, and the immutable-version tables stay DB-local.
//
// Identity is the slug (see `wfAgent.slug`), never the per-DB UUID. Graph
// agent/sub-workflow references therefore carry slugs in spec form
// (`agentSlug`/`workflowSlug`); the id↔slug translation lives in `./graph-refs`
// and happens only at the export/import boundary, so the engine never sees a
// slug. The spec graph is kept as `unknown` here on purpose: running it through
// `workflowGraphSchema` in slug form would strip the slug keys (that schema
// knows `agentId`, not `agentSlug`). Import validates the graph with
// `workflowGraphSchema` *after* translating slugs back to ids.

import { z } from 'zod'

import { agentConfigSchema } from '../../engine'
import { WF_EVAL_TARGET_KINDS } from '../schema'

/** Bumped only on a breaking change to the on-disk shape. */
export const SPEC_FORMAT_VERSION = 1

// ── Agent ──────────────────────────────────────────────────────────────────

export const agentSpecSchema = z.object({
  kind: z.literal('agent'),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullish(),
  icon: z.string().nullish(),
  color: z.string().nullish(),
  archived: z.boolean().optional(),
  /** The full versioned behavior — model, prompt, tools, output contract. */
  config: agentConfigSchema,
})
export type AgentSpec = z.infer<typeof agentSpecSchema>

// ── Workflow ─────────────────────────────────────────────────────────────────

export const workflowSpecSchema = z.object({
  kind: z.literal('workflow'),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullish(),
  hidden: z.boolean().optional(),
  archived: z.boolean().optional(),
  /**
   * Trigger kinds this workflow is assigned to run for (reverse of the one
   * global `wf_workflow_assignment` mapping). Usually zero or one; several is
   * allowed (many triggers → one workflow).
   */
  triggers: z.array(z.string().min(1)).default([]),
  /**
   * The published graph in *slug form* — agent nodes carry `agentSlug` and
   * workflow nodes `workflowSlug` instead of the DB's UUIDs. Opaque here
   * (`unknown`); translated + validated against `workflowGraphSchema` on import.
   */
  graph: z.unknown(),
})
export type WorkflowSpec = z.infer<typeof workflowSpecSchema>

// ── Eval ─────────────────────────────────────────────────────────────────────

// One eval row (Sample). Its JSON payloads are re-validated by `upsertEvalRow`
// on import, so they stay opaque in the spec.
export const evalRowSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  /** The target-shaped input — see EvalSampleInput. */
  input: z.unknown().optional(),
  /** The tool setting — see EvalTools. */
  tools: z.unknown().optional(),
  /**
   * LEGACY pre-split payloads, still read from spec files written before the
   * Input/Tools split. `readEvalRowSpec` folds them into `input`/`tools`;
   * export never writes them again.
   */
  initialCondition: z.unknown().optional(),
  fixtures: z.unknown().optional(),
  checks: z.unknown().optional(),
  sortOrder: z.number().int().optional(),
})

// One eval set (Goal). `target` is the slug of the agent/workflow it grades,
// paired with `targetKind` — the id is resolved on import.
export const evalSpecSchema = z.object({
  kind: z.literal('eval'),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullish(),
  targetKind: z.enum(WF_EVAL_TARGET_KINDS),
  target: z.string().min(1),
  targetVersion: z.number().int().nullish(),
  triggerKind: z.string().min(1),
  archived: z.boolean().optional(),
  rows: z.array(evalRowSpecSchema).default([]),
})
export type EvalSpec = z.infer<typeof evalSpecSchema>

// ── Bundle ───────────────────────────────────────────────────────────────────

export const specBundleSchema = z.object({
  formatVersion: z.literal(SPEC_FORMAT_VERSION),
  agents: z.array(agentSpecSchema).default([]),
  workflows: z.array(workflowSpecSchema).default([]),
  evals: z.array(evalSpecSchema).default([]),
})
export type SpecBundle = z.infer<typeof specBundleSchema>
