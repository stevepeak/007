import { listChanges } from '../../storage/data'
import type { WfChangeDTO, WfChangeListInput } from '../protocol'

import type { WfHandlers } from './shared'

// Read side of the change log. There is no write handler: a change is recorded
// as a side effect of the mutation that caused it (`ctx.change`), never by a
// client asking for one — an audit row a caller could author is not an audit row.

function changeDTO(row: {
  id: string
  entityKind: WfChangeDTO['entityKind']
  entityId: string
  parentId: string | null
  action: WfChangeDTO['action']
  fields: unknown
  before: unknown
  after: unknown
  truncated: boolean
  actorId: string | null
  source: WfChangeDTO['source']
  note: string | null
  createdAt: Date
}): WfChangeDTO {
  return {
    id: row.id,
    entityKind: row.entityKind,
    entityId: row.entityId,
    parentId: row.parentId,
    action: row.action,
    fields: Array.isArray(row.fields) ? (row.fields as string[]) : [],
    before: row.before ?? null,
    after: row.after ?? null,
    truncated: row.truncated,
    actorId: row.actorId,
    source: row.source,
    note: row.note,
    createdAt: row.createdAt.getTime(),
  }
}

export function buildChangeHandlers(): Pick<WfHandlers, 'listChanges'> {
  return {
    listChanges: async (c) => {
      const p = (c.params ?? {}) as WfChangeListInput
      const rows = await listChanges(c.db, {
        entityKind: p.entityKind,
        entityId: p.entityId,
        parentId: p.parentId,
        actorId: p.actorId,
        limit: p.limit,
      })
      return rows.map(changeDTO)
    },
  }
}
