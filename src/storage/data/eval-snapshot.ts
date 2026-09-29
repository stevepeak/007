import type { EvalRowSnapshot } from '../../engine/eval-schema'
import { stableStringify } from '../../engine/stable-stringify'

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
      input: row.input,
      tools: row.tools,
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

/**
 * sha256 (hex) over a snapshot's reproducibility-relevant fields: the Sample
 * inputs (input + tools), the checks, and the Goal target
 * identity. Excludes cosmetic name/description so a rename isn't a "change".
 * Lets callers detect whether a Sample's effective definition changed between
 * two runs, and dedup identical snapshots — the job a version counter used to do.
 */
export async function hashEvalSnapshot(
  snapshot: EvalRowSnapshot,
): Promise<string> {
  const semantic = {
    input: snapshot.row.input,
    tools: snapshot.row.tools,
    checks: snapshot.row.checks,
    targetKind: snapshot.target.targetKind,
    targetId: snapshot.target.targetId,
    targetVersion: snapshot.target.targetVersion,
    triggerKind: snapshot.target.triggerKind,
  }
  // `undefinedKeys: 'literal'` is NOT the sensible default — every other caller
  // wants `'drop'`. It is pinned here because this output is SHA-256'd into a
  // PERSISTED hash that is compared across runs, so its wire format is frozen: a
  // nested `undefined` must keep rendering as the bare text `undefined` (keeping
  // the key) or unchanged Samples would silently re-classify as "changed" and
  // dedup against already-stored hashes would break. `eval-snapshot.test.ts`
  // locks a known digest to catch any drift.
  const bytes = new TextEncoder().encode(
    stableStringify(semantic, { undefinedKeys: 'literal' }),
  )
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
