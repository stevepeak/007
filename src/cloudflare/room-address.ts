import type { RunRoom } from './run-room'

// Where a RunRoom lives. A Durable Object is created wherever its first caller
// is unless the namespace is scoped to a jurisdiction, and the jurisdiction is
// part of the object id — the same name in two jurisdictions is two objects.
// So every call site that addresses a room must resolve it the same way; this
// is the one place that does.

/** The jurisdictions Cloudflare accepts for a Durable Object namespace. */
export const RUN_ROOM_JURISDICTIONS = ['eu', 'fedramp'] as const

export type RunRoomJurisdiction = (typeof RUN_ROOM_JURISDICTIONS)[number]

export interface RunRoomBindings {
  RUN_ROOM: DurableObjectNamespace<RunRoom>
  /**
   * Optional. Pins every RunRoom to a jurisdiction (e.g. `'eu'`). Unset keeps
   * the default: a room is created near its first caller.
   *
   * Changing it re-addresses rooms: a run whose room was created under the old
   * value cannot find it under the new one, so drain in-flight runs first.
   */
  RUN_ROOM_JURISDICTION?: string
}

/** The stub for the room named `name`, honouring `RUN_ROOM_JURISDICTION`. */
export function runRoomStub(
  env: RunRoomBindings,
  name: string,
): DurableObjectStub<RunRoom> {
  const jurisdiction = env.RUN_ROOM_JURISDICTION?.trim()
  let ns = env.RUN_ROOM
  if (jurisdiction) {
    if (!(RUN_ROOM_JURISDICTIONS as readonly string[]).includes(jurisdiction)) {
      // Fail loudly: silently falling back would put rooms outside the
      // jurisdiction the host asked for.
      throw new Error(
        `RUN_ROOM_JURISDICTION "${jurisdiction}" is not one of ${RUN_ROOM_JURISDICTIONS.join(', ')}.`,
      )
    }
    ns = ns.jurisdiction(jurisdiction as RunRoomJurisdiction)
  }
  return ns.get(ns.idFromName(name))
}
