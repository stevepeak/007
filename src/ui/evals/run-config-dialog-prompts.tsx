import { Plus, Trash2 } from 'lucide-react'

import { PromptBodyEditor } from '../editor/prompt-body-editor'
import { IdeaSpark } from '../idea-spark'

import type { TestPrompt } from './use-run-config-matrix'

// The PROMPTS axis of the test matrix. The target's own prompt is always the
// baseline column and is neither editable nor removable here — it is the thing
// the extra prompts are being compared against. Each extra prompt adds a row to
// the matrix, so N prompts means N+1 columns in the report.
export function PromptAxis({
  baselineLabel,
  prompts,
  availableVariables,
  onAdd,
  onRemove,
  onBody,
}: {
  /** Name of the always-present first column — saved prompt, or the draft. */
  baselineLabel: string
  prompts: TestPrompt[]
  /** `${variables}` the target agent defines — the only ones that resolve. */
  availableVariables: string[]
  onAdd: () => void
  onRemove: (id: string) => void
  onBody: (id: string, body: string) => void
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Prompts to test
        </h3>
        <PromptAxisPitch />
      </div>

      <div className="space-y-2">
        {/* Baseline — always in the suite, not editable/removable. */}
        <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
          <span className="rounded-full bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium text-white">
            Baseline
          </span>
          <span className="min-w-0 flex-1 truncate text-neutral-700">
            {baselineLabel}
          </span>
          <span className="shrink-0 text-xs text-neutral-400">
            always included
          </span>
        </div>

        {prompts.map((p, i) => (
          <div
            key={p.id}
            className="space-y-1 rounded-lg border border-neutral-200 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-neutral-500">
                Test prompt {i + 1}
              </span>
              <div className="flex-1" />
              <button
                type="button"
                aria-label={`Remove test prompt ${i + 1}`}
                onClick={() => onRemove(p.id)}
                className="text-neutral-400 transition hover:text-red-600"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <PromptBodyEditor
              initialBody={p.body}
              onChange={(body) => onBody(p.id, body)}
              placeholder="Write an alternate system prompt… use ${variable} for values."
              className="min-h-[6rem] [&_.ProseMirror]:min-h-[5rem]"
              hint="formatting"
            />
          </div>
        ))}

        <button
          type="button"
          onClick={onAdd}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-neutral-300 px-3 py-2 text-sm text-neutral-500 transition hover:border-neutral-400 hover:text-neutral-700"
        >
          <Plus className="size-4" />
          Add test prompt
        </button>

        <VariableHints variables={availableVariables} />
      </div>
    </div>
  )
}

/** The `${variables}` line under the prompt list. */
function VariableHints({ variables }: { variables: string[] }) {
  if (variables.length === 0) {
    return (
      <p className="text-xs text-neutral-400">
        The target agent defines no ${'{'}variables{'}'} — prompts run as-is.
      </p>
    )
  }
  return (
    <p className="text-xs text-neutral-400">
      Variables you can use:{' '}
      {variables.map((v, i) => (
        <span key={v}>
          {i > 0 ? ' ' : ''}
          <code className="rounded bg-indigo-100 px-1 py-0.5 font-medium text-indigo-700">
            ${'{'}
            {v}
            {'}'}
          </code>
        </span>
      ))}
    </p>
  )
}

/** The explainer popover. Long because it is entirely prose. */
function PromptAxisPitch() {
  return (
    <IdeaSpark
      title="Matrix-test alternate system prompts"
      hint="How prompt A/B testing works"
    >
      <p>
        A goal runs against the target agent&apos;s saved prompt by default. It
        can also sweep <strong>prompt variations</strong>, which turns testing
        into a full matrix.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          The agent&apos;s <strong>saved prompt</strong> is always the baseline
          in the suite.
        </li>
        <li>
          Add any number of <strong>extra system prompts</strong>, authored in
          the same tiptap editor as the agent editor — with the same{' '}
          <code>${'{'}variable{'}'}</code> chips. Only variables the target
          already defines are meaningful; a prompt may skip or repeat one
          freely.
        </li>
        <li>
          The suite is the <strong>cross-product</strong>:{' '}
          <em>models × prompts</em>. 4 models × 4 prompts = 16 tests. Each cell
          is graded against the same sample checks, so you can read off which
          prompt wins on which model.
        </li>
      </ul>
      <p>
        Before launching, a <strong>confirmation step</strong> lays out the
        whole matrix and an <strong>estimated cost</strong> so a big sweep is a
        deliberate choice. (Cost is a placeholder until we wire real per-model
        token pricing.)
      </p>
    </IdeaSpark>
  )
}
