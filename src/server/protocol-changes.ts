import type {
  WfChangeAction,
  WfChangeEntityKind,
  WfChangeSource,
} from '../storage/schema'

// The change log on the wire. One row is "someone did this to that, then" —
// deliberately flat, because every consumer renders it as a line in a feed.

export type WfChangeDTO = {
  id: string
  entityKind: WfChangeEntityKind
  entityId: string
  /** Grouping parent — a sample's Goal. Null for a top-level entity. */
  parentId: string | null
  action: WfChangeAction
  /** Human field labels — "model", "checks". Empty for a create or an archive. */
  fields: string[]
  /**
   * The payloads, for a reader who wants the detail. Null when the change never
   * carried one (a draft save) or when it was too large to keep — `truncated`
   * distinguishes those, because "nothing changed" and "we didn't keep it" are
   * very different claims.
   */
  before: unknown
  after: unknown
  truncated: boolean
  actorId: string | null
  source: WfChangeSource
  /** Free-text context — a publish's change note, an entity's name. */
  note: string | null
  createdAt: number
}

export type WfChangeListInput = {
  entityKind?: WfChangeEntityKind
  entityId?: string
  /** Include changes to children grouped under this id (a Goal's samples). */
  parentId?: string
  actorId?: string
  limit?: number
}
