import { z } from 'zod'

import type { JsonSchema } from './agent-output'

// How a workflow gets started. Three modes, two of which are SDK built-ins and
// one host-declared:
//
//   • 'manual'   — a person starts the run by hand. No event payload.
//   • 'periodic' — a cron schedule starts the run. No event payload; the
//                  schedule lives on the trigger node's `config.cron`.
//   • event      — a host-declared system event. The kind is the registry key
//                  (e.g. 'chat_message') and the event's data is described by
//                  its `inputSchema`.
//
// Manual/periodic are available to every host regardless of its registry; only
// events come from `WfSdkConfig.triggers`. The engine validates a run's
// `triggerInput` against the matching event's `inputSchema` before any node
// fires (manual/periodic pass their input through untouched).

export const MANUAL_TRIGGER_KIND = 'manual'
export const PERIODIC_TRIGGER_KIND = 'periodic'
// The item source of an iteration node's subgraph. The subgraph runs once per
// list element; its trigger's output IS the current item (identity pass-through).
// Reserved so the editor's event catalog never offers it as a startable trigger.
export const ITERATION_ITEM_TRIGGER_KIND = 'iteration_item'

/** The built-in kinds every workflow can use without a host registry entry. */
export const RESERVED_TRIGGER_KINDS = [
  MANUAL_TRIGGER_KIND,
  PERIODIC_TRIGGER_KIND,
  ITERATION_ITEM_TRIGGER_KIND,
] as const

export type TriggerMode = 'manual' | 'periodic' | 'event' | 'iteration_item'

/** Classify a trigger kind into its mode (events are anything non-reserved). */
export function triggerModeOf(triggerKind: string): TriggerMode {
  if (triggerKind === MANUAL_TRIGGER_KIND) return 'manual'
  if (triggerKind === PERIODIC_TRIGGER_KIND) return 'periodic'
  if (triggerKind === ITERATION_ITEM_TRIGGER_KIND) return 'iteration_item'
  return 'event'
}

// The host's **event** catalog — the single place new system events are
// described so the engine, editor, and creation flow all see them. The SDK
// ships the *type* and helpers; the host supplies the concrete registry via
// `WfSdkConfig.triggers`.
//
// Each entry carries:
//   - `description`: human label for the editor / creation dropdown
//   - `inputSchema`: Zod for the data the call site passes as triggerInput
//   - `outputContractSchema` (optional): Zod the final workflow output satisfies

export type TriggerEntry = {
  description: string
  inputSchema: z.ZodType
  outputContractSchema?: z.ZodType
}

export type TriggerRegistry = Record<string, TriggerEntry>

export function getTriggerEntry(
  triggers: TriggerRegistry,
  kind: string,
): TriggerEntry | undefined {
  return triggers[kind]
}

/**
 * Validate/normalize a run's `triggerInput` for the given trigger kind:
 *   • event    → parsed against the registered event's `inputSchema` (throws if
 *                the kind isn't registered).
 *   • manual   → passed through as-is (a human may supply arbitrary input).
 *   • periodic → coerced to `{}` (a scheduled tick carries no payload).
 */
export function resolveTriggerInput(
  triggers: TriggerRegistry,
  triggerKind: string,
  input: unknown,
): unknown {
  switch (triggerModeOf(triggerKind)) {
    case 'event': {
      const entry = triggers[triggerKind]
      if (!entry) {
        throw new Error(`Trigger event '${triggerKind}' is not registered.`)
      }
      return entry.inputSchema.parse(input)
    }
    case 'manual':
      return input ?? {}
    case 'periodic':
      return {}
    case 'iteration_item':
      // The current list element, passed straight through by the iteration
      // driver. No schema to validate against — it's whatever the list holds.
      return input
  }
}

// --- Serializable event catalog for the UI --------------------------------
// The creation flow ("trigger by event") needs to show which events exist and
// what data each provides. Zod schemas can't cross the RPC wire, so the server
// flattens each event's top-level object shape into these plain DTOs.

export type TriggerEventField = {
  name: string
  /** Coarse type label ('string', 'number', 'array', 'object', …). */
  type: string
  optional: boolean
}

export type TriggerEventOption = {
  kind: string
  description: string
  fields: TriggerEventField[]
  /**
   * The event payload as JSON Schema — the shape a trigger node makes available
   * to downstream nodes for data mapping. Absent when the schema can't be
   * represented as JSON Schema.
   */
  inputSchema?: JsonSchema
}

// Best-effort reflection of a Zod v4 schema's coarse type, unwrapping the
// optional/nullable/default wrappers to reach the meaningful inner type.
function coarseType(schema: unknown): string {
  let node = schema as { _def?: { type?: string; innerType?: unknown } }
  const wrappers = new Set(['optional', 'nullable', 'default'])
  // Guard against a malformed cycle; a handful of unwraps is always enough.
  for (
    let i = 0;
    i < 8 && node?._def && wrappers.has(node._def.type ?? '');
    i++
  ) {
    node = node._def.innerType as typeof node
  }
  return node?._def?.type ?? 'unknown'
}

// Flatten a single event's `inputSchema` (expected to be a top-level object)
// into a field list. Non-object schemas yield an empty list — the UI then just
// shows the description without a data table.
function reflectFields(schema: z.ZodType): TriggerEventField[] {
  const def = (schema as { _def?: { type?: string } })._def
  if (def?.type !== 'object') return []
  const raw = (schema as { shape?: unknown }).shape
  const shape =
    typeof raw === 'function'
      ? (raw as () => Record<string, z.ZodType>)()
      : (raw as Record<string, z.ZodType> | undefined)
  if (!shape) return []
  return Object.entries(shape).map(([name, field]) => ({
    name,
    type: coarseType(field),
    optional:
      typeof (field as { isOptional?: () => boolean }).isOptional === 'function'
        ? (field as { isOptional: () => boolean }).isOptional()
        : false,
  }))
}

// Convert an event's Zod input schema to JSON Schema for the data-mapping tree.
// Best-effort: an unrepresentable schema simply omits the shape.
function eventInputSchema(schema: z.ZodType): JsonSchema | undefined {
  try {
    return z.toJSONSchema(schema)
  } catch {
    return undefined
  }
}

/** Describe every host event as a wire-safe option for the creation flow. */
export function describeTriggerEvents(
  triggers: TriggerRegistry,
): TriggerEventOption[] {
  return Object.entries(triggers).map(([kind, entry]) => ({
    kind,
    description: entry.description,
    fields: reflectFields(entry.inputSchema),
    inputSchema: eventInputSchema(entry.inputSchema),
  }))
}
