import type { EvalRowSnapshot } from '../../eval/checks'

import type { EvalRowRecord } from './evals'

// The frozen per-result snapshot + its content hash. A result records the exact
// Sample (row) + Goal (set target) it was graded against, so a report reproduces
// even after the definitions change — the job a per-entity version counter used
// to do. Pure: the caller (the grade handler) builds, hashes, and persists it.

/**
 * Assemble the frozen {@link EvalRowSnapshot} for a result from the row + its
 * parent set (as returned by {@link getEvalRow}). Pure — the caller hashes and
 * persists it. See EvalRowSnapshot for why this replaces per-entity versioning.
 */
export function buildEvalSnapshot(
  row: EvalRowRecord,
  set: {
    id: string
    name: string
    targetKind: string
    targetId: string
    targetVersion: number | null
    triggerKind: string
  },
): EvalRowSnapshot {
  return {
    row: {
      name: row.name,
      description: row.description,
      initialCondition: row.initialCondition,
      fixtures: row.fixtures,
      checks: row.checks,
    },
    target: {
      setId: set.id,
      setName: set.name,
      targetKind: set.targetKind,
      targetId: set.targetId,
      targetVersion: set.targetVersion,
      triggerKind: set.triggerKind,
    },
  }
}

// Deterministic JSON with recursively sorted object keys, so the same logical
// snapshot always produces the same hash regardless of property insertion order.
//
// DO NOT replace this with `stableStringify` from `storage/spec/util.ts`. That
// one collapses a nested `undefined` to `"null"` (via `value ?? null`); this one
// emits the literal text `undefined`. This output is SHA-256'd into a PERSISTED
// snapshot hash that is compared across runs (see hashEvalSnapshot), so changing
// the `undefined` handling would silently re-classify unchanged Samples as
// "changed" and break dedup against already-stored hashes. The wire format is
// frozen; `eval-snapshot.test.ts` locks a known digest to catch any drift.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
  return `{${entries.join(',')}}`
}

/**
 * sha256 (hex) over a snapshot's reproducibility-relevant fields: the Sample
 * inputs (initialCondition + fixtures), the checks, and the Goal target
 * identity. Excludes cosmetic name/description so a rename isn't a "change".
 * Lets callers detect whether a Sample's effective definition changed between
 * two runs, and dedup identical snapshots — the job a version counter used to do.
 */
export async function hashEvalSnapshot(
  snapshot: EvalRowSnapshot,
): Promise<string> {
  const semantic = {
    initialCondition: snapshot.row.initialCondition,
    fixtures: snapshot.row.fixtures,
    checks: snapshot.row.checks,
    targetKind: snapshot.target.targetKind,
    targetId: snapshot.target.targetId,
    targetVersion: snapshot.target.targetVersion,
    triggerKind: snapshot.target.triggerKind,
  }
  const bytes = new TextEncoder().encode(stableStringify(semantic))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
