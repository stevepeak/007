export {
  checkResultSchema,
  checkTreeSchema,
  evalCheckSchema,
  evalFixturesSchema,
  evalInitialConditionSchema,
  evalMatchSchema,
  isJudgeCheck,
  type CheckResult,
  type CheckTree,
  type EvalCheck,
  type EvalFixtures,
  type EvalInitialCondition,
  type EvalMatch,
} from './checks'

import type { RunContext, WfSdkConfig } from '../engine/config'
import { executeWorkflow } from '../engine/executor'
import type { WfRunManifestEntry } from '../engine/graph'
import {
  createMemoryRunRecorder,
  type RecordStepArgs,
} from '../engine/run-recorder'
import { Scheduler } from '../engine/scheduler'
import { createMemorySink, type StreamSink } from '../engine/stream-sink'

// Eval / testing seam (WS-F). Runs a graph through the in-process executor with
// a host-supplied config — typically one whose `getModel` returns a mock model
// and whose `toolRegistry` returns canned tools — and an in-memory recorder, so
// a test can assert on the full step trace and final output with no database or
// Cloudflare runtime.
//
// This is the designed interface; richer assertion helpers and fixtures land in
// a later phase.

export type WorkflowTestCase<TDeps> = {
  name: string
  /** Raw graph JSON (validated by the executor). */
  graph: unknown
  triggerInput: unknown
  /** Host config — point `getModel`/`toolRegistry` at mocks for deterministic runs. */
  config: WfSdkConfig<TDeps>
  /** Partial run context; subject/correlation default to eval placeholders. */
  runContext?: Partial<Omit<RunContext, 'triggerKind'>>
  /** Frozen run manifest — resolves agent nodes' `agentId` to their config. */
  manifest?: WfRunManifestEntry[]
}

export type WorkflowTestRun = {
  output: unknown
  outputNodeId: string
  steps: RecordStepArgs[]
  progress: { channel: string; text: string }[]
}

function triggerKindOf(graph: unknown): string {
  // Cheap re-parse to read the declared trigger kind for the run context.
  return new Scheduler(graph).trigger.config.triggerKind
}

export async function runWorkflowUnderConditions<TDeps>(
  tc: WorkflowTestCase<TDeps>,
): Promise<WorkflowTestRun> {
  const recorder = createMemoryRunRecorder()
  const sink: StreamSink & { events: { channel: string; text: string }[] } =
    createMemorySink()

  const runContext: RunContext = {
    subjectId: tc.runContext?.subjectId,
    correlationId: tc.runContext?.correlationId,
    triggerKind: triggerKindOf(tc.graph),
    promptVariables: tc.runContext?.promptVariables,
    manifest: tc.manifest ?? tc.runContext?.manifest,
    simulate: tc.runContext?.simulate,
    fixtures: tc.runContext?.fixtures,
    env: tc.runContext?.env,
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
    progress: sink.events,
  }
}
