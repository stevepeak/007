import { Loader2, Play } from 'lucide-react'
import { useState } from 'react'

import {
  decisionAgentConfigIssues,
  decisionAgentInputVariables,
  verdictReasoning,
  type DecisionAgentConfig,
} from '../../engine'
import { errorMessage } from '../../engine/error-message'
import type { DecisionPreviewResult } from '../../server/protocol'
import { cn } from '../cn'
import { parseLooseJson } from '../code/json'
import { useWfClient, useWfComponents } from '../context'

// The decision playground: one state in, one verdict out.
//
// It runs the DRAFT, like the generation playground does, so an author can
// judge a question rewording before publishing it. What it does not have is
// everything the generation playground needs and this doesn't: no tool
// simulate/live toggle (a decision agent calls nothing), no conversation
// history (it takes a state, not a thread), no turn trace (there is one call).
//
// What it shows instead is the thing worth reading — the RAW distribution
// beside the verdict. A rollup that fired on 0.71 against a 0.70 threshold is
// a different fact from one that fired on 0.98, and the verdict alone cannot
// tell you which you have.

export function DecisionPlaygroundPanel({
  config,
}: {
  config: DecisionAgentConfig
}) {
  const { Button, Textarea, Input } = useWfComponents()
  const client = useWfClient()
  const [state, setState] = useState('')
  const [variables, setVariables] = useState<Record<string, string>>({})
  const [result, setResult] = useState<DecisionPreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const variableNames = decisionAgentInputVariables(config)
  // The server refuses these too; saying so here keeps the button honest.
  const issueCount = decisionAgentConfigIssues(config).length
  const subject = parseSubject(state)

  async function run() {
    setRunning(true)
    setError(null)
    try {
      setResult(
        await client.runDecisionPreview({ config, state: subject, variables }),
      )
    } catch (e: unknown) {
      setResult(null)
      setError(errorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-neutral-900">Playground</h2>
        <Button size="sm" onClick={run} disabled={running || !state.trim() || issueCount > 0}>
          {running ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          {running ? 'Judging…' : 'Judge'}
        </Button>
      </div>
      <p className="text-xs text-neutral-500">
        Judges the unsaved draft — every question in one call. Nothing is saved
        and nothing is published.
      </p>
      {issueCount > 0 ? (
        <p className="text-xs text-amber-700">
          Fix the {issueCount === 1 ? 'issue' : `${issueCount} issues`} in the
          Issues panel to judge — a rule that cannot hold would fall through to
          the fallback and show a verdict the rules never reached.
        </p>
      ) : null}

      <Textarea
        value={state}
        onChange={(e) => setState(e.target.value)}
        rows={6}
        spellCheck={false}
        placeholder="Paste the thing to judge — a message, an email, or JSON (an object or array is sent as JSON, the way a node judges its bound value)"
        className="font-mono text-[11px]"
      />
      {typeof subject === 'string' ? null : (
        <p className="text-[11px] text-neutral-500">Sent as JSON.</p>
      )}

      {variableNames.map((name) => (
        <div key={name} className="flex items-center gap-2">
          <span
            title={name}
            className="w-32 shrink-0 truncate rounded bg-neutral-100 px-2 py-1.5 font-mono text-xs text-neutral-600"
          >
            {name}
          </span>
          <Input
            value={variables[name] ?? ''}
            placeholder="value"
            onChange={(e) => {
              setVariables((v) => ({ ...v, [name]: e.target.value }))
            }}
            className="h-8 flex-1 font-mono text-xs"
          />
        </div>
      ))}

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          {error}
        </div>
      ) : null}

      {result ? <DecisionResult result={result} /> : null}
    </section>
  )
}

function DecisionResult({ result }: { result: DecisionPreviewResult }) {
  return (
    <div className="space-y-3 rounded-md border border-neutral-200 bg-neutral-50 p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="rounded-md bg-neutral-900 px-2 py-0.5 text-xs font-medium text-white">
          {result.verdict}
        </span>
        <span className="font-mono text-[11px] text-neutral-500">
          {result.because}
        </span>
      </div>

      <div className="space-y-2">
        {Object.values(result.answers).map((verdict) => (
          <div key={verdict.id} className="space-y-1">
            <div className="font-mono text-[11px] text-neutral-600">
              {verdictReasoning(verdict)}
            </div>
            {/* The distribution, not just the winner. A 0.51/0.49 split and a
                0.99/0.01 one produce the same verdict and are not the same
                answer — which is the whole reason to use a decider rather than
                asking a chat model to pick. */}
            <div className="space-y-0.5">
              {verdict.distribution.map((entry) => (
                <div key={entry.key} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate text-right font-mono text-[10px] text-neutral-400">
                    {entry.key}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200">
                    <span
                      className={cn(
                        'block h-full rounded-full',
                        entry.probability >= 0.5
                          ? 'bg-neutral-700'
                          : 'bg-neutral-400',
                      )}
                      style={{ width: `${Math.round(entry.probability * 100)}%` }}
                    />
                  </span>
                  <span className="w-10 shrink-0 text-right font-mono text-[10px] text-neutral-500">
                    {entry.probability.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* What ACTUALLY answered. A floating provider id (a `-latest` alias) can move, so a pinned agent can
          change behaviour with no version bump anywhere — this is the only
          place the playground can say which model the answer came from. */}
      {result.modelId ? (
        <p className="text-[11px] text-neutral-400">
          Answered by <span className="font-mono">{result.modelId}</span>
          {result.usage?.inputTokens != null
            ? ` · ${result.usage.inputTokens + (result.usage.outputTokens ?? 0)} tokens`
            : null}
        </p>
      ) : null}
    </div>
  )
}

/**
 * What a node would judge for this text. A node judges whatever its `source`
 * binds — often an object — so text that parses as a JSON object or array is
 * sent as that value; anything else is the string itself.
 */
function parseSubject(text: string): unknown {
  return parseLooseJson({ text, structuredOnly: true })
}
