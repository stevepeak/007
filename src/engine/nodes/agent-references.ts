import type { AgentConfig } from '../graph'
import {
  checkReferences,
  referencePromptBlock,
  type ReferenceKind,
} from '../references'
import type { StreamSink } from '../stream-sink'

import type { AgentNodeResult } from './agent-generation-types'

// Inline references for one generation, shared by the agent node and a spawned
// sub-agent so the two can't diverge: resolve the agent's opted-in kinds against
// the host catalog, teach them in the system prompt, then check what came back.

/**
 * The catalog entries an agent opted into, in its order. Empty unless the agent
 * produces text — a reference is a link inside prose, and an object/boolean
 * agent has none to write. An id the catalog doesn't declare is an author error
 * surfaced loudly, exactly like an unregistered tool id.
 */
export function enabledReferenceKinds(
  config: Pick<AgentConfig, 'referenceKinds' | 'output'>,
  catalog: readonly ReferenceKind[],
  who: string,
): ReferenceKind[] {
  if (config.output.kind !== 'text') return []
  return (config.referenceKinds ?? []).map((id) => {
    const kind = catalog.find((k) => k.id === id)
    if (!kind) {
      throw new Error(
        `${who}: reference kind '${id}' is not declared in the host's referenceKinds.`,
      )
    }
    return kind
  })
}

/** The author's system prompt with the reference section appended. */
export function withReferencePrompt(
  systemPrompt: string,
  kinds: readonly ReferenceKind[],
): string {
  const block = referencePromptBlock(kinds)
  return block ? `${systemPrompt}\n\n${block}` : systemPrompt
}

function evidenceText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * Check every reference in a text result against what this generation SAW, and
 * return it as `{ text, references }`.
 *
 * Evidence is the author's interpolated system prompt (which is how an upstream
 * agent's output — references and all — reaches a downstream one), the messages
 * sent (a conversation carries earlier turns' references), and every tool
 * result, including a sub-agent's via `await_subagents`. NOT the reference
 * section of the prompt: its worked examples would otherwise validate
 * themselves. `authorPrompt` must therefore be the prompt BEFORE
 * {@link withReferencePrompt}.
 *
 * A reference that fails is unwrapped to its label and logged as a warning —
 * the answer stands, minus a chip that would have pointed nowhere.
 */
export async function finalizeReferences(args: {
  result: AgentNodeResult
  kinds: readonly ReferenceKind[]
  authorPrompt: string
  sink?: StreamSink
}): Promise<AgentNodeResult> {
  const { result, kinds } = args
  if (kinds.length === 0) return result
  const output = result.output as { text?: unknown }
  if (typeof output.text !== 'string') return result

  const evidence = [
    args.authorPrompt,
    ...(result.meta.messages ?? []).map((m) => m.text),
    ...result.meta.steps.flatMap((s) => {
      return s.toolCalls.map((c) => evidenceText(c.output))
    }),
  ].join('\n')
  const checked = checkReferences({ text: output.text, kinds, evidence })

  const removed = checked.issues.filter(
    (i) => i.problem === 'unsourced' || i.problem === 'unknown-kind',
  )
  if (removed.length > 0) {
    await args.sink?.log?.({
      level: 'warn',
      message: `Removed ${removed.length} reference${removed.length === 1 ? '' : 's'} the agent did not source: ${removed
        .map((i) => `${i.kind}/${i.id}`)
        .join(', ')}`,
      meta: { issues: checked.issues },
    })
  }

  return {
    ...result,
    output: { ...output, text: checked.text, references: checked.references },
    meta: {
      ...result.meta,
      references: {
        kept: checked.references.length,
        issues: checked.issues,
      },
    },
  }
}
