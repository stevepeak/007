// Thin abstraction over a live progress channel (e.g. the RunRoom Durable
// Object) so the engine can publish progress without a hard dependency on the
// DO type. The Cloudflare backend passes an adapter that forwards to
// `RunRoom.append(channel, text)`; tests pass an in-memory recorder.
export interface StreamSink {
  append: (channel: string, text: string) => Promise<void> | void
}

// A no-op sink for executions that don't need progress (e.g. unit tests for a
// graph that has no streaming Agent node).
export const noopSink: StreamSink = {
  append: () => {
    /* discard */
  },
}

// In-memory sink useful for tests / debugging. Captures every (channel, text)
// pair in order so assertions can inspect what would have been streamed.
export function createMemorySink(): StreamSink & {
  events: { channel: string; text: string }[]
} {
  const events: { channel: string; text: string }[] = []
  return {
    events,
    append: (channel, text) => {
      events.push({ channel, text })
    },
  }
}
