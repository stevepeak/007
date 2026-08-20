import { cn } from '../cn'

// The grey footer that sits under every Markdown-enabled box (agent prompts,
// the user message, a canvas note). Two jobs: show that the box takes Markdown
// and which marks it understands, and — where the text is a template — explain
// what a `${variable}` is for, since that is the ONLY route data takes from the
// workflow into the model.

// The marks the boxes actually render. Kept short on purpose: this is a nudge,
// not a Markdown manual, so it stays one line under a compact editor.
const MARKS = ['**bold**', '*italic*', '`code`', '# Heading', '- list', '> quote', '[link](url)']

export type MarkdownHintProps = {
  /**
   * Explain `${variables}` too. Off for boxes whose text is never interpolated
   * — a canvas note is read by people, not rendered into a prompt.
   */
  variables?: boolean
  className?: string
}

export function MarkdownHint({
  variables = true,
  className,
}: MarkdownHintProps) {
  return (
    <div className={cn('space-y-1 text-xs text-neutral-500', className)}>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="text-neutral-400">Markdown —</span>
        {MARKS.map((m) => (
          <code
            key={m}
            className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[11px] text-neutral-600"
          >
            {m}
          </code>
        ))}
      </p>
      {variables ? (
        <p>
          <code className="rounded bg-indigo-100 px-1 py-0.5 font-medium text-indigo-700">
            {'${variable}'}
          </code>{' '}
          is a named slot filled in when the agent runs — every workflow node
          using this agent maps each name to real data (an upstream node&apos;s
          output, or a fixed value). Use one for anything that changes per run
          and keep the rest of the wording fixed; a name nobody maps reaches the
          model as the literal text{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[11px] text-neutral-600">
            {'${variable}'}
          </code>
          , which the workflow editor flags before you can publish.
        </p>
      ) : null}
    </div>
  )
}
