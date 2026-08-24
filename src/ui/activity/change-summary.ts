import type { WfChangeDTO } from '../../server/protocol'

// Turning one change row into one readable line.
//
// Pure, and separate from the component that renders it, because "what does this
// row SAY" is the part worth being exact about — a log nobody can read is a log
// nobody checks.

const KIND_NOUNS: Record<WfChangeDTO['entityKind'], string> = {
  workflow: 'workflow',
  agent: 'agent',
  eval_set: 'goal',
  eval_row: 'sample',
  model: 'model',
  assignment: 'assignment',
}

/** What the change did, as a verb phrase — "published", "edited". */
export function changeVerb(change: WfChangeDTO): string {
  switch (change.action) {
    case 'create':
      return 'created'
    case 'publish':
      return 'published'
    case 'archive':
      return 'archived'
    case 'restore':
      return 'restored'
    case 'assign':
      return 'assigned'
    case 'enable':
      return 'enabled'
    case 'disable':
      return 'disabled'
    case 'update':
      // A draft save is a distinct act from editing a published thing, and the
      // difference decides whether a run could have been affected.
      return change.fields.includes('draft') ? 'saved a draft of' : 'edited'
  }
}

export function changeNoun(change: WfChangeDTO): string {
  return KIND_NOUNS[change.entityKind]
}

/**
 * The one-line summary: "edited goal — checks, input".
 *
 * `draft` is dropped from the field list because the verb already carries it;
 * "saved a draft of agent — draft" says the same thing twice.
 */
export function changeSummary(change: WfChangeDTO): string {
  const head = `${changeVerb(change)} ${changeNoun(change)}`
  const fields = change.fields.filter((f) => f !== 'draft' && f !== 'initial')
  return fields.length > 0 ? `${head} — ${fields.join(', ')}` : head
}

/**
 * Who to credit. The log stores an opaque user id, which is the honest thing to
 * store and a poor thing to read — a host that can resolve names should, and
 * until it does this at least never claims a change was anonymous when it
 * wasn't.
 */
export function changeActor(change: WfChangeDTO): string {
  if (change.source === 'spec-import') return 'spec import'
  if (change.source === 'system') return 'system'
  return change.actorId ?? 'unknown'
}
