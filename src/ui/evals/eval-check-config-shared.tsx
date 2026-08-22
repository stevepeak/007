import {
  ArrowRightToLine,
  Braces,
  type LucideIcon,
  Text,
  Waypoints,
  Wrench,
} from 'lucide-react'

import { BINARY_CHECK_TYPES, type EvalCheck } from '../../server/protocol'

import { CHECK_TYPE_LABELS } from './check-naming'

export type CheckFamily = 'binary' | 'scored'

// The deterministic (non-judge) check type ids, derived from the check schema in
// `checks.ts` so a new binary check kind surfaces in this picker automatically.
export const BINARY_TYPES = BINARY_CHECK_TYPES
export type BinaryType = (typeof BINARY_TYPES)[number]

// Blurb and icon for each binary assertion — drives the picker so authors never
// see the raw `snake_case` type ids. The label comes from `CHECK_TYPE_LABELS`,
// which is also what a collapsed check falls back to, so the picker and the
// checklist can't name the same type two different things.
export const BINARY_TYPE_META: Record<
  BinaryType,
  { label: string; desc: string; icon: LucideIcon }
> = {
  tool_called: {
    label: CHECK_TYPE_LABELS.tool_called,
    desc: 'A specific tool was (or wasn’t) called',
    icon: Wrench,
  },
  tool_args_match: {
    label: CHECK_TYPE_LABELS.tool_args_match,
    desc: 'A called tool’s arguments match a value',
    icon: Braces,
  },
  node_visited: {
    label: CHECK_TYPE_LABELS.node_visited,
    desc: 'A workflow node was (or wasn’t) reached',
    icon: Waypoints,
  },
  node_input_match: {
    label: CHECK_TYPE_LABELS.node_input_match,
    desc: 'A node’s input matches a value',
    icon: ArrowRightToLine,
  },
  output_match: {
    label: CHECK_TYPE_LABELS.output_match,
    desc: 'The final output matches a value',
    icon: Text,
  },
}

export function familyOf(check: EvalCheck): CheckFamily {
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
      return { type, rubric: '' }
  }
}
