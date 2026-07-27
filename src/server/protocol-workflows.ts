import type { WorkflowGraph } from '../engine/graph'

export type WfWorkflowSummary = {
  id: string
  name: string
  description: string | null
  createdAt: number
  /** Retired workflows: hidden from the list and never triggered by their event. */
  archived: boolean
}

/**
 * A workflow row in the Workflows list — its summary plus the activity metrics
 * the list renders (version, last edit, run activity). All epoch ms / counts.
 */
export type WfWorkflowListItem = WfWorkflowSummary & {
  /** Highest published version number (a workflow always seeds v1). */
  latestVersionNumber: number | null
  /** Freshest of workflow/version/draft edits — "last updated". */
  updatedAt: number | null
  /** Newest non-eval run's start; null if the workflow has never run. */
  lastRunAt: number | null
  /** Total non-eval runs. */
  runCount: number
}

export type WfWorkflowDetail = {
  workflow: WfWorkflowSummary
  draft: { graph: WorkflowGraph } | null
  currentVersion: {
    id: string
    versionNumber: number
    graph: WorkflowGraph
  } | null
}

// A git-style change summary: a one-line subject (`short`) and an optional
// longer body (`long`). Produced by the AI summarizer (or a heuristic fallback).
export type WfChangeSummary = {
  short: string
  long: string
}

export type WfVersionSummary = {
  id: string
  versionNumber: number
  /** The human's own note about the change (may be empty). */
  changeNote: string | null
  /** The AI's git-style summary — null until generated. */
  aiSummaryShort: string | null
  aiSummaryLong: string | null
  createdAt: number
  publishedAt: number | null
}
