import { stableEqual } from '../../engine/stable-stringify'

/**
 * True when two payloads are structurally equal ignoring object-key order.
 *
 * Used by import to decide whether a config/graph actually changed before
 * publishing a new version, so re-importing an unchanged spec is a no-op. Two
 * payloads that differ only in key order (a fresh object vs. a JSON round-trip
 * out of the DB) must compare equal, and so must an explicitly-`undefined` key
 * against an absent one — a value that has been through D1 cannot carry the
 * former, so treating them as different drift meant every re-import republished.
 * That is `stableStringify`'s default `'drop'` mode; this used to map `undefined`
 * to `null` and get it wrong.
 */
export function payloadEqual(a: unknown, b: unknown): boolean {
  return stableEqual(a, b)
}
