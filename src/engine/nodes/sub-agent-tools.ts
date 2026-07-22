import { z } from 'zod'

import type { SubAgentTarget } from '../graph'

// Pure synthesis of a delegating agent's tool surface: names, input schemas, and
// descriptions derived from the whitelist of sub-agents/workflows. Kept free of
// engine/DB/AI-SDK coupling so BOTH the runtime (which wraps these in live
// `tool()`s with execute closures) and the editor's live preview import the same
// helpers — the documented shape and the enforced shape can never drift.

/** The shared join tool every delegating agent gets. */
export const AWAIT_TOOL_NAME = 'await_subagents'
/** The optional non-blocking status tool. */
export const CHECK_TOOL_NAME = 'check_subagents'
/** The stop tool injected into SUB-agents (never the primary). */
export const SIGNAL_STOP_TOOL_NAME = 'signal_stop'

/** A target resolved to the display info needed to name & document its tool. */
export type SynthesizedTarget = {
  target: SubAgentTarget
  /** The synthesized tool key (e.g. `spawn_legal_research`). */
  toolName: string
  /** The target's display name, used in the description. */
  displayName: string
  /** The target's one-line description, when known. */
  description?: string
  /** Agent targets: the `${var}` names in the target's prompt. */
  promptVariables?: string[]
}

/** The display info a caller supplies per target (from manifest or UI summary). */
export type TargetDisplay = {
  displayName: string
  description?: string
  promptVariables?: string[]
}

// Lowercase, non-alphanumeric → `_`, collapse repeats, trim — turns a display
// name into a valid tool-key suffix.
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/_+/g, '_')
    .replaceAll(/^_|_$/g, '')
  return slug || 'target'
}

// Base tool name: the author override verbatim, else `spawn_<slug(name)>`.
function baseToolName(target: SubAgentTarget, displayName: string): string {
  return target.toolName ?? `spawn_${slugify(displayName)}`
}

/**
 * Resolve the whitelist into synthesized target infos with COLLISION-FREE tool
 * names (a duplicate base gets a numeric suffix), deterministic in list order.
 * `display(target, i)` yields each target's name/description/prompt-vars.
 */
export function synthesizeTargets(
  targets: SubAgentTarget[],
  display: (target: SubAgentTarget, index: number) => TargetDisplay,
): SynthesizedTarget[] {
  const used = new Set<string>()
  return targets.map((target, i) => {
    const d = display(target, i)
    let name = baseToolName(target, d.displayName)
    if (used.has(name)) {
      let n = 2
      while (used.has(`${name}_${n}`)) n++
      name = `${name}_${n}`
    }
    used.add(name)
    return {
      target,
      toolName: name,
      displayName: d.displayName,
      description: d.description,
      promptVariables: target.kind === 'agent' ? (d.promptVariables ?? []) : undefined,
    }
  })
}

/**
 * Input schema for one `spawn_*` tool. Agent targets take a `message` plus one
 * optional string per prompt variable; workflow targets take a free-form
 * `input` (mirroring how a workflow node passes its callee's trigger input).
 */
export function spawnInputSchema(info: SynthesizedTarget): z.ZodType {
  if (info.target.kind === 'workflow') {
    return z.object({
      input: z
        .unknown()
        .describe(
          'Starting input for the workflow (its trigger payload). An object or string describing the task.',
        ),
    })
  }
  const shape: Record<string, z.ZodType> = {
    message: z
      .string()
      .describe('The task / question to hand the sub-agent to work on.'),
  }
  for (const v of info.promptVariables ?? []) {
    shape[v] = z
      .string()
      .optional()
      .describe(`Value for the sub-agent's \${${v}} prompt variable.`)
  }
  return z.object(shape)
}

/** The human/LLM-facing description for one `spawn_*` tool. */
export function spawnDescription(info: SynthesizedTarget): string {
  const kind = info.target.kind === 'workflow' ? 'workflow' : 'agent'
  const label = info.target.label ?? info.displayName
  const what = info.description ? ` ${info.description}` : ''
  return (
    `Delegate to the "${label}" ${kind}.${what} ` +
    `Runs it in the background and returns immediately with a { spawnId } handle — ` +
    `it does NOT block, so you can keep working and spawn more. ` +
    `Call ${AWAIT_TOOL_NAME} to collect the results before you rely on them.`
  )
}

export function awaitInputSchema(): z.ZodType {
  return z.object({
    spawnIds: z
      .array(z.string())
      .optional()
      .describe(
        'Which spawn handles to wait for. Omit to wait for ALL sub-agents launched so far.',
      ),
  })
}

export function awaitDescription(): string {
  return (
    `Wait for previously spawned sub-agents to finish and return their results. ` +
    `Returns as soon as a sub-agent signals it found something important that ` +
    `should stop the work (the rest are reported as still running), otherwise ` +
    `once all requested sub-agents complete.`
  )
}

export function checkInputSchema(): z.ZodType {
  return z.object({})
}

export function checkDescription(): string {
  return (
    `Non-blocking status of every sub-agent spawned so far (running / completed / ` +
    `failed, and whether any raised a stop signal). Use it to decide whether to ` +
    `spawn more or ${AWAIT_TOOL_NAME}.`
  )
}

export function signalStopInputSchema(): z.ZodType {
  return z.object({
    reason: z
      .string()
      .describe('Why the calling work should stop — the important finding.'),
  })
}

export function signalStopDescription(): string {
  return (
    `Signal that you have found something important enough that the agent which ` +
    `delegated to you should STOP waiting on other sub-agents and act on this now. ` +
    `Call this only for a genuinely decisive finding, then give your final answer.`
  )
}

/**
 * Editor preview: the tool name + description the engine will synthesize for the
 * current whitelist, so the author sees exactly what the model will be offered.
 */
export function previewSpawnTools(
  targets: SubAgentTarget[],
  display: (target: SubAgentTarget, index: number) => TargetDisplay,
): Array<{ toolName: string; description: string }> {
  return synthesizeTargets(targets, display).map((info) => ({
    toolName: info.toolName,
    description: spawnDescription(info),
  }))
}
