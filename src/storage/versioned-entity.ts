import { and, desc, eq } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'

import type { WfDb } from './client'

// ---------------------------------------------------------------------------
// Shared "versioned entity" lifecycle
// ---------------------------------------------------------------------------
//
// Workflows and agents are the same shape: a globally shared, editable entity
// with immutable published *versions* and a 1:1 editable *draft* sidecar that
// floats to the latest version. Only three things differ between them:
//
//   • the owner column on the version/draft tables (`workflow_id` vs `agent_id`)
//   • the JSON payload column (`graph` vs `config`)
//   • a handful of extra columns some publishes carry (workflow versions add the
//     AI summary; both may carry a `changeNote`)
//
// This factory owns the *sequencing* — the bug-prone part that used to live
// twice: compute the next version number, seed v1 + a matching draft, snapshot
// a new immutable version and keep the draft in sync, reset a draft to the
// latest version. Callers supply only a declarative table/column config plus,
// per call, the extra column values that vary. The single localized `as`
// casts below are the price of writing the owner/payload columns by name across
// two different table types — the runtime keys are guaranteed by the config.

/** Row shape the factory relies on existing on both version tables. */
type VersionRowBase = {
  id: string
  versionNumber: number
  publishedAt: Date | null
}

export interface VersionedEntityConfig<
  ETable extends SQLiteTable,
  VTable extends SQLiteTable,
  DTable extends SQLiteTable,
> {
  /** The entity row table (e.g. `wfWorkflow` / `wfAgent`). */
  entityTable: ETable
  /** Primary-key column on the entity table (e.g. `wfWorkflow.id`). */
  entityIdCol: SQLiteColumn
  versionTable: VTable
  draftTable: DTable
  /** Owner FK column on the version table (e.g. `wfWorkflowVersion.workflowId`). */
  versionOwnerCol: SQLiteColumn
  /** `version_number` column on the version table. */
  versionNumberCol: SQLiteColumn
  /** Owner PK column on the draft table (e.g. `wfWorkflowDraft.workflowId`). */
  draftOwnerCol: SQLiteColumn
  /** Name of the owner column as a key (e.g. `'workflowId'`). */
  ownerKey: string
  /** Name of the JSON payload column as a key (e.g. `'graph'` or `'config'`). */
  payloadKey: string
}

export interface SeedInput<Payload> {
  ownerId: string
  payload: Payload
  createdBy?: string | null
  /** Extra version columns to persist (e.g. AI summary). */
  versionExtra?: Record<string, unknown>
}

export interface PublishInput<Payload> {
  ownerId: string
  payload: Payload
  publishedBy?: string | null
  changeNote?: string | null
  /** Extra version columns to persist (e.g. AI summary). */
  versionExtra?: Record<string, unknown>
}

export interface VersionedEntity<
  Payload,
  VRow extends VersionRowBase,
  ERow,
  DRow,
> {
  /** The latest immutable version row, or undefined when none exist yet. */
  latest(db: WfDb, ownerId: string): Promise<VRow | undefined>
  /**
   * One specific published version by its NUMBER, or undefined when that number
   * was never published — the pinned counterpart to {@link latest}. A `null`
   * pin floats to latest; a number resolves exactly this. Backed by the
   * `(ownerId, versionNumber)` unique index both version tables carry.
   */
  byNumber(
    db: WfDb,
    ownerId: string,
    versionNumber: number,
  ): Promise<VRow | undefined>
  /** Cheap existence check — one indexed `SELECT id LIMIT 1`. */
  exists(db: WfDb, ownerId: string): Promise<boolean>
  /**
   * The editor's load shape: the entity row, its draft (if any), and the latest
   * version. `null` when the entity doesn't exist. Callers rename `entity` to
   * their domain noun (`workflow` / `agent`).
   */
  load(
    db: WfDb,
    ownerId: string,
  ): Promise<{ entity: ERow; draft: DRow | null; currentVersion: VRow | null } | null>
  /** Insert version 1 + a matching draft. Returns the new version id. */
  seed(db: WfDb, input: SeedInput<Payload>): Promise<{ versionId: string }>
  /**
   * Patch the entity row's display metadata (the caller supplies the already
   * whitelisted fields) and bump `updatedAt`.
   */
  updateMeta(
    db: WfDb,
    ownerId: string,
    patch: Record<string, unknown>,
  ): Promise<void>
  /** Insert/replace the draft (the editor's autosave). */
  updateDraft(
    db: WfDb,
    input: { ownerId: string; payload: Payload; lastEditedBy?: string | null },
  ): Promise<void>
  /** Snapshot a new immutable version and keep the draft in sync ("publish"). */
  publish(
    db: WfDb,
    input: PublishInput<Payload>,
  ): Promise<{ versionId: string; versionNumber: number }>
  /** Reset the draft back to the latest published version's payload. */
  discardDraft(db: WfDb, ownerId: string): Promise<void>
}

export function createVersionedEntity<
  Payload,
  VRow extends VersionRowBase,
  ERow = Record<string, unknown>,
  DRow = Record<string, unknown>,
  ETable extends SQLiteTable = SQLiteTable,
  VTable extends SQLiteTable = SQLiteTable,
  DTable extends SQLiteTable = SQLiteTable,
>(
  cfg: VersionedEntityConfig<ETable, VTable, DTable>,
): VersionedEntity<Payload, VRow, ERow, DRow> {
  type VInsert = VTable['$inferInsert']
  type DInsert = DTable['$inferInsert']
  type EInsert = ETable['$inferInsert']

  const versionValues = (
    ownerId: string,
    versionNumber: number,
    payload: Payload,
    who: string | null,
    extra: Record<string, unknown> | undefined,
  ): VInsert =>
    ({
      id: crypto.randomUUID(),
      [cfg.ownerKey]: ownerId,
      versionNumber,
      [cfg.payloadKey]: payload,
      createdBy: who,
      publishedBy: who,
      publishedAt: new Date(),
      ...extra,
    })

  const draftValues = (
    ownerId: string,
    payload: Payload,
    baseVersionId: string | null,
    lastEditedBy: string | null,
  ): DInsert =>
    ({
      [cfg.ownerKey]: ownerId,
      [cfg.payloadKey]: payload,
      baseVersionId,
      lastEditedBy,
      updatedAt: new Date(),
    })

  const latest = async (db: WfDb, ownerId: string) => {
    const rows = await db
      .select()
      .from(cfg.versionTable)
      .where(eq(cfg.versionOwnerCol, ownerId))
      .orderBy(desc(cfg.versionNumberCol))
      .limit(1)
    return rows[0] as VRow | undefined
  }

  const byNumber = async (
    db: WfDb,
    ownerId: string,
    versionNumber: number,
  ) => {
    const rows = await db
      .select()
      .from(cfg.versionTable)
      .where(
        and(
          eq(cfg.versionOwnerCol, ownerId),
          eq(cfg.versionNumberCol, versionNumber),
        ),
      )
      .limit(1)
    return rows[0] as VRow | undefined
  }

  return {
    latest,
    byNumber,

    async exists(db, ownerId) {
      const row = (
        await db
          .select({ id: cfg.entityIdCol })
          .from(cfg.entityTable)
          .where(eq(cfg.entityIdCol, ownerId))
          .limit(1)
      )[0]
      return row !== undefined
    },

    async load(db, ownerId) {
      const entity = (
        await db
          .select()
          .from(cfg.entityTable)
          .where(eq(cfg.entityIdCol, ownerId))
          .limit(1)
      )[0] as ERow | undefined
      if (!entity) return null
      const draft = (
        await db
          .select()
          .from(cfg.draftTable)
          .where(eq(cfg.draftOwnerCol, ownerId))
          .limit(1)
      )[0] as DRow | undefined
      const currentVersion = await latest(db, ownerId)
      return {
        entity,
        draft: draft ?? null,
        currentVersion: currentVersion ?? null,
      }
    },

    async updateMeta(db, ownerId, patch) {
      await db
        .update(cfg.entityTable)
        .set({ ...patch, updatedAt: new Date() } as EInsert)
        .where(eq(cfg.entityIdCol, ownerId))
    },

    async seed(db, input) {
      const versionId = crypto.randomUUID()
      const who = input.createdBy ?? null
      await db.insert(cfg.versionTable).values({
        ...versionValues(input.ownerId, 1, input.payload, who, input.versionExtra),
        id: versionId,
      } as VInsert)
      await db
        .insert(cfg.draftTable)
        .values(draftValues(input.ownerId, input.payload, versionId, who))
      return { versionId }
    },

    async updateDraft(db, input) {
      const who = input.lastEditedBy ?? null
      // A fresh draft has no baseVersionId (kept whatever it was on conflict).
      const values = {
        [cfg.ownerKey]: input.ownerId,
        [cfg.payloadKey]: input.payload,
        lastEditedBy: who,
        updatedAt: new Date(),
      }
      await db
        .insert(cfg.draftTable)
        .values(values as DInsert)
        .onConflictDoUpdate({
          target: cfg.draftOwnerCol,
          set: {
            [cfg.payloadKey]: input.payload,
            lastEditedBy: who,
            updatedAt: new Date(),
          } as DInsert,
        })
    },

    async publish(db, input) {
      const prev = await latest(db, input.ownerId)
      const versionNumber = (prev?.versionNumber ?? 0) + 1
      const versionId = crypto.randomUUID()
      const who = input.publishedBy ?? null
      await db.insert(cfg.versionTable).values({
        ...versionValues(
          input.ownerId,
          versionNumber,
          input.payload,
          who,
          input.versionExtra,
        ),
        id: versionId,
        changeNote: input.changeNote ?? null,
      } as VInsert)
      // Keep the draft in sync with the freshly published version.
      await db
        .update(cfg.draftTable)
        .set({
          [cfg.payloadKey]: input.payload,
          baseVersionId: versionId,
          updatedAt: new Date(),
        } as DInsert)
        .where(eq(cfg.draftOwnerCol, input.ownerId))
      return { versionId, versionNumber }
    },

    async discardDraft(db, ownerId) {
      const version = await latest(db, ownerId)
      if (!version) return
      await db
        .update(cfg.draftTable)
        .set({
          [cfg.payloadKey]: (version as Record<string, unknown>)[cfg.payloadKey],
          baseVersionId: version.id,
          updatedAt: new Date(),
        } as DInsert)
        .where(eq(cfg.draftOwnerCol, ownerId))
    },
  }
}
