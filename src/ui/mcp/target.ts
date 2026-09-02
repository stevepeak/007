// Which deployment the connect snippets point at, and which parts of them this
// page is in a position to know.
//
// Split out of the component because the answer has a real failure mode and
// deserves tests: render a placeholder as though it were real and someone
// pastes a hostname that does not exist into a client config, then reads a
// connection error with nothing to connect it to.

/** Which deployment the snippets point at. */
export type Target = 'development' | 'production'

/**
 * Stand-ins for the origin this page cannot know.
 *
 * 007 is whitelabeled: it has no idea what anyone's deployed hostname is, and
 * guessing would be worse than a placeholder, because a wrong URL that looks
 * plausible gets pasted. `example.com` is reserved by RFC 2606 precisely so it
 * cannot resolve to somebody's real host.
 */
export const PLACEHOLDER: Record<Target, string> = {
  development: 'http://localhost:3000',
  production: 'https://your-deployment.example.com',
}

/** Is the origin this page is being read on a local dev server? */
export function isLocalOrigin(origin: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|$)/.test(origin)
}

/**
 * The base URL for a target, and whether it is real.
 *
 * Exactly one target is ever knowable: the deployment serving this page. The
 * other is a placeholder by necessity, and saying which is which is the whole
 * point of the picker.
 */
export function resolveTarget(
  target: Target,
  origin: string,
): { url: string; known: boolean } {
  const local = isLocalOrigin(origin)
  const isCurrent = target === (local ? 'development' : 'production')
  return isCurrent
    ? { url: origin, known: true }
    : { url: PLACEHOLDER[target], known: false }
}

/**
 * Rewrite a command so nothing in it depends on a shell.
 *
 * Claude Desktop launches the process itself: it inherits no `PATH`, so a bare
 * runtime name does not resolve, and it expands no `~`, which it passes through
 * as a literal directory that does not exist. Both failures look identical from
 * the outside — the server simply never starts — so the snippet shows absolute
 * placeholders rather than a value that would work only on one machine.
 */
export function toAbsolute(command: string): string {
  return command
    .split(' ')
    .map((part, i) => {
      if (i === 0 && !part.includes('/')) return `/absolute/path/to/${part}`
      if (part.startsWith('~/')) return `/absolute/path/to/${part.slice(2)}`
      return part
    })
    .join(' ')
}
