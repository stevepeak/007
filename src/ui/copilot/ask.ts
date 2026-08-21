'use client'

import { useSyncExternalStore } from 'react'

// "Open the Copilot with this question already typed."
//
// The Copilot rail is mounted once at the app shell (`wf-app.tsx`) and owns its
// own open/closed state, while the composer's text lives inside the assistant
// below it. A caller that wants to hand the Copilot a question — an inspector
// buried in the editor, several routed layers away — has no React path to
// either. Threading a callback down would mean widening every component between
// here and there, including the pluggable assistant's props.
//
// So this is a tiny registry instead: the panel registers "how to open me", the
// assistant registers "how to seed my composer", and any caller anywhere asks by
// module import. Deliberately NOT a window CustomEvent — a module-scoped
// registry keeps it inside the SDK's own bundle, can report whether anyone is
// listening, and doesn't leak a global name a host could collide with.
//
// Seeding stops at filling the box: the question is put in the composer for the
// user to read, edit, and send. Sending on their behalf would put words in their
// mouth and spend their tokens on a turn they never chose.

type SeedHandler = (prompt: string) => void

// At most one of each. Both the panel and the built-in assistant are singletons
// (the shell mounts one Copilot), so a second registration means a remount, and
// the newest is the live one.
let seedHandler: SeedHandler | null = null
let openHandler: (() => void) | null = null

const availabilitySubscribers = new Set<() => void>()

function notifyAvailability(): void {
  for (const fn of availabilitySubscribers) fn()
}

/**
 * Called by the built-in assistant to expose its composer. Returns the
 * unsubscribe for an effect cleanup.
 */
export function registerCopilotSeed(handler: SeedHandler): () => void {
  seedHandler = handler
  notifyAvailability()
  return () => {
    if (seedHandler === handler) {
      seedHandler = null
      notifyAvailability()
    }
  }
}

/** Called by the Copilot rail to expose "expand me". */
export function registerCopilotOpen(handler: () => void): () => void {
  openHandler = handler
  return () => {
    if (openHandler === handler) openHandler = null
  }
}

/**
 * Whether a "ask the Copilot this" affordance can work right now.
 *
 * Keyed on the SEED handler, not the panel: a host that injected its own
 * assistant (`WfSdkProvider assistant={…}`) still gets a rail that opens, but
 * nothing that knows how to accept a pre-written question — and an affordance
 * that opens an empty chat is worse than no affordance. Callers hide the link
 * when this is false.
 */
export function useCopilotSeedAvailable(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      availabilitySubscribers.add(onChange)
      return () => availabilitySubscribers.delete(onChange)
    },
    () => seedHandler !== null,
    // Server render: no assistant is mounted, so the affordance stays hidden
    // until hydration rather than flashing in and out.
    () => false,
  )
}

/** Open the Copilot rail and type `prompt` into its composer for the user. */
export function askCopilot(prompt: string): void {
  openHandler?.()
  seedHandler?.(prompt)
}
