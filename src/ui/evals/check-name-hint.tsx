import { Sparkles } from 'lucide-react'

import { cn } from '../cn'
import { CHECK_NAME_VERBS } from './check-naming'

// The naming affordance shown on a Check that hasn't been named yet.
//
// Two nudges, both of which reduce work rather than add rules:
//   • the verb chips seed the title with an assertion starter, which is also
//     how the *negative* forms ("Avoids", "Never") get discovered — authors
//     rarely think to write those unprompted;
//   • the suggestion is a real, accept-in-one-keystroke name derived from what
//     this Check actually asserts.
//
// It disappears the moment the Check has a name, so a named Check carries no
// leftover chrome.
export function CheckNameHint({
  suggestion,
  isSuggesting,
  onPickVerb,
  onAccept,
}: {
  /** A concrete proposed name, or null when there's nothing to propose yet. */
  suggestion: string | null
  /** The suggestion is still being generated (judge Checks call a model). */
  isSuggesting?: boolean
  onPickVerb: (verb: string) => void
  onAccept: (name: string) => void
}) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-200 bg-neutral-50/60 px-4 py-3">
      <p className="text-xs text-neutral-500">
        Name this check as an <strong className="font-medium">assertion</strong>{' '}
        — what has to be true of the response. Start with a verb:
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {CHECK_NAME_VERBS.map((verb) => (
          <button
            key={verb}
            type="button"
            onClick={() => onPickVerb(verb)}
            className="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:border-neutral-400 hover:text-neutral-900"
          >
            {verb}…
          </button>
        ))}
      </div>
      {(suggestion || isSuggesting) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
          <Sparkles
            className={cn(
              'size-3.5 text-amber-500',
              isSuggesting && 'animate-pulse',
            )}
          />
          {suggestion ? (
            <>
              <button
                type="button"
                onClick={() => onAccept(suggestion)}
                className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 font-medium text-amber-800 transition hover:border-amber-300 hover:bg-amber-100"
              >
                {suggestion}
              </button>
              <span className="text-neutral-400">
                click to use, or press Tab in the title
              </span>
            </>
          ) : (
            <span className="text-neutral-400">Suggesting a name…</span>
          )}
        </div>
      )}
    </div>
  )
}
