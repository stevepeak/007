import type { ModelOption } from '../../engine/config'
import { BrandMark, inferModelBrand } from './shared'

// The confirmation screen: the model × prompt matrix laid out as a grid, the
// total test count, and a (blurred, not-yet-real) cost estimate. This is the
// deliberate "here's what you're about to spend" gate before launch.
export function ConfirmStep({
  selectedModels,
  counts,
  promptCount,
  totalTests,
  matrixBlocked,
  runError,
}: {
  selectedModels: ModelOption[]
  counts: Record<string, number>
  promptCount: number
  totalTests: number
  matrixBlocked: boolean
  runError: boolean
}) {
  // Row per prompt variation: the baseline plus each extra prompt.
  const promptRows = [
    'Agent’s saved prompt',
    ...Array.from({ length: promptCount }, (_, i) => `Test prompt ${i + 1}`),
  ]

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Models" value={String(selectedModels.length)} />
        <Stat label="Prompts" value={String(promptRows.length)} />
      </div>

      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Test matrix
        </h3>
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-neutral-50">
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-400" />
                {selectedModels.map((m) => (
                  <th
                    key={m.id}
                    className="px-3 py-2 text-center text-xs font-medium text-neutral-600"
                  >
                    <div className="flex items-center justify-center gap-1">
                      <BrandMark
                        brand={inferModelBrand(`${m.id} ${m.label}`)}
                        fallback={m.label}
                      />
                      <span className="max-w-[6rem] truncate">{m.label}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {promptRows.map((label) => (
                <tr
                  key={label}
                  className="border-t border-neutral-100"
                >
                  <td className="px-3 py-2 text-xs text-neutral-500">{label}</td>
                  {selectedModels.map((m) => (
                    <td
                      key={m.id}
                      className="px-3 py-2 text-center tabular-nums text-neutral-800"
                    >
                      {counts[m.id] ?? 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-xs text-neutral-400">
          {selectedModels.length} model
          {selectedModels.length === 1 ? '' : 's'} × {promptRows.length} prompt
          {promptRows.length === 1 ? '' : 's'} ={' '}
          <span className="font-medium text-neutral-600">
            {totalTests} test{totalTests === 1 ? '' : 's'}
          </span>{' '}
          per sample
        </p>
      </div>

      {/* Estimated cost — no pricing data yet, so blur it out as a placeholder. */}
      <div className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Estimated cost
          </div>
          <div className="text-[11px] text-neutral-400">
            Pricing estimate coming soon.
          </div>
        </div>
        <span
          aria-hidden
          className="select-none text-xl font-semibold text-neutral-800 blur-sm"
        >
          $12.34
        </span>
      </div>

      {matrixBlocked ? (
        <p className="text-xs text-amber-600">
          Running a full matrix (multiple models, higher run counts, or extra
          prompts) isn&apos;t supported by the engine yet — select a single
          model with one run and no extra prompts to launch. Matrix runs are
          coming.
        </p>
      ) : null}
      {runError ? (
        <p className="text-xs text-red-600">
          Couldn&apos;t launch the run. Check that eval runs are configured for
          this host, then try again.
        </p>
      ) : null}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-neutral-900">
        {value}
      </div>
    </div>
  )
}
