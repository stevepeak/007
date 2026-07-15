import { useSyncExternalStore } from 'react'

import {
  MOCK_EVAL_SETS,
  MOCK_SAMPLES,
  type MockTargetKind,
} from './mock-data'

// ─────────────────────────────────────────────────────────────────────────────
// MOCK STORE — an in-memory, versioned stand-in for the Evals data layer.
//
// NOT a database. State lives in module memory and resets on page reload. It
// exists so we can build and feel the create/edit/archive + versioning UX before
// the real wf_eval_* schema lands (docs/evals-plan.md, Phase 2). To go live:
// delete this file + mock-data.ts and swap the getters/mutations below for real
// query + mutation hooks. Nothing outside src/ui/evals imports from here.
//
// Model (per the locked decision):
//   • Goal  — a FOLDER. Not versioned. create / rename / archive.
//   • Sample — its own version lineage. Save mints version N+1. Holds the
//     sample's own fields (name, kind, target, summary, givens). Test membership
//     is LIVE (tests parented by sampleId), so editing a test never bumps the
//     sample.
//   • Test  — its own version lineage. Save mints version N+1.
// ─────────────────────────────────────────────────────────────────────────────

type TargetKind = MockTargetKind

export type Given = { id: string; label: string; value: string }

export type SampleConfig = {
  name: string
  kind: TargetKind
  targetName: string
  summary: string
  given: Given[]
}
export type SampleVersion = {
  version: number
  createdAt: number
  config: SampleConfig
}
export type Sample = {
  id: string
  goalId: string
  archived: boolean
  /** Demo-only decoration of the last run's outcome (seed data only). */
  lastResult?: { status: 'pass' | 'fail'; score: number | null }
  versions: SampleVersion[]
}

export type TestFamily = 'binary' | 'scored'
export type TestConfig = {
  family: TestFamily
  /** e.g. tool_called, node_visited, output_match, llm_judge. */
  type: string
  /** Human phrasing of the assertion — doubles as the test's name/title. */
  label: string
  /** Optional longer description of what this test checks. */
  description?: string
  // Scored (llm_judge) config — absent on binary tests.
  rubric?: string
  threshold?: number
  weight?: number
  model?: string
}
export type TestVersion = {
  version: number
  createdAt: number
  config: TestConfig
}
export type Test = {
  id: string
  sampleId: string
  archived: boolean
  /** Demo-only decoration of the last verdict (seed data only). */
  lastVerdict?: { pass: boolean; score?: number | null; reason?: string }
  versions: TestVersion[]
}

export type Goal = {
  id: string
  name: string
  description: string
  archived: boolean
  /** Demo-only decoration of the last run (seed data only). */
  lastRun?: { at: string; passed: number; total: number; score: number | null }
}

type State = { goals: Goal[]; samples: Sample[]; tests: Test[] }

// Fixed timestamp for seeded v1 rows so seed data looks pre-existing.
const SEED_TS = Date.parse('2026-07-14T12:00:00Z')

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
}

function now(): number {
  return Date.now()
}

// Build the initial mutable state by transforming the static seed in mock-data.
function buildSeed(): State {
  const goals: Goal[] = MOCK_EVAL_SETS.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    archived: false,
    lastRun: g.lastRun ?? undefined,
  }))

  const samples: Sample[] = []
  const tests: Test[] = []

  for (const [goalId, list] of Object.entries(MOCK_SAMPLES)) {
    for (const smp of list) {
      samples.push({
        id: smp.id,
        goalId,
        archived: false,
        lastResult: smp.lastResult ?? undefined,
        versions: [
          {
            version: 1,
            createdAt: SEED_TS,
            config: {
              name: smp.name,
              kind: smp.kind,
              targetName: smp.targetName,
              summary: smp.summary,
              given: smp.given.map((g) => ({
                id: uid('gv'),
                label: g.label,
                value: g.value,
              })),
            },
          },
        ],
      })

      for (const c of smp.checks) {
        const scored = c.family === 'scored'
        tests.push({
          id: c.id,
          sampleId: smp.id,
          archived: false,
          lastVerdict: c.verdict,
          versions: [
            {
              version: 1,
              createdAt: SEED_TS,
              config: {
                family: c.family,
                type: c.type,
                label: c.label,
                ...(scored
                  ? { rubric: c.label, threshold: 0.7, weight: 1, model: 'default' }
                  : {}),
              },
            },
          ],
        })
      }
    }
  }

  return { goals, samples, tests }
}

const state: State = buildSeed()

// ── Reactivity (module singleton via useSyncExternalStore) ───────────────────

let revision = 0
const listeners = new Set<() => void>()

function emit() {
  revision += 1
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
function getRevision() {
  return revision
}

/** Subscribe a component to store changes. Read via the getters below. */
export function useEvalsRevision(): number {
  return useSyncExternalStore(subscribe, getRevision, getRevision)
}

// ── Version helpers ──────────────────────────────────────────────────────────

export function currentSampleVersion(s: Sample): SampleVersion {
  return s.versions[s.versions.length - 1]
}
export function currentTestVersion(t: Test): TestVersion {
  return t.versions[t.versions.length - 1]
}

// ── Reads ────────────────────────────────────────────────────────────────────

export function listGoals(): Goal[] {
  return state.goals.filter((g) => !g.archived)
}
export function getGoal(id: string): Goal | undefined {
  return state.goals.find((g) => g.id === id)
}
export function listSamples(goalId: string): Sample[] {
  return state.samples.filter((s) => s.goalId === goalId && !s.archived)
}
export function getSample(id: string): Sample | undefined {
  return state.samples.find((s) => s.id === id)
}
export function listTests(sampleId: string): Test[] {
  return state.tests.filter((t) => t.sampleId === sampleId && !t.archived)
}
export function getTest(id: string): Test | undefined {
  return state.tests.find((t) => t.id === id)
}

// ── Goal mutations (folder — not versioned) ──────────────────────────────────

export function createGoal(input: { name: string; description: string }): string {
  const goal: Goal = {
    id: uid('goal'),
    name: input.name.trim() || 'Untitled goal',
    description: input.description.trim(),
    archived: false,
  }
  state.goals.push(goal)
  emit()
  return goal.id
}
export function updateGoal(
  id: string,
  patch: { name?: string; description?: string },
): void {
  const g = getGoal(id)
  if (!g) return
  if (patch.name != null) g.name = patch.name
  if (patch.description != null) g.description = patch.description
  emit()
}
export function archiveGoal(id: string): void {
  const g = getGoal(id)
  if (!g) return
  g.archived = true
  emit()
}

// ── Sample mutations (versioned) ─────────────────────────────────────────────

const DEFAULT_SAMPLE_CONFIG: SampleConfig = {
  name: 'Untitled sample',
  kind: 'agent',
  targetName: '',
  summary: '',
  given: [],
}

export function createSample(goalId: string): string {
  const id = uid('smp')
  state.samples.push({
    id,
    goalId,
    archived: false,
    versions: [
      { version: 1, createdAt: now(), config: { ...DEFAULT_SAMPLE_CONFIG } },
    ],
  })
  emit()
  return id
}
/** Save the sample's config as a new immutable version. Returns the new number. */
export function saveSample(id: string, config: SampleConfig): number | undefined {
  const s = getSample(id)
  if (!s) return
  const version = currentSampleVersion(s).version + 1
  s.versions.push({ version, createdAt: now(), config })
  emit()
  return version
}
export function archiveSample(id: string): void {
  const s = getSample(id)
  if (!s) return
  s.archived = true
  emit()
}

// ── Test mutations (versioned) ───────────────────────────────────────────────

const DEFAULT_TEST_CONFIG: TestConfig = {
  family: 'binary',
  type: 'tool_called',
  label: 'New test',
}

export function createTest(sampleId: string): string {
  const id = uid('tst')
  state.tests.push({
    id,
    sampleId,
    archived: false,
    versions: [
      { version: 1, createdAt: now(), config: { ...DEFAULT_TEST_CONFIG } },
    ],
  })
  emit()
  return id
}
/** Save the test's config as a new immutable version. Returns the new number. */
export function saveTest(id: string, config: TestConfig): number | undefined {
  const t = getTest(id)
  if (!t) return
  const version = currentTestVersion(t).version + 1
  t.versions.push({ version, createdAt: now(), config })
  emit()
  return version
}
export function archiveTest(id: string): void {
  const t = getTest(id)
  if (!t) return
  t.archived = true
  emit()
}
