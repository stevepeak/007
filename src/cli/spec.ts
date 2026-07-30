#!/usr/bin/env bun
/**
 * `wf-spec` — export / import / diff the portable agent+workflow+eval spec.
 *
 * Ships with @stevepeak/007, so any host uses it with no per-project script —
 * it replaces hand-written seed files. Specs live in a version-controlled
 * directory (default `./specs`) as one JSON file per entity:
 *
 *   specs/
 *     _meta.json                 { "formatVersion": 1 }
 *     agents/<slug>.json
 *     workflows/<slug>.json
 *     evals/<slug>.json
 *
 * Commands:
 *   bunx wf-spec export                 # DB → specs/  (default: local D1)
 *   bunx wf-spec export --remote        # prod D1 → specs/
 *   bunx wf-spec import                 # specs/ → local D1 (reconcile)
 *   bunx wf-spec import --remote        # specs/ → prod D1
 *   bunx wf-spec import --dry-run       # show what WOULD change, write nothing
 *   bunx wf-spec import --prune         # also archive entities absent from specs
 *   bunx wf-spec diff                   # nonzero exit if DB ≠ specs (CI guard)
 *
 * Flags: --dir=<path> (default ./specs), --note="…" (change note on publishes),
 *        --actor=<who>.
 *
 * DB target: local reads the miniflare `.wrangler/state` sqlite (start the app
 * or run migrations first). `--remote` needs CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_API_TOKEN and a database id (env D1_DATABASE_ID / CF_D1_DATABASE_ID
 * or --db-id=<id>). No id is baked in — 007 is host-agnostic.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import {
  createWfDbHttp,
  exportBundle,
  importBundle,
  specBundleSchema,
  SPEC_FORMAT_VERSION,
  wfSchema,
  type ChangeReport,
  type SpecBundle,
  type WfDb,
} from '../storage'

const D1_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'

// ── DB targets ───────────────────────────────────────────────────────────────

function openLocalDb(): { db: WfDb; close: () => void } {
  let files: string[]
  try {
    files = readdirSync(D1_DIR).filter(
      (f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite',
    )
  } catch {
    throw new Error(
      `No local D1 dir at ${D1_DIR}. Start the app or run migrations first.`,
    )
  }
  for (const f of files) {
    const sqlite = new Database(join(D1_DIR, f))
    const hasWf = sqlite
      .query("select 1 from sqlite_master where type='table' and name='wf_agent'")
      .get()
    if (hasWf) {
      return {
        db: drizzle(sqlite, { schema: wfSchema }) as unknown as WfDb,
        close: () => sqlite.close(),
      }
    }
    sqlite.close()
  }
  throw new Error(`No local D1 file in ${D1_DIR} has the wf_* tables.`)
}

function openRemoteDb(dbId: string | undefined): { db: WfDb; close: () => void } {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const databaseId =
    dbId ?? process.env.D1_DATABASE_ID ?? process.env.CF_D1_DATABASE_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !databaseId || !token) {
    throw new Error(
      'For --remote: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and a ' +
        'database id (D1_DATABASE_ID / CF_D1_DATABASE_ID or --db-id=<id>) are required.',
    )
  }
  return { db: createWfDbHttp({ accountId, databaseId, token }), close: () => {} }
}

// ── Spec directory IO ──────────────────────────────────────────────────────────

const SUBDIRS = ['agents', 'workflows', 'evals'] as const

function writeSpecDir(dir: string, bundle: SpecBundle): void {
  // Mirror the DB exactly: clear each subdir's JSON, then rewrite. Stale files
  // (a deleted/renamed entity) don't linger.
  for (const sub of SUBDIRS) {
    const path = join(dir, sub)
    mkdirSync(path, { recursive: true })
    const stale = readdirSync(path).filter((f) => f.endsWith('.json'))
    for (const f of stale) rmSync(join(path, f))
  }
  writeJson(join(dir, '_meta.json'), { formatVersion: bundle.formatVersion })
  for (const a of bundle.agents) writeJson(join(dir, 'agents', `${a.slug}.json`), a)
  for (const w of bundle.workflows)
    writeJson(join(dir, 'workflows', `${w.slug}.json`), w)
  for (const e of bundle.evals) writeJson(join(dir, 'evals', `${e.slug}.json`), e)
}

function readSpecDir(dir: string): SpecBundle {
  const meta = tryReadJson(join(dir, '_meta.json')) as
    | { formatVersion?: number }
    | undefined
  return specBundleSchema.parse({
    formatVersion: meta?.formatVersion ?? SPEC_FORMAT_VERSION,
    agents: readSub(dir, 'agents'),
    workflows: readSub(dir, 'workflows'),
    evals: readSub(dir, 'evals'),
  })
}

function readSub(dir: string, sub: string): unknown[] {
  const path = join(dir, sub)
  let files: string[]
  try {
    files = readdirSync(path).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  return files.sort().map((f) => tryReadJson(join(path, f)))
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function tryReadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function opt(name: string): string | undefined {
  const pre = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(pre))
  return hit ? hit.slice(pre.length) : undefined
}

function summarize(report: ChangeReport): void {
  const counts = { create: 0, update: 0, archive: 0, unchanged: 0 }
  for (const c of report.changes) counts[c.action]++
  for (const c of report.changes) {
    if (c.action === 'unchanged') continue
    console.log(`  ${c.action.padEnd(9)} ${c.kind}/${c.slug}`)
  }
  console.log(
    `[wf-spec] ${counts.create} created, ${counts.update} updated, ` +
      `${counts.archive} archived, ${counts.unchanged} unchanged.`,
  )
}

async function main(): Promise<number> {
  const cmd = process.argv[2]
  const dir = opt('dir') ?? './specs'
  const remote = flag('remote')
  const target = remote ? openRemoteDb(opt('db-id')) : openLocalDb()
  const label = remote ? 'REMOTE' : 'LOCAL'

  try {
    switch (cmd) {
      case 'export': {
        console.log(`[wf-spec] export ${label} → ${dir}`)
        const bundle = await exportBundle(target.db)
        writeSpecDir(dir, bundle)
        console.log(
          `[wf-spec] wrote ${bundle.agents.length} agents, ` +
            `${bundle.workflows.length} workflows, ${bundle.evals.length} evals.`,
        )
        return 0
      }
      case 'import': {
        const dryRun = flag('dry-run')
        const suffix =
          (dryRun ? ' (dry-run)' : '') + (flag('prune') ? ' (prune)' : '')
        console.log(`[wf-spec] import ${dir} → ${label}${suffix}`)
        const bundle = readSpecDir(dir)
        const report = await importBundle(target.db, bundle, {
          dryRun,
          prune: flag('prune'),
          changeNote: opt('note'),
          actor: opt('actor'),
        })
        summarize(report)
        return 0
      }
      case 'diff': {
        console.log(`[wf-spec] diff ${dir} vs ${label}`)
        const bundle = readSpecDir(dir)
        const report = await importBundle(target.db, bundle, {
          dryRun: true,
          prune: flag('prune'),
        })
        summarize(report)
        if (!report.clean) {
          console.error('[wf-spec] DRIFT: database does not match specs.')
          return 1
        }
        console.log('[wf-spec] clean: database matches specs.')
        return 0
      }
      default:
        console.error(
          'Usage: wf-spec <export|import|diff> [--remote] [--dir=./specs] ' +
            '[--dry-run] [--prune] [--note="…"] [--actor=who] [--db-id=<id>]',
        )
        return 2
    }
  } finally {
    target.close()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[wf-spec] failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
