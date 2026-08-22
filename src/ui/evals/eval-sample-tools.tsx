import { AlertTriangle, Ban, Radio, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type {
  EvalToolMode,
  EvalTools,
  WfEvalTargetKind,
} from '../../server/protocol'
import { cn } from '../cn'
import { useAgent } from '../hooks'

import { MockToolsPanel } from './eval-sample-mocks'

// A Sample's TOOLS — one tri-state, because the three settings are mutually
// exclusive in the engine. They used to be two independent fields on two
// different cards: "Freeze tools" lived inside the seeded conversation while the
// fixtures lived below it, so turning freeze on silently made every fixture dead
// and every trajectory check ungradeable, with nothing saying so.
//
// Write tools are neutralized in ALL three modes. An eval never writes.
//
// The card is only shown at all when the target HAS tools — see
// `useTargetHasTools`. Asking how a toolless agent's tools should behave is a
// question with no answer, and all three modes are identical for it.

const MODES: {
  mode: EvalToolMode
  icon: LucideIcon
  label: string
  blurb: string
  accent: string
}[] = [
  {
    mode: 'mocked',
    icon: Wrench,
    label: 'Mocked',
    blurb: 'Read tools return a canned result you pin here.',
    accent: 'border-violet-400 bg-violet-50/60 text-violet-700',
  },
  {
    mode: 'frozen',
    icon: Ban,
    label: 'None',
    blurb: 'No tools at all — the agent answers from its input alone.',
    accent: 'border-amber-400 bg-amber-50/60 text-amber-700',
  },
  {
    mode: 'live',
    icon: Radio,
    label: 'Live',
    blurb: 'Read tools execute for real, against real data.',
    accent: 'border-sky-400 bg-sky-50/60 text-sky-700',
  },
]

export function SampleToolsEditor({
  targetId,
  targetKind,
  value,
  onChange,
  addOpen,
  onAddOpenChange,
  /** How many tool results the Sample's conversation already stages, if any. */
  stagedToolResults,
}: {
  targetId: string
  targetKind: WfEvalTargetKind
  value: EvalTools
  onChange: (next: EvalTools) => void
  addOpen: boolean
  onAddOpenChange: (open: boolean) => void
  stagedToolResults: number
}) {
  // Switching modes never destroys the fixtures an author has written: they stay
  // on the `mocked` variant and come back when the mode does. Only `mocked`
  // carries them, so the type still can't express "frozen, with fixtures".
  const fixtures = value.mode === 'mocked' ? value.fixtures : {}
  const select = (mode: EvalToolMode) => {
    if (mode === value.mode) return
    onChange(mode === 'mocked' ? { mode, fixtures } : { mode })
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {MODES.map((m) => {
          const Icon = m.icon
          const on = m.mode === value.mode
          return (
            <button
              key={m.mode}
              type="button"
              onClick={() => select(m.mode)}
              className={cn(
                'rounded-lg border-2 p-3 text-left transition',
                on
                  ? m.accent
                  : 'border-neutral-200 text-neutral-700 hover:border-neutral-300',
              )}
            >
              <div className="flex items-center gap-1.5">
                <Icon className="size-4" />
                <span className="text-sm font-semibold">{m.label}</span>
              </div>
              <p
                className={cn(
                  'mt-1 text-[11px] leading-snug',
                  on ? 'opacity-80' : 'text-neutral-400',
                )}
              >
                {m.blurb}
              </p>
            </button>
          )
        })}
      </div>

      {value.mode === 'mocked' ? (
        <MockToolsPanel
          targetId={targetId}
          targetKind={targetKind}
          fixtures={value.fixtures}
          addOpen={addOpen}
          onAddOpenChange={onAddOpenChange}
          onChange={(next) => onChange({ mode: 'mocked', fixtures: next })}
        />
      ) : value.mode === 'frozen' ? (
        <p className="px-1 text-xs text-neutral-400">
          {stagedToolResults > 0 ? (
            <>
              The agent answers from the{' '}
              <strong className="font-medium text-neutral-500">
                {stagedToolResults} tool result
                {stagedToolResults === 1 ? '' : 's'}
              </strong>{' '}
              staged in the conversation above. Trajectory checks are unavailable
              — no tool step will exist in the trace to grade.
            </>
          ) : (
            <>
              The agent gets no tools and no staged results, so it answers from
              its prompt alone. Stage a tool result on an assistant turn to give
              it retrieved context to synthesize from.
            </>
          )}
        </p>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <p className="text-[11px] text-amber-700">
            Read tools hit <strong>real data</strong> in this mode, so the sample
            is only as reproducible as the corpus behind them. Write tools are
            still neutralized — an eval never writes — but expect this sample to
            move as the data does.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Whether the Sample's target has any tools for this card to configure.
 *
 * "Tools" is both halves of what `freezeTools` would switch off: the agent's
 * registry tools AND its delegation targets, whose `spawn_*` / `await_subagents`
 * tools are synthesized at run time and suppressed under `frozen` exactly like
 * the registry ones. An agent with neither behaves identically in all three
 * modes, so the card is hidden rather than asking an unanswerable question.
 *
 * `null` while the agent is still loading — the caller renders nothing yet
 * rather than flashing a card in and back out.
 */
export function useTargetHasTools(
  targetId: string,
  targetKind: WfEvalTargetKind,
): boolean | null {
  const detail = useAgent(targetId)
  // A workflow target's tools live on its nodes, not on one agent config, so we
  // can't resolve them here. Keep the card: its body explains that workflow node
  // mocks aren't built yet.
  if (targetKind !== 'agent') return true
  if (!targetId) return false
  if (detail.isLoading) return null
  const config = detail.data?.currentVersion?.config ?? detail.data?.draft?.config
  if (!config) return false
  return (
    config.toolIds.length > 0 || (config.subAgents?.targets.length ?? 0) > 0
  )
}
