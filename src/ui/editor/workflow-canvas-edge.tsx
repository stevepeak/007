import {
  BaseEdge,
  getSmoothStepPath,
  useNodesData,
  type EdgeProps,
} from '@xyflow/react'

import { switchArmName } from '../../engine'

import type { EditorNode } from './workflow-canvas-graph'

// The one edge renderer the canvas uses, and it exists for a single reason: a
// conditional edge's label is not a property OF the edge, it's a property of the
// arm the edge leaves from. A Switch arm's name lives on the source node's case
// row, so the label has to be read at render time — baking it into the edge when
// the graph loads would leave every edge showing the old name until the whole
// canvas re-seeded, which only happens on publish or discard.
//
// Everything else is React Flow's stock smoothstep edge, label included, so a
// named edge looks exactly like the lettered one it replaces.
export const CONDITION_EDGE_TYPE = 'condition'

export function ConditionEdge({
  id,
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const sourceNode = useNodesData<EditorNode>(source)
  const condition = typeof data?.condition === 'string' ? data.condition : null
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={conditionLabel(sourceNode?.data, condition)}
      labelX={labelX}
      labelY={labelY}
    />
  )
}

// What the edge reads as: a Switch arm's author-given name when it has one,
// otherwise the raw condition ('A', 'else', 'yes', 'no'). An unconditional edge
// gets no label at all — BaseEdge skips an empty one.
function conditionLabel(
  sourceData: EditorNode['data'] | undefined,
  condition: string | null,
): string | undefined {
  if (!condition) return undefined
  if (sourceData?.kind !== 'switch') return condition
  return switchArmName(sourceData.config.cases, condition)
}
