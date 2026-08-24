// Field labels for the things that have no version history of their own.
//
// Agents and workflows get theirs from `engine/config-fields`, shared with the
// editor so an audit row names a field the same way the UI that changed it does.
// Evals, entity metadata and assignments have no such table because nothing ever
// needed to describe them — until now.

/** Compare two records over a label table, returning the labels that moved. */
function diff<T>(
  fields: { key: keyof T; label: string }[],
  a: Partial<T>,
  b: Partial<T>,
): string[] {
  return fields
    .filter((f) => JSON.stringify(a[f.key]) !== JSON.stringify(b[f.key]))
    .map((f) => f.label)
}

type EvalSetFields = {
  name: string
  description: string | null
  targetKind: string
  targetId: string
  targetVersion: number | null
  triggerKind: string
  archived: boolean
}

// `target` covers kind + id together: they only ever move as a pair, and "target"
// is what an author calls the thing the Goal points at.
const EVAL_SET_FIELDS: { key: keyof EvalSetFields; label: string }[] = [
  { key: 'name', label: 'name' },
  { key: 'description', label: 'description' },
  { key: 'targetId', label: 'target' },
  { key: 'targetKind', label: 'target kind' },
  { key: 'targetVersion', label: 'pinned version' },
  { key: 'triggerKind', label: 'trigger' },
  { key: 'archived', label: 'archived' },
]

export function changedEvalSetFields(
  a: Partial<EvalSetFields>,
  b: Partial<EvalSetFields>,
): string[] {
  return diff(EVAL_SET_FIELDS, a, b)
}

type EvalRowFields = {
  name: string
  description: string | null
  input: unknown
  tools: unknown
  checks: unknown
  sortOrder: number
  archived: boolean
}

// `checks`, `input` and `tools` are the ones that matter: they are the grading
// criteria, so an edit to any of them can move a score on its own.
const EVAL_ROW_FIELDS: { key: keyof EvalRowFields; label: string }[] = [
  { key: 'name', label: 'name' },
  { key: 'description', label: 'description' },
  { key: 'input', label: 'input' },
  { key: 'tools', label: 'tools' },
  { key: 'checks', label: 'checks' },
  { key: 'sortOrder', label: 'order' },
  { key: 'archived', label: 'archived' },
]

export function changedEvalRowFields(
  a: Partial<EvalRowFields>,
  b: Partial<EvalRowFields>,
): string[] {
  return diff(EVAL_ROW_FIELDS, a, b)
}

type EntityMetaFields = {
  name: string
  description: string | null
  icon: string | null
  color: string | null
  archived: boolean
  hidden: boolean
  slug: string | null
}

// The unversioned half of an agent or workflow. A rename leaves no trace
// anywhere else — the entity row has `created_by` and nothing else.
const ENTITY_META_FIELDS: { key: keyof EntityMetaFields; label: string }[] = [
  { key: 'name', label: 'name' },
  { key: 'description', label: 'description' },
  { key: 'icon', label: 'icon' },
  { key: 'color', label: 'colour' },
  { key: 'slug', label: 'slug' },
  { key: 'archived', label: 'archived' },
  { key: 'hidden', label: 'hidden' },
]

export function changedEntityMetaFields(
  a: Partial<EntityMetaFields>,
  b: Partial<EntityMetaFields>,
): string[] {
  return diff(ENTITY_META_FIELDS, a, b)
}
