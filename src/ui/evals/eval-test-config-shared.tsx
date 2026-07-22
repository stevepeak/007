import {
  ArrowRightToLine,
  Braces,
  type LucideIcon,
  Text,
  Waypoints,
  Wrench,
} from 'lucide-react'

import { BINARY_CHECK_TYPES, type EvalCheck } from '../../server/protocol'

export type TestFamily = 'binary' | 'scored'

// The deterministic (non-judge) check type ids, derived from the check schema in
// `checks.ts` so a new binary check kind surfaces in this picker automatically.
export const BINARY_TYPES = BINARY_CHECK_TYPES
export type BinaryType = (typeof BINARY_TYPES)[number]

// Human-readable label, blurb, and icon for each binary assertion — drives the
// picker so authors never see the raw `snake_case` type ids.
export const BINARY_TYPE_META: Record<
  BinaryType,
  { label: string; desc: string; icon: LucideIcon }
> = {
  tool_called: {
    label: 'Tool called',
    desc: 'A specific tool was (or wasn’t) called',
    icon: Wrench,
  },
  tool_args_match: {
    label: 'Tool arguments',
    desc: 'A called tool’s arguments match a value',
    icon: Braces,
  },
  node_visited: {
    label: 'Node visited',
    desc: 'A workflow node was (or wasn’t) reached',
    icon: Waypoints,
  },
  node_input_match: {
    label: 'Node input',
    desc: 'A node’s input matches a value',
    icon: ArrowRightToLine,
  },
  output_match: {
    label: 'Output matches',
    desc: 'The final output matches a value',
    icon: Text,
  },
}

export function familyOf(check: EvalCheck): TestFamily {
  return check.type === 'llm_judge' ? 'scored' : 'binary'
}

export function defaultCheck(type: EvalCheck['type']): EvalCheck {
  switch (type) {
    case 'tool_called':
      return { type, toolId: '', called: true }
    case 'tool_args_match':
      return { type, toolId: '', match: 'contains', value: '' }
    case 'node_visited':
      return { type, nodeId: '', visited: true }
    case 'node_input_match':
      return { type, nodeId: '', match: 'contains', value: '' }
    case 'output_match':
      return { type, match: 'contains', value: '' }
    case 'llm_judge':
      // modelId is filled in by JudgeConfig once the model list loads.
      return { type, rubric: '', threshold: 0.7, weight: 1 }
  }
}

/** Carry the user-authored title/description across a type/family switch. */
export function withMeta(check: EvalCheck, from: EvalCheck | null): EvalCheck {
  return { ...check, label: from?.label, description: from?.description }
}
