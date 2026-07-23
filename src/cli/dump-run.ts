#!/usr/bin/env bun
/**
 * `wf-dump-run` — dump everything about a workflow run into one debug bundle.
 *
 * Client-agnostic: ships with @stevepeak/007, so any host that uses the SDK can
 * run it with no per-project script. Paste a run URL (localhost or prod) or a
 * bare run id. Reads the run row, every `wf_run_step` (input/output/meta/error —
 * meta holds the LLM prompts, reasoning and tool I/O) and the `wf_run_log` feed,
 * then prints a readable summary that leads with the failed nodes and the Sentry
 * trace deep-link. A full JSON bundle is written to a temp file so an agent can
 * read the whole thing.
 *
 *   bunx wf-dump-run <run-url-or-id>            # local .wrangler D1 (default)
 *   bunx wf-dump-run <run-url-or-id> --prod     # remote D1 over REST
 *   bunx wf-dump-run <run-url-or-id> --json     # also print full JSON to stdout
 *   bunx wf-dump-run <run-url-or-id> --out=x.json
 *
 * Env:
 *   SENTRY_ORG                 org slug for the trace deep-link (else no URL)
 *   SENTRY_TRACE_URL_TEMPLATE  override URL shape ({org}/{traceId} placeholders)
 *   --prod needs CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_API_TOKEN.
 *
 * Host-agnostic on purpose: the Sentry org and D1 target come from env, and the
 * local D1 path is the standard miniflare location every SDK host shares.
 */

import { readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import { createWfDbHttp, getRun, wfSchema, type WfDb } from '../storage'

const D1_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'

// Accept a full run URL (…/runs/<id>) or a bare id; pull the first UUID.
function parseRunId(arg: string): string {
  const m = arg.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )
  if (!m) throw new Error(`Could not find a run id in "${arg}".`)
  return m[0]
}

// Build the Sentry trace deep-link from env. Returns null when no org is
// configured — the host owns the URL shape, so we never bake in a default.
function sentryTraceUrl(traceId: string): string | null {
  const template = process.env.SENTRY_TRACE_URL_TEMPLATE
  const org = process.env.SENTRY_ORG
  if (template) {
    return template
      .replaceAll('{org}', org ?? '')
      .replaceAll('{traceId}', traceId)
  }
  if (!org) return null
  return `https://${org}.sentry.io/explore/traces/trace/${traceId}/?statsPeriod=90d&source=traces`
}

// Miniflare stores each D1 db as a hash-named sqlite file; pick the one with the
// wf_* schema. Same standard path every SDK host uses.
function openLocalDb(): WfDb {
  let files: string[]
  try {
    files = readdirSync(D1_DIR).filter(
      (f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite',
    )
  } catch {
    throw new Error(
      `No local D1 dir at ${D1_DIR}. Start the app first, or pass --prod.`,
    )
  }
  for (const f of files) {
    const sqlite = new Database(join(D1_DIR, f))
    const hasWf = sqlite
      .query("select 1 from sqlite_master where type='table' and name='wf_run'")
      .get()
    if (hasWf) return drizzle(sqlite, { schema: wfSchema }) as unknown as WfDb
    sqlite.close()
  }
  throw new Error(`No local D1 file in ${D1_DIR} has the wf_* tables.`)
}

function openProdDb(): WfDb {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const databaseId = process.env.D1_DATABASE_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !databaseId || !token) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and CLOUDFLARE_API_TOKEN are required for --prod.',
    )
  }
  return createWfDbHttp({ accountId, databaseId, token })
}

function fmtTs(ts: Date | number | null | undefined): string {
  if (ts == null) return '—'
  if (ts instanceof Date) return ts.toISOString()
  const ms = ts < 1e12 ? ts * 1000 : ts
  return new Date(ms).toISOString()
}

function ms(ts: Date | number | null | undefined): number | null {
  if (ts == null) return null
  return ts instanceof Date ? ts.getTime() : ts
}

function pretty(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  return JSON.stringify(value, null, 2)
}

function truncate(s: string, n = 2000): string {
  return s.length > n
    ? `${s.slice(0, n)}\n…[${s.length - n} more chars — see JSON bundle]`
    : s
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const target = args.find((a) => !a.startsWith('--'))
  if (!target) {
    console.error(
      'Usage: wf-dump-run <run-url-or-id> [--prod] [--json] [--out=file]',
    )
    process.exit(1)
  }
  const prod = args.includes('--prod')
  const asJson = args.includes('--json')
  const outArg = args
    .find((a) => a.startsWith('--out='))
    ?.slice('--out='.length)

  const runId = parseRunId(target)
  const db = prod ? openProdDb() : openLocalDb()
  const bundle = await getRun(db, runId)
  if (!bundle) {
    console.error(`Run ${runId} not found in ${prod ? 'prod' : 'local'} D1.`)
    process.exit(1)
  }

  const { run, steps, logs, workflowName, versionNumber, costUsd, totalTokens } =
    bundle

  const outFile = outArg ?? join(tmpdir(), `run-${runId}.json`)
  writeFileSync(outFile, JSON.stringify(bundle, null, 2))
  if (asJson) console.log(JSON.stringify(bundle, null, 2))

  const traceUrl = run.sentryTraceId ? sentryTraceUrl(run.sentryTraceId) : null

  const L: string[] = []
  L.push(`\n━━━ RUN ${runId} ━━━`)
  L.push(`workflow:   ${workflowName ?? '?'} (v${versionNumber ?? '?'})`)
  L.push(`status:     ${run.status}   trigger: ${run.triggerKind}`)
  L.push(
    `started:    ${fmtTs(run.startedAt)}   finished: ${fmtTs(run.finishedAt)}`,
  )
  const costStr = costUsd == null ? '—' : `$${Number(costUsd).toFixed(4)}`
  L.push(`tokens:     ${totalTokens ?? '—'}   cost: ${costStr}`)
  L.push(`cf run id:  ${run.cloudflareRunId ?? '—'}`)
  L.push(`sentry:     ${run.sentryTraceId ?? '—'}`)
  if (traceUrl) L.push(`  → ${traceUrl}`)
  else if (run.sentryTraceId) L.push(`  (set SENTRY_ORG for a trace deep-link)`)
  if (run.error) L.push(`run error:  ${truncate(pretty(run.error), 600)}`)

  L.push(`\n─── STEPS (${steps.length}) ───`)
  for (const s of steps) {
    const start = ms(s.startedAt)
    const end = ms(s.finishedAt)
    const dur = start != null && end != null ? `${end - start}ms` : '—'
    const item = s.itemIndex == null ? '' : ` [item ${s.itemIndex}]`
    const mark =
      s.status === 'failed' ? '✕' : s.status === 'completed' ? '✓' : '·'
    L.push(
      `  ${mark} #${s.sequence} ${s.nodeKind.padEnd(8)} ${s.nodeId.slice(0, 8)}${item}  ${s.status.padEnd(9)} ${dur}`,
    )
  }

  const failed = steps.filter((s) => s.status === 'failed')
  if (failed.length > 0) {
    L.push(`\n─── FAILED STEP DETAIL ───`)
    for (const s of failed) {
      L.push(`\n▼ #${s.sequence} ${s.nodeKind} ${s.nodeId.slice(0, 8)}`)
      L.push(`  error:\n${truncate(pretty(s.error), 4000)}`)
      L.push(`  input:\n${truncate(pretty(s.input), 1200)}`)
      if (s.meta && JSON.stringify(s.meta) !== '{}') {
        L.push(`  meta:\n${truncate(pretty(s.meta), 2000)}`)
      }
    }
  }

  const noteLogs = logs.filter(
    (lg) => lg.level === 'error' || lg.level === 'warn',
  )
  if (noteLogs.length > 0) {
    L.push(`\n─── LOG FEED (errors/warnings) ───`)
    for (const lg of noteLogs) {
      L.push(`  [${lg.level}] ${truncate(lg.message, 400)}`)
    }
  }

  L.push(`\nFull JSON bundle → ${outFile}`)
  if (traceUrl) {
    L.push(`Next: pull the Sentry trace ${run.sentryTraceId} for the spans.`)
  }
  console.log(L.join('\n'))
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
