import type { WfEvalResultDTO } from '../../../server/protocol'
import { cn } from '../../cn'
import { formatTokens, formatUsd } from '../../cost'
import { useModels } from '../../hooks'
import { PassRate, Score } from '../shared'

import { Section } from './atoms'
import { mean } from './model'

// The matrix roll-up: collapses every test back into one row per {model × prompt}
// cell and reads off which cell wins on accuracy, cost, and speed. Only rendered
// for a matrix run (a plain run leaves the cell fields null → nothing to
// compare). Speed is the model's catalog tok/s; cost/tokens come live from each
// result's `runStats`.

type MatrixCell = {
  modelId: string | null
  promptLabel: string | null
  total: number
  passed: number
  meanScore: number | null
  avgCostUsd: number | null
  avgTokens: number | null
  tokensPerSec: number | null
}

function cellKey(modelId: string | null, promptLabel: string | null): string {
  return `${modelId ?? ''} ${promptLabel ?? ''}`
}

export function MatrixSummary({ results }: { results: WfEvalResultDTO[] }) {
  const models = useModels()
  const isMatrix = results.some((r) => r.modelId != null || r.promptLabel != null)
  if (!isMatrix) return null

  const modelById = new Map((models.data ?? []).map((m) => [m.id, m]))
  const groups = new Map<string, WfEvalResultDTO[]>()
  for (const r of results) {
    const key = cellKey(r.modelId, r.promptLabel)
    const bucket = groups.get(key)
    if (bucket) bucket.push(r)
    else groups.set(key, [r])
  }

  const cells: MatrixCell[] = [...groups.values()].map((rs) => {
    const scores = rs.map((r) => r.score).filter((v): v is number => v != null)
    const costs = rs
      .map((r) => r.runStats?.costUsd)
      .filter((v): v is number => v != null)
    const tokens = rs
      .map((r) => r.runStats?.totalTokens)
      .filter((v): v is number => v != null)
    const model = rs[0]?.modelId ? modelById.get(rs[0].modelId) : undefined
    const avgTokens = mean(tokens)
    return {
      modelId: rs[0]?.modelId ?? null,
      promptLabel: rs[0]?.promptLabel ?? null,
      total: rs.length,
      passed: rs.filter((r) => r.status === 'pass').length,
      meanScore: mean(scores),
      avgCostUsd: mean(costs),
      avgTokens: avgTokens != null ? Math.round(avgTokens) : null,
      tokensPerSec: model?.tokensPerSec ?? null,
    }
  })

  // Per-column winners — most accurate (pass rate, ties broken by score),
  // cheapest, fastest. A column with no comparable data highlights nothing.
  const best = <T,>(
    pick: (c: MatrixCell) => T | null,
    better: (a: T, b: T) => boolean,
  ) => {
    let win: MatrixCell | null = null
    let winVal: T | null = null
    for (const c of cells) {
      const v = pick(c)
      if (v == null) continue
      if (winVal == null || better(v, winVal)) {
        win = c
        winVal = v
      }
    }
    return win ? cellKey(win.modelId, win.promptLabel) : null
  }
  const bestAcc = best(
    (c) => (c.total ? (c.passed / c.total) * 1000 + (c.meanScore ?? 0) : null),
    (a, b) => a > b,
  )
  const cheapest = best((c) => c.avgCostUsd, (a, b) => a < b)
  const fastest = best((c) => c.tokensPerSec, (a, b) => a > b)

  const modelLabel = (id: string | null) =>
    id ? (modelById.get(id)?.label ?? id) : 'Saved model'
  const winCls = 'font-semibold text-emerald-700'

  return (
    <Section
      title="Matrix summary"
      subtitle={`${cells.length} cell${cells.length === 1 ? '' : 's'} · best per column highlighted`}
    >
      <div className="overflow-x-auto px-4 py-3">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-[11px] uppercase tracking-wide text-neutral-400">
              <th className="py-1.5 pr-3 font-medium">Model</th>
              <th className="py-1.5 pr-3 font-medium">Prompt</th>
              <th className="py-1.5 pr-3 font-medium">Accuracy</th>
              <th className="py-1.5 pr-3 font-medium">Score</th>
              <th className="py-1.5 pr-3 text-right font-medium">Cost / run</th>
              <th className="py-1.5 pr-3 text-right font-medium">Tokens</th>
              <th className="py-1.5 text-right font-medium">Speed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {cells.map((c) => {
              const key = cellKey(c.modelId, c.promptLabel)
              return (
                <tr key={key} className="text-neutral-700">
                  <td className="py-1.5 pr-3 font-medium text-neutral-800">
                    {modelLabel(c.modelId)}
                  </td>
                  <td className="py-1.5 pr-3 text-neutral-500">
                    {c.promptLabel ?? 'Saved prompt'}
                  </td>
                  <td className={cn('py-1.5 pr-3 tabular-nums', bestAcc === key && winCls)}>
                    <PassRate passed={c.passed} total={c.total} />
                  </td>
                  <td className={cn('py-1.5 pr-3 tabular-nums', bestAcc === key && winCls)}>
                    <Score value={c.meanScore} />
                  </td>
                  <td className={cn('py-1.5 pr-3 text-right tabular-nums', cheapest === key && winCls)}>
                    {formatUsd(c.avgCostUsd)}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-neutral-500">
                    {c.avgTokens != null ? formatTokens(c.avgTokens) : '—'}
                  </td>
                  <td className={cn('py-1.5 text-right tabular-nums', fastest === key && winCls)}>
                    {c.tokensPerSec != null ? `${c.tokensPerSec} tok/s` : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Section>
  )
}
