import { simulateReadableStream } from 'ai'
import type { MockLanguageModelV3 } from 'ai/test'

// Typed shapes for `MockLanguageModelV3`, derived from the constructor rather
// than imported from `@ai-sdk/provider` (not a direct dependency of this
// package). Deriving them also means an SDK bump moves these types with it.
type MockCtor = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>
type DoGenerate = NonNullable<MockCtor['doGenerate']>
type GenerateFn = Extract<DoGenerate, (...args: never[]) => unknown>

/** The exact object a mocked `doGenerate` must return. */
export type MockGenerateResult = Awaited<ReturnType<GenerateFn>>
export type MockUsage = MockGenerateResult['usage']

/**
 * Build a provider-protocol usage record from plain input/output token counts.
 *
 * `LanguageModelV3Usage` is NOT two numbers — since the v3 provider protocol it
 * is two breakdown objects (`{ total, noCache, cacheRead, cacheWrite }` and
 * `{ total, text, reasoning }`). Mocks written against the old flat shape
 * (`{ inputTokens: 1, outputTokens: 1, totalTokens: 2 }`) type-error, and at run
 * time the SDK's normalisation reads `undefined` off them — which is what makes
 * a mocked multi-turn agent stop after one turn with `finishReason: undefined`.
 *
 * Note the `ai` package flattens this back to plain numbers before the engine
 * sees it, so only provider-level mocks need the breakdown shape; production
 * code reading `usage.inputTokens` as a number is correct.
 */
export function mockUsage(inputTokens = 1, outputTokens = 1): MockUsage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: 0,
    },
  }
}

/**
 * Build a provider-protocol finish reason.
 *
 * Like {@link mockUsage}, this is no longer the bare string it once was: the v3
 * provider protocol wraps it as `{ unified }` (plus an optional provider-native
 * `raw`). A mock returning the plain `'stop'` type-errors, and at run time the
 * SDK reads `.unified` off a string and gets `undefined` — which surfaces as an
 * agent that stops after a single turn reporting `finish reason: undefined`.
 */
export function mockFinish(
  unified: MockGenerateResult['finishReason']['unified'],
): MockGenerateResult['finishReason'] {
  // `raw` is declared `string | undefined`, not optional — it must be present.
  return { unified, raw: unified }
}

type DoStream = NonNullable<MockCtor['doStream']>
type StreamFn = Extract<DoStream, (...args: never[]) => unknown>

/** The exact object a mocked `doStream` must return. */
export type MockStreamResult = Awaited<ReturnType<StreamFn>>
/** One provider-protocol chunk of that stream. */
export type MockStreamPart =
  MockStreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

/**
 * Build a mocked `doStream` result from a list of provider-protocol chunks.
 *
 * The streaming path is driven by `streamText`, which behaves materially
 * differently from `generateText` on failure — it never rejects, it reports the
 * fault as an `error` chunk, and it resolves `text` to the empty string. That
 * divergence is only reachable through `doStream`, so a mock that stubs
 * `doGenerate` (as every other agent test does) cannot exercise it at all.
 *
 * Delays are zeroed: the chunks are already in memory and the tests assert on
 * the drained result, so simulated pacing would only slow the suite down.
 */
export function mockStream(chunks: MockStreamPart[]): MockStreamResult {
  return {
    stream: simulateReadableStream({
      chunks,
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  }
}
