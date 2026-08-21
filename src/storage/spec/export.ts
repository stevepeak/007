// exportBundle — read a DB's current desired-state (agents, workflows, evals)
// into a portable {@link SpecBundle}. Reads only the *latest published version*
// of each entity plus its identity/metadata and trigger wiring; drafts, version
// history and runs stay DB-local.
//
// Side effect by design: any agent/workflow missing a slug is backfilled here
// (slugified from its name, de-collided) and persisted. Because slugify is
// deterministic and names match across environments, exporting a
// pre-slug-migration prod DB and a local one yields the *same* slugs — which is
// what lets a later import reconcile the two without creating duplicates.

import { desc, eq } from 'drizzle-orm'

import { workflowGraphShapeSchema } from '../../engine'
import type { WfDb } from '../client'
import {
  getEvalSet,
  latestAgentVersion,
  latestVersion,
  listEvalSets,
} from '../data'
import { wfAgent, wfWorkflow, wfWorkflowAssignment } from '../schema'

import { graphIdsToSlugs } from './graph-refs'
import { slugify, uniqueSlug } from './slug'
import {
  specBundleSchema,
  SPEC_FORMAT_VERSION,
  type AgentSpec,
  type EvalSpec,
  type SpecBundle,
  type WorkflowSpec,
} from './spec-schema'

export async function exportBundle(db: WfDb): Promise<SpecBundle> {
  // 1. Load every entity. Agents include archived (archived state is part of the
  //    desired state). Workflows exclude `hidden` — eval-wrapper machinery is
  //    generated, not authored content — but include archived.
  const agents = await db.select().from(wfAgent).orderBy(desc(wfAgent.createdAt))
  const workflows = await db
    .select()
    .from(wfWorkflow)
    .where(eq(wfWorkflow.hidden, false))
    .orderBy(desc(wfWorkflow.createdAt))

  // 2. Backfill + persist any missing slug, then build id→slug maps.
  const agentSlugById = await backfillSlugs(agents, (id, slug) =>
    db.update(wfAgent).set({ slug }).where(eq(wfAgent.id, id)),
  )
  const workflowSlugById = await backfillSlugs(workflows, (id, slug) =>
    db.update(wfWorkflow).set({ slug }).where(eq(wfWorkflow.id, id)),
  )

  // 3. Agents → specs (only those with a published version).
  const agentSpecs: AgentSpec[] = []
  for (const a of agents) {
    const version = await latestAgentVersion(db, a.id)
    if (!version) continue
    agentSpecs.push({
      kind: 'agent',
      slug: agentSlugById.get(a.id)!,
      name: a.name,
      description: a.description ?? undefined,
      icon: a.icon ?? undefined,
      color: a.color ?? undefined,
      archived: a.archived || undefined,
      config: version.config as AgentSpec['config'],
    })
  }

  // 4. Reverse the trigger→workflow assignment into workflow→triggers.
  const assignments = await db.select().from(wfWorkflowAssignment)
  const triggersByWorkflow = new Map<string, string[]>()
  for (const a of assignments) {
    const list = triggersByWorkflow.get(a.workflowId) ?? []
    list.push(a.triggerKind)
    triggersByWorkflow.set(a.workflowId, list)
  }

  // 5. Workflows → specs, with graph agent/sub-workflow refs rewritten to slugs.
  const workflowSpecs: WorkflowSpec[] = []
  for (const w of workflows) {
    const version = await latestVersion(db, w.id)
    if (!version) continue
    workflowSpecs.push({
      kind: 'workflow',
      slug: workflowSlugById.get(w.id)!,
      name: w.name,
      description: w.description ?? undefined,
      archived: w.archived || undefined,
      triggers: (triggersByWorkflow.get(w.id) ?? []).sort(),
      // Shape-normalize before translating ids→slugs so the emitted graph is
      // canonical (schema defaults applied) and deterministic across
      // environments — the same property the agent config gets from
      // `specBundleSchema.parse` below.
      graph: graphIdsToSlugs(workflowGraphShapeSchema.parse(version.graph), {
        agentSlugById,
        workflowSlugById,
      }),
    })
  }

  // 6. Eval sets → specs. Target UUID → slug (skip a set whose target didn't
  //    export, e.g. it points at a hidden workflow).
  const evalSpecs: EvalSpec[] = []
  const evalSlugsTaken = new Set<string>()
  for (const set of await listEvalSets(db, { includeArchived: true })) {
    const targetSlug =
      set.targetKind === 'agent'
        ? agentSlugById.get(set.targetId)
        : workflowSlugById.get(set.targetId)
    if (!targetSlug) continue
    const full = await getEvalSet(db, set.id)
    evalSpecs.push({
      kind: 'eval',
      slug: uniqueSlug(slugify(set.name), evalSlugsTaken),
      name: set.name,
      description: set.description ?? undefined,
      targetKind: set.targetKind,
      target: targetSlug,
      targetVersion: set.targetVersion ?? undefined,
      triggerKind: set.triggerKind,
      archived: set.archived || undefined,
      rows: (full?.rows ?? []).map((r) => ({
        name: r.name,
        description: r.description ?? undefined,
        input: r.input,
        tools: r.tools,
        checks: r.checks,
        sortOrder: r.sortOrder,
      })),
    })
  }

  // Sort by slug for deterministic, review-friendly output.
  const bySlug = (a: { slug: string }, b: { slug: string }) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  return specBundleSchema.parse({
    formatVersion: SPEC_FORMAT_VERSION,
    agents: agentSpecs.sort(bySlug),
    workflows: workflowSpecs.sort(bySlug),
    evals: evalSpecs.sort(bySlug),
  })
}

/** Assign + persist a slug to every row missing one; return the id→slug map. */
async function backfillSlugs(
  rows: { id: string; name: string; slug: string | null }[],
  persist: (id: string, slug: string) => unknown,
): Promise<Map<string, string>> {
  const taken = new Set(rows.map((r) => r.slug).filter((s): s is string => !!s))
  const byId = new Map<string, string>()
  for (const row of rows) {
    let slug = row.slug ?? undefined
    if (!slug) {
      slug = uniqueSlug(slugify(row.name), taken)
      await persist(row.id, slug)
    }
    byId.set(row.id, slug)
  }
  return byId
}
