import { type WorkflowNode } from '../../engine'
import {
  AggregateNodeRenderer,
  AgentNodeRenderer,
  BranchNodeRenderer,
  FeatureRequestNodeRenderer,
  IterationNodeRenderer,
  NoteNodeRenderer,
  OutputNodeRenderer,
  RaceNodeRenderer,
  SwitchNodeRenderer,
  ToolNodeRenderer,
  TriggerNodeRenderer,
  WorkflowNodeRenderer,
} from './node-renderers-nodes'

// Shared editor primitives + contexts live in node-renderers-shared; re-export
// the public ones so hosts keep importing them from `./node-renderers`.
export {
  InvalidNodesProvider,
  RunStatusProvider,
  type EditorNodeData,
} from './node-renderers-shared'

// The `wf-` prefix keeps our custom node classNames outside xyflow's built-in
// selectors (`.react-flow__node-output` etc.), which would otherwise layer a
// 150px bordered box on top of our renderer.
const EDITOR_NODE_TYPE_PREFIX = 'wf-'

export function editorTypeForKind(kind: WorkflowNode['kind']): string {
  return `${EDITOR_NODE_TYPE_PREFIX}${kind}`
}

export const NODE_TYPES = {
  [editorTypeForKind('trigger')]: TriggerNodeRenderer,
  [editorTypeForKind('agent')]: AgentNodeRenderer,
  [editorTypeForKind('tool')]: ToolNodeRenderer,
  [editorTypeForKind('branch')]: BranchNodeRenderer,
  [editorTypeForKind('switch')]: SwitchNodeRenderer,
  [editorTypeForKind('iteration')]: IterationNodeRenderer,
  [editorTypeForKind('workflow')]: WorkflowNodeRenderer,
  [editorTypeForKind('feature-request')]: FeatureRequestNodeRenderer,
  [editorTypeForKind('race')]: RaceNodeRenderer,
  [editorTypeForKind('aggregate')]: AggregateNodeRenderer,
  [editorTypeForKind('note')]: NoteNodeRenderer,
  [editorTypeForKind('output')]: OutputNodeRenderer,
}
