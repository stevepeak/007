import type { ModelFactory, RunContext, WfSdkConfig } from './config'

/**
 * The node-facing {@link ModelFactory} for one run: the host's `getModel` with
 * the run context bound in and every per-call option forwarded.
 *
 * Every backend (inline executor, durable dispatch, iteration items, the agent
 * playground) builds its factory here, so a new `ModelFactory` option reaches
 * the host on all of them or none.
 *
 * Precedence: the caller's `reasoning` wins over the run-level intent. Web
 * search is per-AGENT, never run-wide: only an agent node that passes its own
 * setting turns it on for its calls.
 */
export function bindModelFactory(args: {
  getModel: WfSdkConfig<unknown>['getModel']
  runContext: RunContext
}): ModelFactory {
  const { getModel, runContext } = args
  return (modelId, opts) => {
    return getModel(modelId, {
      ...runContext,
      reasoning: opts?.reasoning ?? runContext.reasoning,
      webSearch: opts?.webSearch,
      webCitations: opts?.webCitations,
    })
  }
}
