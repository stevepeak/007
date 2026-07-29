# Syncing agents, workflows & evals (`wf-spec`)

Agents, workflows and evals live in the database (`wf_*` tables) and are edited
in the UI. `wf-spec` is how you move that state **in and out of version
control** and **between environments** (local ↔ prod, or another host project)
— it replaces hand-written seed files.

The unit of sync is the **spec**: a flattened JSON snapshot of the *current
desired state* — the latest published version of each entity plus its identity,
metadata and trigger wiring. Version history, drafts and runs stay in the DB;
git is the history.

## The model

- **Identity is the `slug`, not the id.** Row ids are random UUIDs and differ in
  every database, so specs match on a stable, human-authored `slug`
  (`wf_agent.slug` / `wf_workflow.slug`). Export backfills a missing slug from
  the entity's name; because that's deterministic, exporting a local and a prod
  DB that were seeded from the same names produces the **same slugs**, so they
  reconcile without creating duplicates.
- **Graphs are portable.** A workflow graph references agents (and
  sub-workflows) by slug in spec form (`agentSlug` / `workflowSlug`). On import
  those are translated back to the target DB's own UUIDs, so a graph is valid in
  any environment.
- **Import is idempotent and additive.** Entities are matched by slug: missing
  ones are created, changed payloads are published as a **new immutable
  version** (history is never rewritten), unchanged specs are a no-op.

## On-disk layout

One JSON file per entity, so diffs are small and reviewable:

```
specs/
  _meta.json                     { "formatVersion": 1 }
  agents/<slug>.json
  workflows/<slug>.json
  evals/<slug>.json
```

Commit this directory. It is the source of truth that deploys apply.

## Commands

```bash
bunx wf-spec export            # DB → specs/            (default target: local D1)
bunx wf-spec import            # specs/ → DB            (reconcile)
bunx wf-spec diff              # nonzero exit if DB ≠ specs (CI / drift guard)
```

Flags:

| flag | meaning |
| --- | --- |
| `--remote` | target prod D1 instead of local (see env below) |
| `--dir=<path>` | spec directory (default `./specs`) |
| `--dry-run` | (import) print what would change, write nothing |
| `--prune` | (import) archive entities present in the DB but absent from specs |
| `--note="…"` | change note stamped on every version this import publishes |
| `--db-id=<id>` | prod D1 database id (or use env, below) |

Run from the directory that holds `.wrangler/state` (the app root). `--remote`
needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and a database id
(`D1_DATABASE_ID` / `CF_D1_DATABASE_ID` or `--db-id`).

## Workflows

**Capture a UI/AI edit into git**

```bash
bunx wf-spec export        # pulls the DB edit back into specs/
git diff specs/            # review
git add specs/ && git commit
```

**Push to production** (deploy step)

```bash
bunx wf-spec import --remote --note="release 2026-07-29"
```

Preview first with `--dry-run --remote`. Import only publishes versions for
entities that actually changed, so re-running is safe.

**Pull production back to local** (prod was hotfixed in the UI)

```bash
bunx wf-spec export --remote      # prod → specs/
git diff specs/                   # review, commit
bunx wf-spec import               # specs/ → local
```

**CI drift guard**

```bash
bunx wf-spec diff --remote        # fails the build if prod ≠ committed specs
```

## Setup / first-time bootstrap

1. Apply the migration that adds the `slug` column to every environment:
   `db:migrate:local` for local, `db:migrate` for prod. The app schema
   references `slug`, so this must run before the app starts.
2. Generate the initial `specs/` from the current DB: `bunx wf-spec export`,
   then commit. (No hand-authoring — export writes the graphs too.)
3. Replace the deploy's seed step with `bunx wf-spec import --remote`.

Each host project keeps its own `specs/` directory; the CLI is shipped by
`@stevepeak/007` and bakes in no project-specific database id.

## Scope

Synced: agents, workflows (with their trigger assignments) and evals (goal +
samples). **Not** synced: the model catalog (agent configs reference models by
string id, assumed consistent across environments), drafts, and run history.
