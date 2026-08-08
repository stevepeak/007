// Bounded append-only buffers on Durable Object storage — one key per entry.
//
// Split out of `run-room.ts` for two reasons. It is the part with arithmetic
// that can be subtly wrong (which keys fell off the end of a trimmed window),
// and `run-room.ts` imports `cloudflare:workers` at RUNTIME for `DurableObject`,
// which no unit test can resolve. Nothing here touches the DO base class, so it
// is testable against a plain Map.

/**
 * The slice of `DurableObjectStorage` these helpers need. Structural on purpose
 * — the real storage satisfies it, and so does a Map-backed fake.
 */
export type BufferStorage = {
  put(key: string, value: unknown): Promise<void>
  delete(keys: string[]): Promise<number>
  list<T>(options: {
    prefix: string
    limit: number
    reverse: boolean
  }): Promise<Map<string, T>>
}

/** A buffer's live window plus the next sequence to hand out. */
export type Tail<T> = {
  values: T[]
  /**
   * Invariant: `values` holds exactly sequences `[nextSeq - values.length,
   * nextSeq)`. Everything below depends on it — it is what lets a trim name the
   * keys it just dropped without re-listing storage.
   */
  nextSeq: number
}

// Zero-padded so the DO's lexicographic key order IS emit order — which is what
// makes a `reverse: true` list a "newest N entries" read. 12 digits is far past
// any run's plausible entry count.
const SEQ_WIDTH = 12

export function seqKey(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(SEQ_WIDTH, '0')}`
}

/**
 * Read the newest `limit` entries under `prefix`, back in emit order. A
 * cold-start cost only — the room memoizes the result for the rest of its life.
 */
export async function readTail<T>(
  storage: BufferStorage,
  prefix: string,
  limit: number,
): Promise<Tail<T>> {
  const rows = await storage.list<T>({ prefix, limit, reverse: true })
  const entries = [...rows].reverse()
  const lastKey = entries.at(-1)?.[0]
  return {
    values: entries.map(([, v]) => v),
    nextSeq: lastKey ? Number(lastKey.slice(prefix.length)) + 1 : 0,
  }
}

/**
 * Prefer per-key entries; fall back to a pre-split room's in-blob array.
 *
 * The cursor is seeded to the adopted length rather than 0 so the {@link Tail}
 * invariant holds on the legacy path too — seeding 0 with a non-empty buffer
 * would make the first trim compute negative sequences.
 */
export function adoptTail<T>(
  fromKeys: Tail<T>,
  legacy: T[],
  max: number,
): Tail<T> {
  if (fromKeys.values.length > 0 || legacy.length === 0) return fromKeys
  const values = legacy.slice(-max)
  return { values, nextSeq: values.length }
}

/**
 * Append one entry: write its own key, then delete whatever fell off the front.
 * O(1) storage bytes per call, regardless of how long the buffer is.
 *
 * This is the whole point of the key-per-entry layout. Holding the buffer in a
 * single value meant every append re-serialized the entire array — O(n²) bytes
 * across a run, against a 2 MB per-value ceiling that a long agent run can
 * actually reach.
 *
 * Mutates `buffer` in place to stay the room's live window.
 */
export async function appendBounded<T>(
  storage: BufferStorage,
  buffer: T[],
  entry: T,
  prefix: string,
  seq: number,
  max: number,
): Promise<void> {
  buffer.push(entry)
  await storage.put(seqKey(prefix, seq), entry)
  const overflow = buffer.length - max
  if (overflow <= 0) return
  buffer.splice(0, overflow)
  // Pre-splice the buffer spanned `[seq - (max + overflow) + 1, seq]`, so the
  // entries just dropped are the `overflow` sequences starting here.
  const firstDropped = seq - max - overflow + 1
  await storage.delete(
    Array.from({ length: overflow }, (_, i) => seqKey(prefix, firstDropped + i)),
  )
}
