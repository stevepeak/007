import { Frown, HelpCircle, type LucideIcon, Meh, Smile } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import type { EvalCheck, JudgeBar } from '../../server/protocol'
import { resolveJudgeBar } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { ModelSelect } from '../editor/model-select'
import { useModels } from '../hooks'
import { Modal } from '../modal'
import { useCommittedField } from '../use-committed-field'

// ── Scored (judge) config ────────────────────────────────────────────────────

export function JudgeConfig({
  check,
  persist,
}: {
  check: Extract<EvalCheck, { type: 'llm_judge' }>
  persist: (next: EvalCheck) => void
}) {
  const { Input, Label, Textarea } = useWfComponents()
  const rubricField = useCommittedField(check.rubric, (rubric) =>
    persist({ ...check, rubric }),
  )
  // Optional JSON path pinning the judge to one output field; blank = whole output.
  const pathField = useCommittedField(check.path ?? '', (path) =>
    persist({ ...check, path: path.trim() || undefined }),
  )

  // The judge model is required, so keep one selected: as soon as the model list
  // loads, seed an empty selection with the first available model.
  const models = useModels()
  useEffect(() => {
    if (check.modelId) return
    const first = models.data?.[0]?.id
    if (first) persist({ ...check, modelId: first })
  }, [check, models.data, persist])

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Judge model</Label>
        <ModelSelect
          value={check.modelId ?? ''}
          onChange={(modelId) => persist({ ...check, modelId })}
        />
      </div>
      <div className="space-y-1">
        <Label>Rubric</Label>
        <Textarea
          rows={3}
          value={rubricField.value}
          placeholder="What should the judge reward or penalize?"
          onChange={(e) => rubricField.onChange(e.target.value)}
          onBlur={rubricField.onBlur}
        />
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <Label>Output path (optional)</Label>
          <FieldHelp title="Output path">
            <p>
              Pin the judge to a single field of the run output instead of the
              whole thing. Use a dot/bracket path like{' '}
              <strong>docMeta.parties</strong> or <strong>items[0].name</strong>.
            </p>
            <p>
              Leave it <strong>blank</strong> to grade the entire output. Set it
              when your rubric is about one known value — the judge then sees
              only that value, so unrelated fields can’t distract or dilute it.
            </p>
          </FieldHelp>
        </div>
        <Input
          value={pathField.value}
          placeholder="blank = whole output — e.g. docMeta.parties"
          onChange={(e) => pathField.onChange(e.target.value)}
          onBlur={pathField.onBlur}
        />
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <Label>Pass bar</Label>
          <FieldHelp title="Pass bar">
            <p>
              The judge doesn’t hand back a number — it picks one of three
              anchored verdicts: <strong>nails it</strong>,{' '}
              <strong>close enough</strong>, or <strong>misses it</strong>. This
              setting decides which of those you’re willing to accept.
            </p>
            <p>
              <strong>Close enough</strong> is the right default for most
              rubrics. Reach for <strong>nails it</strong> only when a
              one-concrete-fix answer is genuinely a failure, and{' '}
              <strong>just score it</strong> when you want to watch a soft
              quality bar (tone, concision) trend over time without it failing
              the suite.
            </p>
          </FieldHelp>
        </div>
        <BarScale
          value={resolveJudgeBar(check)}
          onSelect={(bar) => persist({ ...check, bar, threshold: undefined })}
        />
      </div>
      <p className="text-xs text-neutral-400">
        One rubric, one question — a rubric that asks about accuracy{' '}
        <em>and</em> tone gets a mushy “close enough” on both. Add a second
        scored test instead; each verdict counts toward the goal’s score.
      </p>
    </div>
  )
}

// The three verdicts, worst → best, as a single horizontal scale the author
// reads bottom-up: picking a tile means "this verdict and anything better
// passes", so the tiles to its right light up with it and the ones to its left
// stay greyed as the failing band. That's the same cutoff the old 0–1 threshold
// box encoded, minus the pretense that a judge can tell 0.65 from 0.75.
const BARS: {
  value: JudgeBar
  icon: LucideIcon
  label: string
  desc: string
  tone: { on: string; icon: string }
}[] = [
  {
    value: 'nails_it',
    icon: Smile,
    label: 'Nails it',
    desc: 'Only a clean answer passes.',
    tone: { on: 'border-emerald-400 bg-emerald-50/60', icon: 'bg-emerald-100 text-emerald-700' },
  },
  {
    value: 'close_enough',
    icon: Meh,
    label: 'Close enough',
    desc: 'Good, with one nit, still passes.',
    tone: { on: 'border-amber-400 bg-amber-50/60', icon: 'bg-amber-100 text-amber-700' },
  },
  {
    value: 'score_only',
    icon: Frown,
    label: 'Just score it',
    desc: 'Never fails — only moves the score.',
    tone: { on: 'border-neutral-400 bg-neutral-50', icon: 'bg-neutral-200 text-neutral-600' },
  },
]

function BarScale({
  value,
  onSelect,
}: {
  value: JudgeBar
  onSelect: (bar: JudgeBar) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {BARS.map((b) => {
        const Icon = b.icon
        const on = b.value === value
        return (
          <button
            key={b.value}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(b.value)}
            className={cn(
              'flex flex-col items-center gap-2 rounded-xl border-2 px-2 py-3 text-center transition',
              on ? b.tone.on : 'border-neutral-200 bg-white hover:border-neutral-300',
            )}
          >
            <span
              className={cn(
                'flex size-9 items-center justify-center rounded-lg',
                on ? b.tone.icon : 'bg-neutral-100 text-neutral-400',
              )}
            >
              <Icon className="size-5" />
            </span>
            <span
              className={cn(
                'text-sm font-semibold',
                on ? 'text-neutral-900' : 'text-neutral-500',
              )}
            >
              {b.label}
            </span>
            <span className="text-xs leading-snug text-neutral-500">{b.desc}</span>
          </button>
        )
      })}
    </div>
  )
}

// Small "(?)" affordance next to a field label that opens a Modal explaining
// what the field does. Owns its own open state so it can be dropped inline.
function FieldHelp({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label={`About ${title}`}
        onClick={() => setOpen(true)}
        className="inline-flex size-4 items-center justify-center rounded-full text-neutral-400 transition hover:text-neutral-700"
      >
        <HelpCircle className="size-3.5" />
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        panelClassName="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-xl"
      >
        <div className="space-y-3 px-5 py-5 text-sm leading-relaxed text-neutral-600">
          {children}
        </div>
      </Modal>
    </>
  )
}
