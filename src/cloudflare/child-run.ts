import type {
  WfEngine,
  WfRunManifestEntry,
  WfWorkflowManifestEntry,
} from '../engine/graph'
import { resolveGraphEngine } from '../engine/graph-engine'
import type { WfDb } from '../storage/client'
import { createRun } from '../storage/data'

import {
  assertValidEventType,
  toCalleeWire,
  type CalleeDoneEvent,
  type CalleeParent,
} from './callee-protocol'
import type {
  GraphRunContextInput,
  GraphWorkflowParams,
} from './graph-workflow'
import type { GraphRunBindings } from './start-run'

// Starting a called workflow as a RUN OF ITS OWN — the one place either backend
// goes to spawn a callee.
//
// Two things are decided here, and nowhere else:
//
//  1. WHICH ENGINE. The callee's own trigger declares it (`resolveGraphEngine`
//     over the graph frozen in the run manifest). The CALLER never gets a say:
//     durability is a property of the workflow that has to survive, and a caller
//     able to override it would mean one published workflow behaves differently
//     depending on who invoked it.
//
//  2. THAT IT IS A CHILD. Every callee gets a `wf_run` linked to the calling run
//     and the calling node, exactly as a durable iteration item does — so the
//     run viewer nests it, `descendantRunIds` rolls its cost up, and a failure
//     three workflows deep is reachable from the run someone actually started.
//
// Everything else — how the parent WAITS, and how the child reports back — is
// the caller's business (`CalleeParent` names the two answers).

/**
 * The bindings this handshake needs: somewhere to start a child (a Workflows
 * instance or a room) and somewhere to report back to. Narrower than the full
 * run env on purpose — the database is passed separately, because both callers
 * already hold one (the durable backend must build it INSIDE its step, where a
 * live D1 binding is legal).
 */
export type ChildRunBindings = Pick<
  GraphRunBindings,
  'GRAPH_WORKFLOW' | 'RUN_ROOM'
>

/** What a spawned callee is, once it exists. */
export type SpawnedChildRun = {
  /** The callee's own `wf_run.id`. */
  childRunId: string
  /** The engine it was started on, as its own trigger declared. */
  engine: WfEngine
  /** The Workflows instance id, or null for a callee on the inline engine
   *  (which runs in a Durable Object and has no instance). */
  instanceId: string | null
}

export type SpawnCalleeRunArgs = {
  /** The callee, resolved and frozen into the caller's run manifest. */
  entry: WfWorkflowManifestEntry
  /** What the callee's trigger is seeded with. */
  triggerInput: unknown
  /** The calling run and the workflow-call node inside it — the nesting link. */
  parentRunId: string
  nodeId: string
  /** The caller's context, inherited wholesale so the callee's tools behave
   *  exactly as they would have inside the caller. Serializable — the live
   *  `env` is re-attached by whichever host picks the child up. */
  runContext: GraphRunContextInput
  /**
   * The caller's frozen manifest, passed down instead of re-resolved: the
   * callee's own references are already in it (resolution is transitive), and
   * re-resolving would float them to whatever is published at that moment,
   * splitting one logical run across two prompt versions.
   */
  manifest: WfRunManifestEntry[]
  /** The caller's Sentry trace, so the callee's spans join one distributed
   *  trace instead of starting a detached second one. */
  traceId?: string
  /** Where the child reports its result, and the event type it reports under. */
  parent: CalleeParent
  eventType: string
}

/**
 * Create the callee's run row and start it on its own engine.
 *
 * Callers must treat this as a single atomic effect: the durable backend runs
 * it inside ONE journaled `step.do` so a replay reuses the run and the instance
 * rather than minting a second of each. `crypto.randomUUID()` is used here for
 * the room address for exactly that reason — it is only ever called from inside
 * such a step, or from the inline backend, which never replays.
 */
export async function spawnCalleeRun(
  env: ChildRunBindings,
  db: WfDb,
  args: SpawnCalleeRunArgs,
): Promise<SpawnedChildRun> {
  const { entry, runContext } = args
  const childRunId = await createRun(db, {
    workflowVersionId: entry.versionId,
    triggerKind: runContext.triggerKind,
    subjectId: runContext.subjectId,
    correlationId: runContext.correlationId,
    // The callee acts for the same principal as its caller — carried onto the
    // child row so a failure inside a spawned sub-run is attributable without
    // walking back to the parent.
    actorId: runContext.actorId,
    // An eval's callees are eval runs too. Without this the child lands in
    // every dashboard query (they all filter `is_eval = false`) while its
    // parent is excluded, and the two can never be reconciled.
    isEval: runContext.isEval,
    sentryTraceId: args.traceId,
    // The nesting link the run viewer reads to show this callee UNDER its
    // caller. A workflow-call node spawns exactly one callee, so it takes the
    // top-level item sentinel; durable iteration items pass a real 0-based
    // index instead.
    parent: { runId: args.parentRunId, nodeId: args.nodeId },
  })

  const roomId = crypto.randomUUID()
  const params: GraphWorkflowParams = {
    runId: roomId,
    workflowRunId: childRunId,
    workflowVersionId: entry.versionId,
    triggerInput: args.triggerInput,
    runContext,
    inheritedManifest: args.manifest,
    subRun: { parent: args.parent, eventType: args.eventType },
  }

  const engine = resolveGraphEngine(entry.graph)
  if (engine === 'inline') {
    // The room IS the execution host on this engine (see `makeRunRoom`). The
    // call returns as soon as the walk is handed off, exactly as
    // `WORKFLOW.create()` does — both are "the run is accepted", not "the run
    // is finished".
    const room = env.RUN_ROOM.get(env.RUN_ROOM.idFromName(roomId))
    await room.startInline(params)
    return { childRunId, engine, instanceId: null }
  }
  const instance = await env.GRAPH_WORKFLOW.create({ params })
  return { childRunId, engine, instanceId: instance.id }
}

/**
 * Tell a waiting parent that a spawned run settled — the other half of
 * {@link spawnCalleeRun}, and the only thing that ever wakes a caller.
 *
 * Transport is chosen by what the parent IS, not by what the child is: a
 * durable parent is parked on `waitForEvent` and takes an event; an inline
 * parent is a promise inside its RunRoom and takes an RPC. A child never knows
 * or cares which — that symmetry is what lets either engine call either engine.
 *
 * Throws on failure. Callers decide what that means: the durable backend runs
 * this inside its own retried step (the parent is parked indefinitely and this
 * is the only thing that will wake it), while the inline backend logs and lets
 * the parent's own wait time out.
 */
export async function reportCalleeResult(
  env: ChildRunBindings,
  sub: { parent: CalleeParent; eventType: string },
  payload: CalleeDoneEvent,
): Promise<void> {
  const wire = toCalleeWire(payload)
  if (sub.parent.kind === 'room') {
    const room = env.RUN_ROOM.get(env.RUN_ROOM.idFromName(sub.parent.roomId))
    await room.deliverCallee(sub.eventType, wire)
    return
  }
  // Check the type before sending. An invalid one is rejected by the platform
  // and retried on the standard backoff for hours, while the parent shows only
  // a generic timeout — so this is the one place that can name the real cause.
  assertValidEventType(sub.eventType, 'Reporting to parent workflow')
  const parent = await env.GRAPH_WORKFLOW.get(sub.parent.instanceId)
  await parent.sendEvent({ type: sub.eventType, payload: wire })
}
