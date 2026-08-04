// Narrow, LIGHT entrypoint for the run-progress interface — the component, the
// hook/provider, and the toast factory. Kept separate from the `./ui` barrel
// (which drags in the whole editor: react-flow, tiptap, dagre, autoform) so a
// host can consume progress in its app shell / chat / documents without
// compiling the entire SDK UI. Transitively imports only React, lucide, `cn`,
// and the injected-components context — nothing heavy.
export {
  WorkflowRunProgress,
  type WorkflowRunProgressProps,
  type RunSurfaceItem,
  type RunSurfaceStatus,
  type RunSurfaceFeedback,
} from './run-progress-view'
export {
  WorkflowProgressProvider,
  useRunProgress,
  createRunProgressToast,
  type RunProgressSnapshot,
  type RunProgressFetcher,
  type RunProgressToaster,
} from './run-progress-source'
