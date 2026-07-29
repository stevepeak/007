// importBundle — reconcile a portable {@link SpecBundle} into a DB (local or
// prod, any host). Idempotent and additive: entities are matched by slug;
// missing ones are created, changed payloads are published as a NEW immutable
// version (history is never rewritten), and unchanged specs are a no-op. This
// is the generalization of the old hand-written seed reconcile.
//
// Order matters and is fixed here: agents first (workflow graphs resolve agent
// slugs → ids), then workflows (two passes so sub-workflow refs resolve before
// any row is written), then evals (targets resolve to agent/workflow ids).
//
// `dryRun` computes the change report without writing — the engine behind the
// CLI's `diff`. `prune` archives slugged entities absent from the bundle.

import { eq } from 'drizzle-orm'

import {
  agentConfigSchema,
  workflowGraphSchema,
  workflowGraphShapeSchema,
  type WorkflowGraph,
} from '../../engine'
import type { WfDb } from '../client'
import {
  assignWorkflow,
  createAgent,
  createEvalSet,
  createWorkflow,
  getEvalSet,
  latestAgentVersion,
  latestVersion,
  listEvalSets,
  publishAgent,
  saveVersion,
  updateEvalSet,
  upsertEvalRow,
} from '../data'
import { wfAgent, wfEvalRow, wfWorkflow } from '../schema'

import { graphSlugsToIds } from './graph-refs'
import { slugify } from './slug'
import type { EvalSpec, SpecBundle } from './spec-schema'
import { specBundleSchema } from './spec-schema'
import { payloadEqual } from './util'

export type ChangeAction = 'create' | 'update' | 'unchanged' | 'archive'

export interface EntityChange {
  kind: 'agent' | 'workflow' | 'eval'
  slug: string
  action: ChangeAction
}

export interface ImportOptions {
  /** Compute the change report without writing anything. */
  dryRun?: boolean
  /** Archive slugged entities present in the DB but absent from the bundle. */
  prune?: boolean
  /** Change note stamped on every new version this import publishes. */
  changeNote?: string
  /** Recorded as createdBy/publishedBy on new rows/versions. */
  actor?: string
}

export interface ChangeReport {
  changes: EntityChange[]
  /** True when nothing would change — the DB already matches the bundle. */
  clean: boolean
}

export async function importBundle(
  db: WfDb,
  bundleInput: unknown,
  opts: ImportOptions = {},
): Promise<ChangeReport> {
  const bundle: SpecBundle = specBundleSchema.parse(bundleInput)
  const changes: EntityChange[] = []
  const note = opts.changeNote ?? 'spec import'

  const agentIdBySlug = await reconcileAgents(db, bundle, opts, changes)
  const workflowIdBySlug = await reconcileWorkflows(
    db,
    bundle,
    { agentIdBySlug },
    opts,
    changes,
    note,
  )
  await reconcileEvals(
    db,
    bundle,
    { agentIdBySlug, workflowIdBySlug },
    opts,
    changes,
  )

  if (opts.prune) {
    await pruneMissing(db, bundle, opts, changes)
  }

  const clean = changes.every((c) => c.action === 'unchanged')
  return { changes, clean }
}

// ── Agents ───────────────────────────────────────────────────────────────────

async function reconcileAgents(
  db: WfDb,
  bundle: SpecBundle,
  opts: ImportOptions,
  changes: EntityChange[],
): Promise<Map<string, string>> {
  const existing = await db
    .select()
    .from(wfAgent)
    .then((rows) => new Map(rows.filter((r) => r.slug).map((r) => [r.slug!, r])))
  const idBySlug = new Map<string, string>()

  for (const spec of bundle.agents) {
    const row = existing.get(spec.slug)
    if (!row) {
      changes.push({ kind: 'agent', slug: spec.slug, action: 'create' })
      if (opts.dryRun) {
        idBySlug.set(spec.slug, `pending:${spec.slug}`)
        continue
      }
      const { agentId } = await createAgent(db, {
        slug: spec.slug,
        name: spec.name,
        description: spec.description ?? undefined,
        icon: spec.icon ?? undefined,
        color: spec.color ?? undefined,
        createdBy: opts.actor,
        config: spec.config,
      })
      if (spec.archived) {
        await db
          .update(wfAgent)
          .set({ archived: true, updatedAt: new Date() })
          .where(eq(wfAgent.id, agentId))
      }
      idBySlug.set(spec.slug, agentId)
      continue
    }

    idBySlug.set(spec.slug, row.id)
    const metaChanged = agentMetaChanged(row, spec)
    const current = await latestAgentVersion(db, row.id)
    // Compare *normalized* configs: a stored config missing a field the schema
    // now defaults (e.g. `subAgents`) is behaviorally identical to the spec's,
    // so it must not read as drift. spec.config is already schema-normalized
    // (the bundle was parsed through `agentConfigSchema`).
    const configChanged =
      !current ||
      !payloadEqual(agentConfigSchema.parse(current.config), spec.config)

    if (!metaChanged && !configChanged) {
      changes.push({ kind: 'agent', slug: spec.slug, action: 'unchanged' })
      continue
    }
    changes.push({ kind: 'agent', slug: spec.slug, action: 'update' })
    if (opts.dryRun) continue
    if (metaChanged) {
      await db
        .update(wfAgent)
        .set({
          name: spec.name,
          description: spec.description ?? null,
          icon: spec.icon ?? null,
          color: spec.color ?? null,
          archived: !!spec.archived,
          updatedAt: new Date(),
        })
        .where(eq(wfAgent.id, row.id))
    }
    if (configChanged) {
      await publishAgent(db, {
        agentId: row.id,
        config: spec.config,
        changeNote: opts.changeNote ?? 'spec import',
        publishedBy: opts.actor,
      })
    }
  }
  return idBySlug
}

function agentMetaChanged(
  row: typeof wfAgent.$inferSelect,
  spec: SpecBundle['agents'][number],
): boolean {
  return (
    row.name !== spec.name ||
    (row.description ?? null) !== (spec.description ?? null) ||
    (row.icon ?? null) !== (spec.icon ?? null) ||
    (row.color ?? null) !== (spec.color ?? null) ||
    row.archived !== !!spec.archived
  )
}

// ── Workflows ────────────────────────────────────────────────────────────────

async function reconcileWorkflows(
  db: WfDb,
  bundle: SpecBundle,
  maps: { agentIdBySlug: Map<string, string> },
  opts: ImportOptions,
  changes: EntityChange[],
  note: string,
): Promise<Map<string, string>> {
  const existing = await db
    .select()
    .from(wfWorkflow)
    .then((rows) => new Map(rows.filter((r) => r.slug).map((r) => [r.slug!, r])))

  // Pass A — assign every bundle workflow an id (existing row's, or a fresh one
  // for a new workflow) so a graph's sub-workflow slug refs resolve in pass B.
  const idBySlug = new Map<string, string>()
  for (const spec of bundle.workflows) {
    idBySlug.set(spec.slug, existing.get(spec.slug)?.id ?? crypto.randomUUID())
  }

  // Pass B — translate + validate the graph, then create or reconcile.
  for (const spec of bundle.workflows) {
    const id = idBySlug.get(spec.slug)!
    const graph: WorkflowGraph = workflowGraphSchema.parse(
      graphSlugsToIds(spec.graph, {
        agentIdBySlug: maps.agentIdBySlug,
        workflowIdBySlug: idBySlug,
      }),
    )
    const row = existing.get(spec.slug)

    if (!row) {
      changes.push({ kind: 'workflow', slug: spec.slug, action: 'create' })
      if (!opts.dryRun) {
        await createWorkflow(db, {
          id,
          slug: spec.slug,
          name: spec.name,
          description: spec.description ?? undefined,
          hidden: spec.hidden,
          createdBy: opts.actor,
          graph,
        })
        if (spec.archived) {
          await db
            .update(wfWorkflow)
            .set({ archived: true, updatedAt: new Date() })
            .where(eq(wfWorkflow.id, id))
        }
        await assignTriggers(db, spec.triggers, id, opts)
      }
      continue
    }

    const metaChanged =
      row.name !== spec.name ||
      (row.description ?? null) !== (spec.description ?? null) ||
      row.archived !== !!spec.archived
    const current = await latestVersion(db, row.id)
    // Normalize both graphs through the shape schema before comparing, so
    // schema-defaulted fields don't read as drift (mirrors the agent-config
    // compare above). Shape-only avoids the integrity superRefine throwing on a
    // historical version.
    const graphChanged =
      !current ||
      !payloadEqual(
        workflowGraphShapeSchema.parse(current.graph),
        workflowGraphShapeSchema.parse(graph),
      )

    if (!metaChanged && !graphChanged) {
      changes.push({ kind: 'workflow', slug: spec.slug, action: 'unchanged' })
    } else {
      changes.push({ kind: 'workflow', slug: spec.slug, action: 'update' })
    }
    if (opts.dryRun) {
      // Assignments still reconcile in a real run; skipped in dryRun.
      continue
    }
    if (metaChanged) {
      await db
        .update(wfWorkflow)
        .set({
          name: spec.name,
          description: spec.description ?? null,
          archived: !!spec.archived,
          updatedAt: new Date(),
        })
        .where(eq(wfWorkflow.id, row.id))
    }
    if (graphChanged) {
      await saveVersion(db, {
        workflowId: row.id,
        graph,
        changeNote: note,
        publishedBy: opts.actor,
      })
    }
    await assignTriggers(db, spec.triggers, row.id, opts)
  }
  return idBySlug
}

async function assignTriggers(
  db: WfDb,
  triggers: string[],
  workflowId: string,
  opts: ImportOptions,
): Promise<void> {
  for (const triggerKind of triggers) {
    await assignWorkflow(db, { triggerKind, workflowId, assignedBy: opts.actor })
  }
}

// ── Evals ────────────────────────────────────────────────────────────────────

async function reconcileEvals(
  db: WfDb,
  bundle: SpecBundle,
  maps: {
    agentIdBySlug: Map<string, string>
    workflowIdBySlug: Map<string, string>
  },
  opts: ImportOptions,
  changes: EntityChange[],
): Promise<void> {
  if (bundle.evals.length === 0) return
  // Eval sets have no slug column; match on slugify(name) — stable while a
  // Goal keeps its name, which is the identity the spec's slug is derived from.
  const existing = new Map(
    (await listEvalSets(db, { includeArchived: true })).map((s) => [
      slugify(s.name),
      s,
    ]),
  )

  for (const spec of bundle.evals) {
    const targetId =
      spec.targetKind === 'agent'
        ? maps.agentIdBySlug.get(spec.target)
        : maps.workflowIdBySlug.get(spec.target)
    if (!targetId) {
      throw new Error(
        `Eval "${spec.slug}" targets ${spec.targetKind} "${spec.target}", ` +
          `which is not in the bundle.`,
      )
    }

    const match = existing.get(spec.slug)
    if (!match) {
      changes.push({ kind: 'eval', slug: spec.slug, action: 'create' })
      if (opts.dryRun) continue
      const setId = await createEvalSet(db, {
        name: spec.name,
        description: spec.description ?? undefined,
        targetKind: spec.targetKind,
        targetId,
        targetVersion: spec.targetVersion ?? null,
        triggerKind: spec.triggerKind,
        createdBy: opts.actor,
      })
      await writeEvalRows(db, setId, spec)
      continue
    }

    const unchanged = await evalUnchanged(db, match.id, spec, targetId)
    changes.push({
      kind: 'eval',
      slug: spec.slug,
      action: unchanged ? 'unchanged' : 'update',
    })
    if (unchanged || opts.dryRun) continue
    await updateEvalSet(db, {
      setId: match.id,
      name: spec.name,
      description: spec.description ?? null,
      targetKind: spec.targetKind,
      targetId,
      targetVersion: spec.targetVersion ?? null,
      triggerKind: spec.triggerKind,
      archived: !!spec.archived,
    })
    // Replace rows wholesale — rows carry no stable identity, and historical
    // results keep their own frozen snapshot, so this doesn't corrupt history.
    await db.delete(wfEvalRow).where(eq(wfEvalRow.setId, match.id))
    await writeEvalRows(db, match.id, spec)
  }
}

async function writeEvalRows(
  db: WfDb,
  setId: string,
  spec: EvalSpec,
): Promise<void> {
  let order = 0
  for (const row of spec.rows) {
    await upsertEvalRow(db, {
      setId,
      name: row.name,
      description: row.description ?? null,
      initialCondition: row.initialCondition as never,
      fixtures: row.fixtures as never,
      checks: row.checks as never,
      sortOrder: row.sortOrder ?? order++,
    })
  }
}

async function evalUnchanged(
  db: WfDb,
  setId: string,
  spec: EvalSpec,
  targetId: string,
): Promise<boolean> {
  const current = await getEvalSet(db, setId)
  if (!current) return false
  const set = current.set
  const metaSame =
    set.name === spec.name &&
    (set.description ?? null) === (spec.description ?? null) &&
    set.targetKind === spec.targetKind &&
    set.targetId === targetId &&
    (set.targetVersion ?? null) === (spec.targetVersion ?? null) &&
    set.triggerKind === spec.triggerKind &&
    set.archived === !!spec.archived
  if (!metaSame) return false
  const currentRows = current.rows.map((r) => ({
    name: r.name,
    description: r.description ?? null,
    initialCondition: r.initialCondition,
    fixtures: r.fixtures,
    checks: r.checks,
  }))
  const specRows = spec.rows.map((r) => ({
    name: r.name,
    description: r.description ?? null,
    initialCondition: r.initialCondition ?? {},
    fixtures: r.fixtures ?? {},
    checks: r.checks ?? { op: 'and', checks: [] },
  }))
  return payloadEqual(currentRows, specRows)
}

// ── Prune ────────────────────────────────────────────────────────────────────

async function pruneMissing(
  db: WfDb,
  bundle: SpecBundle,
  opts: ImportOptions,
  changes: EntityChange[],
): Promise<void> {
  const bundleAgents = new Set(bundle.agents.map((a) => a.slug))
  const bundleWorkflows = new Set(bundle.workflows.map((w) => w.slug))

  const agents = await db.select().from(wfAgent)
  for (const a of agents) {
    if (!a.slug || bundleAgents.has(a.slug) || a.archived) continue
    changes.push({ kind: 'agent', slug: a.slug, action: 'archive' })
    if (!opts.dryRun) {
      await db
        .update(wfAgent)
        .set({ archived: true, updatedAt: new Date() })
        .where(eq(wfAgent.id, a.id))
    }
  }
  const workflows = await db.select().from(wfWorkflow)
  for (const w of workflows) {
    if (!w.slug || w.hidden || bundleWorkflows.has(w.slug) || w.archived) continue
    changes.push({ kind: 'workflow', slug: w.slug, action: 'archive' })
    if (!opts.dryRun) {
      await db
        .update(wfWorkflow)
        .set({ archived: true, updatedAt: new Date() })
        .where(eq(wfWorkflow.id, w.id))
    }
  }
}
