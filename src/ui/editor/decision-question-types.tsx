import { List, SignalHigh, ToggleLeft, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import {
  DEFAULT_DECISION_THRESHOLD,
  type DecisionQuestionType,
} from '../../engine'
import { cn } from '../cn'

// How the three answer shapes are PRESENTED — the labels, the help text and the
// glyphs — for the decision agent's question editor
// (`decision-agent-questions.tsx`).

export const TYPE_LABEL: Record<DecisionQuestionType, string> = {
  boolean: 'Yes / no',
  category: 'Pick one',
  scale: 'Rate on a scale',
}

/**
 * The segmented control's own labels, shorter than {@link TYPE_LABEL} because
 * three segments plus three icons have to fit a half-width card. The long form
 * stays for prose — "this decider can't answer 'Rate on a scale' questions"
 * needs the whole phrase.
 */
export const TYPE_SHORT: Record<DecisionQuestionType, string> = {
  boolean: 'Yes / no',
  category: 'Pick one',
  scale: 'Scale',
}

/**
 * One glyph per answer shape, so the three segments are told apart at a glance
 * rather than by reading all three labels:
 *
 *   • boolean  — a two-state toggle: it lands on one side or the other.
 *   • category — a flat list of named options, no order between them.
 *   • scale    — ascending bars, because on a scale the ORDER is the meaning
 *     (the rules compare through it), which a dial or a balance would not say.
 */
export const TYPE_ICON: Record<DecisionQuestionType, LucideIcon> = {
  boolean: ToggleLeft,
  category: List,
  scale: SignalHigh,
}

export const TYPE_HELP: Record<DecisionQuestionType, string> = {
  boolean:
    'Answered with a probability, and turned into yes/no by the threshold below — so you choose where the line sits, not the model.',
  category:
    'Answered with one of the choices, plus the odds it gave every other one, so a near-tie is visible instead of hidden behind the winner.',
  scale:
    'Answered with a position along the choices, in order — 1.8 on a three-point scale means "between the second and third, nearer the third".',
}

/**
 * The label column's width, as a padding class.
 *
 * Helper text that explains a CONTROL has to hang under the control, not under
 * its label — so it needs the same measurement {@link Row} uses for the label
 * column (`w-16`) plus the gap (`gap-2`). Named, because it appeared as a bare
 * `pl-[72px]` in a dozen places on two cards, where nothing connected it to the
 * width it has to track.
 */
export const GUTTER = 'pl-[72px]'

/**
 * One labelled row on a question card: a fixed-width right-aligned label, then
 * the control. Shared by both authoring surfaces so their rows line up
 * identically.
 *
 * `align: 'start'` is for a control that GROWS (the prompt textarea, a choice
 * with its key underneath): centring a label against a three-line box leaves it
 * floating in the middle of nothing.
 */
export function Row({
  label,
  align = 'center',
  children,
}: {
  label: string
  align?: 'center' | 'start'
  children: ReactNode
}) {
  return (
    <label
      className={cn(
        'flex gap-2',
        align === 'start' ? 'items-start' : 'items-center',
      )}
    >
      <span
        className={cn(
          'text-muted-foreground w-16 shrink-0 text-right text-[11px]',
          // Nudge down to sit on the first line of a top-aligned control.
          align === 'start' && 'pt-2',
        )}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  )
}

/**
 * A boolean question's cut, as a scale you drag rather than a number you type.
 *
 * It was a `<number>` box, and a bare `0.6` says nothing about what it DOES — nor
 * which way is stricter, nor that 0.01 and 0.6 differ in kind rather than degree.
 * The quantity is real and stays editable (and readable, as a percentage beside
 * the slider), but what an author is actually choosing is a disposition: answer
 * yes on a hint, or only when the model is sure. So the sentence under the slider
 * carries the meaning and the slider carries the value.
 *
 * Range is 0.05–0.95, not 0–1: a cut of 0 makes every answer yes and 1 makes
 * every answer no, and both delete the question rather than tune it. Step 0.05
 * because a provider's calibration does not justify finer, and 20 stops is
 * already more than anyone tunes by hand.
 *
 * `undefined` means the question never set a cut and the engine falls back to
 * {@link DEFAULT_DECISION_THRESHOLD}; the slider sits there, and since that
 * default IS 0.5, what it shows is what will happen either way.
 */
export function ThresholdScale({
  value,
  label,
  onChange,
  guidance = true,
  ariaLabel,
}: {
  value: number | undefined
  /** For the accessible name — the question or node this cut belongs to. */
  label: string
  onChange: (next: number) => void
  /**
   * `false` drops the explaining sentence, leaving the slider and its percentage.
   * For a RULE condition (`needs_review is at least 70%`), where the surrounding
   * row already reads as a sentence and the disposition copy would be wrong: a
   * rule's comparison is not a yes/no cut, it is a threshold on how sure the
   * model was.
   */
  guidance?: boolean
  /** Overrides the derived accessible name, for a non-threshold use. */
  ariaLabel?: string
}) {
  const effective = value ?? DEFAULT_DECISION_THRESHOLD
  const pct = Math.round(effective * 100)
  const band = bandOf(effective)
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          type="range"
          className="accent-foreground h-1.5 min-w-0 flex-1 cursor-pointer"
          min={0.05}
          max={0.95}
          step={0.05}
          value={effective}
          aria-label={ariaLabel ?? `Threshold for ${label}`}
          aria-valuetext={guidance ? `${pct}% — ${BANDS[band].help}` : `${pct}%`}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="text-foreground w-9 shrink-0 text-right font-mono text-[11px] tabular-nums">
          {pct}%
        </span>
      </div>
      {guidance ? (
        /* Every band rendered at once, stacked in ONE grid cell, with only the
           current one at full opacity — so moving the slider cross-fades between
           sentences instead of swapping them instantly.

           A grid rather than absolute positioning because a grid cell takes the
           height of its TALLEST child: the block never changes height as the text
           changes, so nothing below it jumps, and no sentence can be clipped by a
           hardcoded height. (Absolutely-positioned children contribute no height,
           which is how that version would have gone wrong.)

           Pure CSS, no state and no timers: the incoming sentence fades up while
           the outgoing one fades out, both driven by the same class flip. The
           project has no animation plugin — `animate-in` compiles to nothing
           here — so this uses base `transition-opacity`. */
        <div className="grid">
          {BAND_ORDER.map((key) => (
            <p
              key={key}
              aria-hidden={key !== band}
              className={cn(
                'text-muted-foreground col-start-1 row-start-1 text-center text-[11px] transition-opacity duration-300 ease-out',
                key === band
                  ? 'opacity-100'
                  : 'pointer-events-none opacity-0',
              )}
            >
              {BANDS[key].help}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * What a cut MEANS, in a sentence — the half of the control a number could never
 * carry.
 *
 * Banded rather than interpolated: the difference between 0.60 and 0.65 is not
 * something anyone can act on, while the difference between "on a hint" and "only
 * when sure" is the whole decision. Five bands, each sentence kept to a similar
 * length so the cross-fade swaps like for like rather than visibly reflowing.
 *
 * `max` is the top of each band, exclusive except for the last.
 */
const BANDS = {
  hint: {
    max: 0.25,
    help: 'Says yes on a hint — catches almost everything, and cries wolf.',
  },
  lenient: {
    max: 0.45,
    help: 'Leans towards yes. Errs on the side of catching it.',
  },
  neutral: {
    max: 0.55,
    help: 'Says yes whenever yes is the likelier answer — the neutral cut.',
  },
  strict: {
    max: 0.8,
    help: 'Leans towards no. Wants real evidence before it says yes.',
  },
  sure: {
    max: 1,
    help: 'Only when clearly sure. Quietest, and it lets borderline cases through.',
  },
} as const

type Band = keyof typeof BANDS

/** Low to high, so the stack renders in the order the slider travels. */
const BAND_ORDER = Object.keys(BANDS) as Band[]

/** Which band a cut falls in. `<=` on the first match, low to high. */
function bandOf(threshold: number): Band {
  return BAND_ORDER.find((k) => threshold <= BANDS[k].max) ?? 'sure'
}
