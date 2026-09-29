import { mock } from 'bun:test'

// `bun test`'s stand-in for `cloudflare:workflows`.
//
// That specifier is a Workers runtime built-in: it resolves inside a Worker and
// nowhere else, so a plain `bun test` cannot even load a module that imports
// `NonRetryableError` from it. That is the whole reason the durable dispatch had
// no tests — not its size, but that its module graph wouldn't load. Registering a
// shim for the specifier makes `src/cloudflare` testable; everything else about
// those modules is ordinary TypeScript.
//
// Wired in as a `[test] preload` in `bunfig.toml`, so it applies to the whole
// suite and no individual test has to remember it. It is NOT part of the build:
// `mock.module` exists only under `bun test`, and the production bundle resolves
// the real built-in inside the Worker.
//
// `NonRetryableError` is the only value anything imports from there. Everything
// else (`WorkflowStep`, `WorkflowStepConfig`) is `import type`, which is erased
// before it can need resolving.
void mock.module('cloudflare:workflows', () => ({
  // Subclassing Error is what the real one does, and the only property the
  // dispatch relies on: `instanceof Error`, and a readable `message`.
  NonRetryableError: class NonRetryableError extends Error {
    override name = 'NonRetryableError'
  },
}))
