import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Reading `topics/**/*.md` off disk — shared by `build.ts`, which embeds them,
// and `docs.test.ts`, which checks the embedded copy is current. Never imported
// at run time: the served docs come from `sources.generated.ts`.

export const TOPICS_DIR = join(import.meta.dirname, 'topics')

/** Every topic file, keyed by its id (path under `topics/`, no extension). */
export function readTopicSources(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (entry.endsWith('.md')) {
        const id = relative(TOPICS_DIR, full)
          .slice(0, -'.md'.length)
          .split(sep)
          .join('/')
        out[id] = readFileSync(full, 'utf8')
      }
    }
  }
  walk(TOPICS_DIR)
  return out
}
