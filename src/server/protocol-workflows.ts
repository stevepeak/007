import type { WorkflowGraph } from '../engine/graph'

export type WfWorkflowSummary = {
  id: string
  name: string
  description: string | null
  createdAt: number
  /** Retired workflows: hidden from the list and never triggered by their event. */
  archived: boolean
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
