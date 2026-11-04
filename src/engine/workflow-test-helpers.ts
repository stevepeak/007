import type { RunContext, WfSdkConfig } from './config'
import { executeWorkflow } from './executor'
import type { WfRunManifestEntry } from './graph'
import {
  createMemoryRunRecorder,
  type RecordStepArgs,
} from './run-recorder'
import { Scheduler } from './scheduler'
import {
  createMemorySink,
  type RunLogEntry,
  type StreamSink,
} from './stream-sink'

// Engine test helper. Runs a graph through the in-process executor with
// a host-supplied config — typically one whose `getModel` returns a mock model
// and whose `toolRegistry` returns canned tools — and an in-memory recorder, so
// a test can assert on the full step trace and final output with no database or
// Cloudflare runtime.
//
export type WorkflowTestCase<TDeps> = {
  name: string
  /** Raw graph JSON (validated by the executor). */
  graph: unknown
  triggerInput: unknown
  /** Host config — point `getModel`/`toolRegistry` at mocks for deterministic runs. */
  config: WfSdkConfig<TDeps>
  /** Partial run context, passed through whole; `triggerKind` comes from the graph. */
  runContext?: Partial<Omit<RunContext, 'triggerKind'>>
  /** Frozen run manifest — resolves agent nodes' `agentId` to their config. */
  manifest?: WfRunManifestEntry[]
}

export type WorkflowTestRun = {
  output: unknown
  /** `null` when the run ended on a decision arm that fizzled out (no Output). */
  outputNodeId: string | null
  steps: RecordStepArgs[]
  /** Structured run-log entries — including the user-facing `progress` level. */
  logs: RunLogEntry[]
}

function triggerKindOf(graph: unknown): string {
  // Cheap re-parse to read the declared trigger kind for the run context.
  return new Scheduler(graph).trigger.config.triggerKind
}

export async function runWorkflowUnderConditions<TDeps>(
  tc: WorkflowTestCase<TDeps>,
): Promise<WorkflowTestRun> {
  const recorder = createMemoryRunRecorder()
  const sink: StreamSink & { logs: RunLogEntry[] } = createMemorySink()

  // Spread, not copied field by field: a RunContext field added later must
  // reach the run here too, or this entry point stops testing what runs.
  const runContext: RunContext = {
    ...tc.runContext,
    triggerKind: triggerKindOf(tc.graph),
    manifest: tc.manifest ?? tc.runContext?.manifest,
  }

  const result = await executeWorkflow({
    graph: tc.graph,
    triggerInput: tc.triggerInput,
    config: tc.config,
    runContext,
    recorder,
    sink,
  })

  return {
    output: result.output,
    outputNodeId: result.outputNodeId,
    steps: recorder.steps,
    logs: sink.logs,
  }
}
