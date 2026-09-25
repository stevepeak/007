// The matrix roll-up moved down to `eval/report.ts`, where `get_eval_run` can
// reach it too — the console and an MCP reader were otherwise going to disagree
// about which model won, because only one of them could do the arithmetic.
//
// This file stays as the UI's import site (the components and the fixture test
// both address it) and adds the one thing the grid needs and a tool call does
// not: `byKey`, for looking a cell up while rendering a row.

import {
  buildMatrixSummary as buildSummary,
  cellKey,
  type MatrixCell,
  type MatrixSummary,
} from '../../../eval/report'
import type { WfEvalResultDTO } from '../../../server/protocol'

export { isMatrixRun } from '../../../eval/report'
export type { MatrixCell }

export type MatrixSummaryModel = MatrixSummary & {
  /** Cell lookup for rendering, so hovering a summary card can light up rows. */
  byKey: Map<string, MatrixCell>
}

export function buildMatrixSummary(
  results: WfEvalResultDTO[],
): MatrixSummaryModel {
  const summary = buildSummary(results)
  return {
    ...summary,
    byKey: new Map(
      summary.cells.map((c) => [cellKey(c.modelId, c.promptLabel), c]),
    ),
  }
}
