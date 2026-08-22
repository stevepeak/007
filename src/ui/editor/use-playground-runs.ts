import { useMemo, useRef, useState } from 'react'

import { agentInputVariables, type AgentConfig } from '../../engine'
import type {
  AgentPreviewMessage,
  AgentPreviewResult,
  JsonSchema,
  ToolOption,
} from '../../server/protocol'
import { useRunAgentPreview, useToolContextFields, useTools } from '../hooks'
import { toText } from '../to-text'

import {
  contextFieldsFor,
  filledContext,
  missingContext,
  requiredContextKeys,
} from './agent-editor-context'
import { defaultsToLive } from './agent-editor-tool-modes'

// Everything the Playground knows. The panel next door is the layout.
//
// The load-bearing idea here is that a run is a SNAPSHOT: config, inputs, live
// tool ids and run context are all frozen at submit time and kept on the run's
// own record. That is what makes the panel's purpose — "run, edit, run, compare
// the two answers" — actually work, and why nothing below reads current state
// once a run is in flight.

function agentInputSchema(
  variables: string[],
  /** The agent works on a conversation, so this box is the newest turn. */
  conversational: boolean,
): JsonSchema {
  const names = variables.length > 0 ? variables : ['input']
  return {
    type: 'object',
    required: names,
    properties: Object.fromEntries(
      names.map((name) => [
        name,
        {
          type: 'string',
          title:
            variables.length > 0
              ? name
              : conversational
                ? 'New message'
                : 'Test input',
          format: 'textarea',
        },
      ]),
    ),
  }
}


/** One playground run, kept in the editor's history until the page is left. */
export type PlaygroundRun = {
  id: number
  startedAt: number
  status: 'running' | 'done' | 'error'
  /**
   * The exact draft this run executed, frozen. `config` is only ever replaced
   * wholesale by the editor's `patch`, so holding the reference IS the snapshot
   * — and it's what makes a run restorable: a result is only evidence if you can
   * get back to the configuration that produced it.
   */
  config: AgentConfig
  /** What was submitted — one entry per prompt variable, or `input`. */
  input: Record<string, string>
  /** The prior turns this run was given, if the agent works on a conversation. */
  messages: AgentPreviewMessage[]
  /**
   * The run scope the live tools were given (client org, chat thread). Frozen
   * with the rest: "found nothing" means something different depending on which
   * client the search was pointed at.
   */
  context: Record<string, string>
  /**
   * The tools that ran FOR REAL in this run (everything else was faked). Part of
   * the record because "the agent found nothing" means something very different
   * depending on whether the search actually happened.
   */
  liveToolIds: string[]
  result: AgentPreviewResult | null
  error: string | null
}


export function usePlaygroundRuns(config: AgentConfig) {
  // Both prompts, since either can declare a variable and both interpolate from
  // one bag — the same union a workflow node has to bind.
  const variables = useMemo(() => agentInputVariables(config), [config])
  const hasVars = variables.length > 0
  // A conversation agent gets a thread to run against. A task agent has no
  // free-text turn to type: its message IS `userPrompt`, and filling the
  // variables below is exactly what a node's bindings do at run time.
  const conversational = config.inputKind === 'conversation'
  const schema = useMemo(
    () => agentInputSchema(variables, conversational),
    [variables, conversational],
  )
  // The turns BEFORE the message being sent. Kept across runs so you can send a
  // follow-up without retyping the thread that set it up.
  const [history, setHistory] = useState<AgentPreviewMessage[]>([])

  const run = useRunAgentPreview()
  // The agent's attached tools, resolved to their registry metadata (name, icon,
  // and the `sideEffect` tag the live/simulated default is drawn from). Ids the
  // registry no longer knows are dropped — they can't be run either way.
  const allTools = useTools().data
  const attachedTools = useMemo(() => {
    const byId = new Map((allTools ?? []).map((t) => [t.id, t]))
    return config.toolIds
      .map((id) => byId.get(id))
      .filter((t): t is ToolOption => t !== undefined && t.kind === 'ai-tool')
  }, [allTools, config.toolIds])

  // Explicit per-tool choices only. Everything else falls back to the tool's
  // default, so attaching a tool picks up the right mode without any bookkeeping
  // here, and removing one leaves no stale entry behind that matters.
  const [toolModes, setToolModes] = useState<Record<string, boolean>>({})
  const liveTools = useMemo(() => {
    const set = new Set<string>()
    for (const t of attachedTools) {
      if (toolModes[t.id] ?? defaultsToLive(t)) set.add(t.id)
    }
    return set
  }, [attachedTools, toolModes])

  // The ambient run scope this run needs — the union of what the LIVE tools
  // declare (`requiresContext`), resolved to the host's own field definitions.
  // Simulated tools ask for nothing, so an all-simulated run stays one click.
  const contextFields = useToolContextFields().data
  const [context, setContext] = useState<Record<string, string>>({})
  const neededContext = useMemo(
    () =>
      contextFieldsFor(
        contextFields ?? [],
        requiredContextKeys(attachedTools, liveTools),
      ),
    [contextFields, attachedTools, liveTools],
  )
  // Blocking the run is the point: an unscoped live tool doesn't fail, it
  // matches nothing and reports "found nothing" — the one answer you must never
  // be shown while judging whether an agent works.
  const missing = useMemo(
    () => missingContext(neededContext, context),
    [neededContext, context],
  )
  // Every run this session, newest first. Each keeps its own status, result and
  // config, so comparing two prompts is "run, edit, run" and both answers stay
  // on screen — the previous behaviour showed only the latest, which made the
  // comparison the whole panel exists for impossible.
  const [runs, setRuns] = useState<PlaygroundRun[]>([])
  // Accordion: a new run opens itself and collapses the rest, so the column
  // doesn't grow without bound as runs pile up.
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const nextIdRef = useRef(1)
  const pending = runs.some((r) => r.status === 'running')

  function onRun(values: Record<string, unknown>) {
    const input: Record<string, string> = hasVars
      ? Object.fromEntries(
          variables.map((v) => [v, toText(values[v]).trim()]),
        )
      : { input: toText(values.input).trim() }

    const id = nextIdRef.current++
    const snapshot = config
    // Frozen with the config: the modes at submit time are what this run means.
    const liveToolIds = [...liveTools]
    // Empty turns are scaffolding, not context — drop them rather than feeding
    // the model a blank message. Gated on the flag so a thread left over from
    // toggling "works on a conversation" off can't silently reach the run.
    const messages = conversational
      ? history.filter((m) => m.text.trim().length > 0)
      : []
    // Only the keys this run's live tools asked for — a value left over from a
    // tool that's since been switched to simulated isn't part of this run.
    const runContext = filledContext(neededContext, context)
    setRuns((prev) => [
      {
        id,
        startedAt: Date.now(),
        status: 'running',
        config: snapshot,
        input,
        messages,
        context: runContext,
        liveToolIds,
        result: null,
        error: null,
      },
      ...prev,
    ])
    setExpandedId(id)

    // `mutateAsync` rather than `mutate` because the result has to land on THIS
    // run's card: the mutation object only ever holds the most recent call's
    // data, which a second run would overwrite.
    void run
      .mutateAsync(
        hasVars
          ? {
              config: snapshot,
              promptVariables: input,
              liveToolIds,
              messages,
              context: runContext,
            }
          : {
              config: snapshot,
              input: input.input,
              liveToolIds,
              messages,
              context: runContext,
            },
      )
      .then(
        (result) =>
          setRuns((prev) =>
            prev.map((r) =>
              r.id === id ? { ...r, status: 'done', result } : r,
            ),
          ),
        (err: unknown) =>
          setRuns((prev) =>
            prev.map((r) =>
              r.id === id
                ? {
                    ...r,
                    status: 'error',
                    error: err instanceof Error ? err.message : String(err),
                  }
                : r,
            ),
          ),
      )
  }


  return {
    variables,
    hasVars,
    conversational,
    schema,
    history,
    setHistory,
    attachedTools,
    liveTools,
    setToolModes,
    contextFields: contextFields ?? [],
    context,
    setContext,
    neededContext,
    missing,
    runs,
    expandedId,
    setExpandedId,
    pending,
    onRun,
  }
}
