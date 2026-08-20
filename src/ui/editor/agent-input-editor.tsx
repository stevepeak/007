import { AlertTriangle } from 'lucide-react'

import { type AgentConfig, inferPromptVariables } from '../../engine'
import { cn } from '../cn'
import {
  PROMPT_EDITOR_COMPACT_HEIGHT,
  PromptBodyEditor,
} from './prompt-body-editor'

// Editor for an agent's INPUT contract — the counterpart to `AgentOutputEditor`,
// and deliberately the same two-card shape, because the two questions are peers:
// what does this agent receive, and what must it return.
//
//   • Task         — one user message the author writes here. Its `${variables}`
//                    are mapped per placement in the workflow editor.
//   • Conversation — a chat thread, bound on every node to the message source.
//
// There is no third, implicit option. An agent used to receive whatever its
// incoming edge produced, JSON-stringified into a turn nobody wrote; that is
// gone, so this control is now the ONLY way data reaches an agent.

type Kind = AgentConfig['inputKind']

export type AgentInputEditorProps = {
  inputKind: Kind
  /**
   * The live template — drives the variable chips and the empty-turn error.
   * Distinct from `initialUserPrompt` because the editor below is a TipTap
   * document seeded once, exactly like the system prompt (see `initialBody`).
   */
  userPrompt: string
  initialUserPrompt: string
  onChange: (patch: Partial<Pick<AgentConfig, 'inputKind' | 'userPrompt'>>) => void
  /** `${vars}` already declared by the system prompt, to show the shared bag. */
  systemPromptVariables: string[]
  /** Imperative setter for the template body, for a version restore. */
  registerSetUserPrompt?: (setBody: (body: string) => void) => void
}

const OPTIONS: { kind: Kind; label: string; hint: string }[] = [
  { kind: 'task', label: 'Task', hint: 'Runs on one message you write' },
  { kind: 'conversation', label: 'Conversation', hint: 'Answers a chat thread' },
]

export function AgentInputEditor({
  inputKind,
  userPrompt,
  initialUserPrompt,
  onChange,
  systemPromptVariables,
  registerSetUserPrompt,
}: AgentInputEditorProps) {
  const userVariables = inferPromptVariables(userPrompt)
  // Both templates interpolate from one bag, so a name is listed once no matter
  // where it appears — this is exactly the set a node has to bind.
  const allVariables = [
    ...new Set([...systemPromptVariables, ...userVariables]),
  ]
  const missingTurn = inputKind === 'task' && userPrompt.trim().length === 0

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {OPTIONS.map((o) => {
          const active = inputKind === o.kind
          return (
            <button
              key={o.kind}
              type="button"
              onClick={() => onChange({ inputKind: o.kind })}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-sm transition',
                active
                  ? 'border-neutral-800 bg-neutral-900 text-white'
                  : 'border-neutral-300 text-neutral-700 hover:border-neutral-400',
              )}
            >
              <div className="font-medium">{o.label}</div>
              <div
                className={cn(
                  'mt-0.5 text-xs',
                  active ? 'text-neutral-300' : 'text-neutral-400',
                )}
              >
                {o.hint}
              </div>
            </button>
          )
        })}
      </div>

      {inputKind === 'conversation' ? (
        <p className="text-xs text-neutral-500">
          Every workflow node using this agent must bind its{' '}
          <code className="rounded bg-neutral-100 px-1">conversation</code> input
          to the message source — usually the chat trigger's{' '}
          <code className="rounded bg-neutral-100 px-1">messages</code>. A run
          with it unbound fails rather than answering with no context. Anything
          you write below is appended after the thread as the current turn.
        </p>
      ) : null}

      <div className="space-y-1.5">
        <span className="text-foreground block text-sm font-medium">
          User message
          {inputKind === 'conversation' ? (
            <span className="ml-1.5 text-xs font-normal text-neutral-400">
              optional
            </span>
          ) : null}
        </span>
        {/* The same TipTap editor as the system prompt, so both templates author
        identically: Markdown formatting round-trips, and `${variables}` render
        as chips — which matters more here, since these tokens are the agent's
        entire input contract. */}
        <PromptBodyEditor
          initialBody={initialUserPrompt}
          onChange={(body) => onChange({ userPrompt: body })}
          registerSetBody={registerSetUserPrompt}
          minHeightClass={PROMPT_EDITOR_COMPACT_HEIGHT}
          hint="formatting"
          placeholder={'The message this agent runs on — e.g. “Price this recipe: ${recipe}”'}
          className={cn(missingTurn && 'border-red-300 focus-within:border-red-400')}
        />
        {missingTurn ? (
          <p className="flex items-start gap-1.5 text-xs text-red-600">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              A task agent needs a user message — it's the only way data reaches
              it. Reference the data with{' '}
              <code className="rounded bg-red-50 px-1">{'${variables}'}</code>{' '}
              you map on each workflow node.
            </span>
          </p>
        ) : (
          <p className="text-xs text-neutral-500">
            Put the per-call data here rather than in the system prompt: the
            system prompt is the provider's cache prefix, so keeping it identical
            across calls is what makes prompt caching pay off when a workflow runs
            this agent once per item.
          </p>
        )}
      </div>

      {allVariables.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-[10px] font-medium tracking-wide text-neutral-400 uppercase">
            Inputs to map on every node
          </div>
          <div className="flex flex-wrap gap-1">
            {allVariables.map((name) => (
              <code
                key={name}
                className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600"
              >
                {name}
              </code>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
