import type { WfNodeKind } from './graph'

// The recorder is the engine's only persistence seam. The engine calls
// `record` once per node (after it completes or fails); implementations decide
// where the row lands. The durable D1 implementation lives in
// `../storage/run-recorder.ts`; an in-memory one ships here for eval/tests.
//
// `sequence` is supplied by the caller (the deterministic walk order), not
// allocated by the recorder — this is what lets a durable backend survive
// `step.do` retries / hibernation without an in-memory counter, and lets the
// row upsert idempotently on `(run_id, node_id)`.

export type WfRunStepStatus = 'running' | 'completed' | 'failed' | 'skipped'

export type RecordStepArgs = {
  nodeId: string
  nodeKind: WfNodeKind
  sequence: number
  input: unknown
  status: WfRunStepStatus
  output?: unknown
  meta?: unknown
  branchResult?: { result: 'yes' | 'no'; reasoning: string } | null
  error?: string
  startedAt?: Date
  finishedAt?: Date
}

export interface RunRecorder {
  record(args: RecordStepArgs): Promise<void>
}

/**
 * In-memory recorder for eval / tests. Captures every recorded step in order
 * so assertions can inspect the run trace without a database.
 */
export function createMemoryRunRecorder(): RunRecorder & {
  steps: RecordStepArgs[]
} {
  const steps: RecordStepArgs[] = []
  return {
    steps,
    record(args) {
      steps.push(args)
      return Promise.resolve()
    },
  }
}
