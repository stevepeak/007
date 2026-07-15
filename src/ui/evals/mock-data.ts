// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA — demonstration only. NOT wired to any database.
//
// This whole file is a stand-in until the Evals data client lands (see
// docs/evals-plan.md, Phase 4). To go live: delete this file and replace the
// `MOCK_*` imports / helpers in the evals UI with real query hooks. Nothing else
// in the SDK imports from here, so removing it is a clean cut.
// ─────────────────────────────────────────────────────────────────────────────

export type MockTargetKind = 'agent' | 'workflow'

/** A summary of the most recent test run for a set (or null if never run). */
type MockLastRun = {
  /** Human-friendly relative time, e.g. "2h ago". Mock strings, not real dates. */
  at: string
  passed: number
  total: number
  /** Judge-only score, 0..1. Null when the set has no scored (llm_judge) checks. */
  score: number | null
}

// A set is a GOAL — agnostic of agent-vs-workflow. That distinction lives on each
// sample (a set can mix samples that test agents and samples that test workflows).
export type MockEvalSet = {
  id: string
  /** The set's goal — the human-readable thing this suite verifies. */
  name: string
  /** One-line description of the goal (catalog subtitle). */
  description: string
  /** Number of test samples in this set. */
  samples: number
  lastRun: MockLastRun | null
}

type MockSampleResult = {
  status: 'pass' | 'fail'
  /** Judge-only score for this sample, 0..1. Null when no scored checks. */
  score: number | null
}

/** One outcome check on a sample. `family` drives how a verdict is shown. */
type MockCheck = {
  id: string
  family: 'binary' | 'scored'
  /** The check type, e.g. 'tool_called', 'node_visited', 'output_match', 'llm_judge'. */
  type: string
  /** Human phrasing of the assertion. */
  label: string
  /** Last recorded verdict (absent if never run). */
  verdict?: {
    pass: boolean
    /** Present only for scored (llm_judge) checks. */
    score?: number | null
    /** Judge rationale, or an actual-value note on a failed binary check. */
    reason?: string
  }
}

export type MockSample = {
  id: string
  name: string
  /** What this sample exercises — an agent or a workflow. */
  kind: MockTargetKind
  /** The agent/workflow under test. */
  targetName: string
  /** AI-generated essence of the sample (≤ 2 sentences). */
  summary: string
  /** The "Given" — the initial state the sample runs from. */
  given: { label: string; value: string }[]
  checks: MockCheck[]
  lastResult: MockSampleResult | null
}

type MockEvalRunStatus = 'running' | 'completed' | 'failed'

export type MockEvalRun = {
  id: string
  /** Human-friendly timestamp label, e.g. "Jul 14, 3:20pm". */
  at: string
  /** Names of the eval sets included in this run. */
  sets: string[]
  status: MockEvalRunStatus
  passed: number
  total: number
  score: number | null
}

export const MOCK_EVAL_SETS: MockEvalSet[] = [
  {
    id: 'set_escalation_policy',
    name: 'Escalation Policy',
    description: 'Case events escalate to the right people at the right time.',
    samples: 3,
    lastRun: { at: '2h ago', passed: 8, total: 9, score: 0.87 },
  },
  {
    id: 'set_document_categorization',
    name: 'Document Categorization',
    description: 'Incoming documents land in the correct matter category.',
    samples: 3,
    lastRun: { at: '5h ago', passed: 13, total: 14, score: 0.92 },
  },
  {
    id: 'set_party_identification',
    name: 'Party Identification',
    description: 'Parties and their roles are extracted from filings.',
    samples: 2,
    lastRun: { at: '1d ago', passed: 7, total: 11, score: 0.71 },
  },
  {
    id: 'set_conflict_of_interest',
    name: 'Conflict of Interest',
    description: 'New matters are screened against existing clients.',
    samples: 2,
    lastRun: { at: '1d ago', passed: 8, total: 8, score: 0.9 },
  },
  {
    id: 'set_conflicting_data_detection',
    name: 'Conflicting Data Detection',
    description: 'Discrepancies across a document set are surfaced.',
    samples: 0,
    lastRun: null,
  },
]

// Per-set sample lists. Keyed by set id; a set with no entry has no samples yet.
export const MOCK_SAMPLES: Record<string, MockSample[]> = {
  set_escalation_policy: [
    {
      id: 'smp_esc_1',
      name: 'High-priority deadline missed',
      kind: 'workflow',
      targetName: 'Escalation workflow',
      summary:
        'A missed high-priority deadline should escalate to a supervising attorney. Verifies the supervisor is notified with an urgent, specific message.',
      given: [
        { label: 'caseId', value: 'C-1042' },
        { label: 'event', value: 'deadline_missed' },
        { label: 'priority', value: 'high' },
      ],
      checks: [
        {
          id: 'chk_esc_1a',
          family: 'binary',
          type: 'node_visited',
          label: 'escalate node was visited',
          verdict: { pass: true },
        },
        {
          id: 'chk_esc_1b',
          family: 'binary',
          type: 'tool_called',
          label: 'notify_supervisor was called',
          verdict: { pass: true },
        },
        {
          id: 'chk_esc_1c',
          family: 'scored',
          type: 'llm_judge',
          label: 'message conveys urgency and names the missed deadline',
          verdict: { pass: true, score: 0.91, reason: 'Clear, urgent, cites the date.' },
        },
      ],
      lastResult: { status: 'pass', score: 0.91 },
    },
    {
      id: 'smp_esc_2',
      name: 'Routine status update',
      kind: 'workflow',
      targetName: 'Escalation workflow',
      summary:
        'An ordinary low-priority status update should not escalate. Confirms the workflow logs and ends without paging anyone.',
      given: [
        { label: 'caseId', value: 'C-2231' },
        { label: 'event', value: 'status_update' },
        { label: 'priority', value: 'low' },
      ],
      checks: [
        {
          id: 'chk_esc_2a',
          family: 'binary',
          type: 'node_visited',
          label: 'escalate node was NOT visited',
          verdict: { pass: true },
        },
        {
          id: 'chk_esc_2b',
          family: 'binary',
          type: 'tool_called',
          label: 'notify_supervisor was NOT called',
          verdict: { pass: true },
        },
      ],
      lastResult: { status: 'pass', score: null },
    },
    {
      id: 'smp_esc_3',
      name: 'Opposing counsel non-response',
      kind: 'workflow',
      targetName: 'Escalation workflow',
      summary:
        'Fourteen days of silence from opposing counsel should trigger a follow-up. Expects a drafted reminder but no supervisor page.',
      given: [
        { label: 'caseId', value: 'C-1890' },
        { label: 'event', value: 'no_response' },
        { label: 'daysElapsed', value: '14' },
      ],
      checks: [
        {
          id: 'chk_esc_3a',
          family: 'binary',
          type: 'tool_called',
          label: 'draft_followup was called',
          verdict: { pass: true },
        },
        {
          id: 'chk_esc_3b',
          family: 'scored',
          type: 'llm_judge',
          label: 'follow-up is professional and references the elapsed time',
          verdict: {
            pass: false,
            score: 0.58,
            reason: 'Tone is fine but never mentions the 14-day gap.',
          },
        },
      ],
      lastResult: { status: 'fail', score: 0.58 },
    },
  ],
  set_document_categorization: [
    {
      id: 'smp_cat_1',
      name: 'Motion to dismiss',
      kind: 'agent',
      targetName: 'Categorization agent',
      summary:
        'A litigation filing should be categorized as a motion, not correspondence. Rewards a rationale that cites motion-specific language.',
      given: [
        { label: 'name', value: 'MTD_final.pdf' },
        { label: 'text', value: '"…Defendant respectfully moves this Court to dismiss…"' },
      ],
      checks: [
        {
          id: 'chk_cat_1a',
          family: 'binary',
          type: 'output_match',
          label: 'category equals "Litigation / Motion"',
          verdict: { pass: true },
        },
        {
          id: 'chk_cat_1b',
          family: 'scored',
          type: 'llm_judge',
          label: 'rationale cites motion-specific language',
          verdict: { pass: true, score: 0.95, reason: 'Quotes the operative "moves to dismiss".' },
        },
      ],
      lastResult: { status: 'pass', score: 0.95 },
    },
    {
      id: 'smp_cat_2',
      name: 'Retainer agreement',
      kind: 'agent',
      targetName: 'Categorization agent',
      summary:
        'An engagement letter should file under client-intake retainer. Confirms fee terms are recognized as contractual.',
      given: [
        { label: 'name', value: 'engagement_letter.docx' },
        { label: 'text', value: '"…this Agreement sets forth the terms of our representation…"' },
      ],
      checks: [
        {
          id: 'chk_cat_2a',
          family: 'binary',
          type: 'output_match',
          label: 'category contains "Retainer"',
          verdict: { pass: true },
        },
        {
          id: 'chk_cat_2b',
          family: 'scored',
          type: 'llm_judge',
          label: 'recognizes fee/scope terms as contractual',
          verdict: { pass: true, score: 0.9, reason: 'Identifies scope and fee clauses.' },
        },
      ],
      lastResult: { status: 'pass', score: 0.9 },
    },
    {
      id: 'smp_cat_3',
      name: 'Ambiguous cover letter',
      kind: 'agent',
      targetName: 'Categorization agent',
      summary:
        'A mixed-content cover letter could fit several categories. Rewards a defensible single choice with a clear rationale.',
      given: [
        { label: 'name', value: 'letter.pdf' },
        { label: 'text', value: '"…enclosed please find the signed release and our invoice…"' },
      ],
      checks: [
        {
          id: 'chk_cat_3a',
          family: 'binary',
          type: 'output_match',
          label: 'category is one of the allowed set',
          verdict: { pass: true },
        },
        {
          id: 'chk_cat_3b',
          family: 'scored',
          type: 'llm_judge',
          label: 'explains why the chosen category beats the alternatives',
          verdict: { pass: true, score: 0.82, reason: 'Reasonable, could weigh options more.' },
        },
      ],
      lastResult: { status: 'pass', score: 0.82 },
    },
  ],
  set_party_identification: [
    {
      id: 'smp_party_1',
      name: 'Two-party contract',
      kind: 'agent',
      targetName: 'Party extraction agent',
      summary:
        'Both contracting parties should be extracted with correct roles. No spurious parties invented.',
      given: [
        { label: 'documentId', value: 'D-5521' },
        { label: 'text', value: '"…by and between Acme Corp ("Buyer") and J. Rivera ("Seller")…"' },
      ],
      checks: [
        {
          id: 'chk_party_1a',
          family: 'binary',
          type: 'output_match',
          label: 'parties include "Acme Corp" and "J. Rivera"',
          verdict: { pass: true },
        },
        {
          id: 'chk_party_1b',
          family: 'scored',
          type: 'llm_judge',
          label: 'buyer/seller roles are correctly assigned',
          verdict: { pass: true, score: 0.88, reason: 'Roles mapped correctly.' },
        },
      ],
      lastResult: { status: 'pass', score: 0.88 },
    },
    {
      id: 'smp_party_2',
      name: 'Multi-defendant complaint',
      kind: 'agent',
      targetName: 'Party extraction agent',
      summary:
        'A plaintiff plus five Doe defendants and a named corp should all be captured. Expects the Does not to be collapsed into one.',
      given: [
        { label: 'documentId', value: 'D-6034' },
        { label: 'text', value: '"…Plaintiff v. Doe 1–5 and Acme Holdings…"' },
      ],
      checks: [
        {
          id: 'chk_party_2a',
          family: 'binary',
          type: 'output_match',
          label: 'at least 6 distinct parties extracted',
          verdict: { pass: false, reason: 'Only 3 found — Doe 1–5 collapsed to one.' },
        },
        {
          id: 'chk_party_2b',
          family: 'scored',
          type: 'llm_judge',
          label: 'each defendant is individually represented',
          verdict: { pass: false, score: 0.61, reason: 'Missed the individual Doe defendants.' },
        },
      ],
      lastResult: { status: 'fail', score: 0.61 },
    },
  ],
  set_conflict_of_interest: [
    {
      id: 'smp_coi_1',
      name: 'New client vs existing client',
      kind: 'workflow',
      targetName: 'Conflict check workflow',
      summary:
        'A new client adverse to an existing client should raise a conflict flag. Confirms the matter is routed to compliance.',
      given: [
        { label: 'clientId', value: 'CL-77' },
        { label: 'parties', value: '["Acme Corp"]' },
        { label: 'matterType', value: 'litigation' },
      ],
      checks: [
        {
          id: 'chk_coi_1a',
          family: 'binary',
          type: 'node_visited',
          label: 'flag_conflict node was visited',
          verdict: { pass: true },
        },
        {
          id: 'chk_coi_1b',
          family: 'binary',
          type: 'tool_called',
          label: 'notify_compliance was called',
          verdict: { pass: true },
        },
        {
          id: 'chk_coi_1c',
          family: 'scored',
          type: 'llm_judge',
          label: 'flag explains the adverse relationship',
          verdict: { pass: true, score: 0.93, reason: 'Names both clients and the conflict.' },
        },
      ],
      lastResult: { status: 'pass', score: 0.93 },
    },
    {
      id: 'smp_coi_2',
      name: 'No conflict — clean intake',
      kind: 'workflow',
      targetName: 'Conflict check workflow',
      summary:
        'A clean intake with no adverse matches should clear without flagging. The workflow should complete at the approve node.',
      given: [
        { label: 'clientId', value: 'CL-91' },
        { label: 'parties', value: '["Nova LLC"]' },
        { label: 'matterType', value: 'advisory' },
      ],
      checks: [
        {
          id: 'chk_coi_2a',
          family: 'binary',
          type: 'node_visited',
          label: 'flag_conflict node was NOT visited',
          verdict: { pass: true },
        },
        {
          id: 'chk_coi_2b',
          family: 'binary',
          type: 'tool_called',
          label: 'notify_compliance was NOT called',
          verdict: { pass: true },
        },
      ],
      lastResult: { status: 'pass', score: null },
    },
  ],
  // set_conflicting_data_detection intentionally has no samples yet (empty state).
}

export const MOCK_EVAL_RUNS: MockEvalRun[] = [
  {
    id: 'run_0003',
    at: 'Jul 14, 3:20pm',
    sets: ['Escalation Policy', 'Party Identification'],
    status: 'running',
    passed: 11,
    total: 20,
    score: 0.79,
  },
  {
    id: 'run_0002',
    at: 'Jul 14, 11:02am',
    sets: ['Document Categorization'],
    status: 'completed',
    passed: 13,
    total: 14,
    score: 0.92,
  },
  {
    id: 'run_0001',
    at: 'Jul 13, 9:41am',
    sets: ['Conflict of Interest'],
    status: 'completed',
    passed: 8,
    total: 8,
    score: 0.9,
  },
]

// ── Model catalog (mock) ─────────────────────────────────────────────────────
// Fabricated models used ONLY by the run-history helper below (getMockRunHistory)
// to populate the mock "Test runs" tables. The live run-config dialog reads real
// models/providers from the host config (config.listModels / config.listProviders)
// via the data client — it does NOT use this list.

export type MockModelBrand =
  | 'openai'
  | 'anthropic'
  | 'venice'
  | 'openrouter'
  | 'google'
  | 'meta'
  | 'mistral'
  | 'qwen'
  | 'deepseek'

// Internal to this file — only getMockRunHistory below consumes these. (The live
// run-config dialog reads real models from config.listModels, not this list.)
type MockModel = {
  id: string
  /** Display name, e.g. "GPT-5.1". */
  name: string
  brand: MockModelBrand
  /** Blended cost per 1M tokens, USD. */
  costPerMTok: number
  /** Throughput in tokens/second. */
  tokensPerSec: number
}

const MOCK_MODELS: MockModel[] = [
  { id: 'openai/gpt-5.1', name: 'GPT-5.1', brand: 'openai', costPerMTok: 5.0, tokensPerSec: 82 },
  { id: 'openai/gpt-5.1-mini', name: 'GPT-5.1 mini', brand: 'openai', costPerMTok: 1.2, tokensPerSec: 145 },
  { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8', brand: 'anthropic', costPerMTok: 9.0, tokensPerSec: 64 },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', brand: 'anthropic', costPerMTok: 3.0, tokensPerSec: 98 },
  { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro', brand: 'google', costPerMTok: 3.5, tokensPerSec: 110 },
  { id: 'meta-llama/llama-4-405b', name: 'Llama 4 405B', brand: 'meta', costPerMTok: 0.9, tokensPerSec: 130 },
  { id: 'venice-uncensored', name: 'Venice Uncensored', brand: 'venice', costPerMTok: 0.5, tokensPerSec: 120 },
  { id: 'openrouter/auto', name: 'OpenRouter Auto', brand: 'openrouter', costPerMTok: 2.0, tokensPerSec: 100 },
  { id: 'qwen3-vl-235b-a22b', name: 'Qwen3 VL 235B', brand: 'qwen', costPerMTok: 1.5, tokensPerSec: 90 },
  { id: 'qwen3-5-9b', name: 'Qwen3 9B', brand: 'qwen', costPerMTok: 0.2, tokensPerSec: 200 },
  { id: 'deepseek-r1-671b', name: 'DeepSeek R1', brand: 'deepseek', costPerMTok: 0.8, tokensPerSec: 75 },
]

// One row in an entity's "Test runs" history (a set, a sample, or a single test).
export type MockRunHistoryRow = {
  id: string
  /** Human-friendly timestamp label. */
  at: string
  /** Overall verdict (the winning model's). */
  status: 'pass' | 'fail'
  /** Attempts each model was given (best-of-N). */
  bestOfN: number
  /** How many models competed in this run. */
  modelsCount: number
  /** Total cost across every model × attempt, USD. */
  totalCost: number
  /** Headline pass count — the winning model's tests passed… */
  passed: number
  /** …out of this many tests in the suite. */
  total: number
  /** The winning model + its best-attempt metadata. */
  best: MockRunModelResult
  /** Full per-model matrix (winner flagged). */
  models: MockRunModelResult[]
}

// One model's line in a run — its best-of-N result plus metadata. This is a row
// of the run-report matrix (model × metadata × test results).
export type MockRunModelResult = {
  modelId: string
  model: string
  brand: MockModelBrand
  /** Attempts this model was given (= run's bestOfN). */
  attempts: number
  /** Average cost per attempt, USD (the reported cost is the best attempt's avg). */
  avgCost: number
  /** Tokens used on the best attempt. */
  tokens: number
  /** Throughput, tokens/second. */
  tokensPerSec: number
  passed: number
  total: number
  /** Judge-only score, 0..1. Null when the entity has no scored checks. */
  score: number | null
  /** True for the run's winning model. */
  winner: boolean
}

// NOTE: entity reads/writes now live in mock-store.ts (the versioned in-memory
// store, seeded from MOCK_EVAL_SETS / MOCK_SAMPLES above). This file only holds
// the seed + the fabricated run-history helper below.

const RUN_TIMES = [
  'Jul 14, 3:20pm',
  'Jul 13, 9:41am',
  'Jul 11, 2:02pm',
  'Jul 9, 10:15am',
]

// FNV-1a hash → deterministic pseudo-randomness keyed by a string, so the same
// entity always fabricates the same history (no Math.random, stable across renders).
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function rand01(s: string): number {
  return (hash(s) % 100000) / 100000
}

// A fabricated run history for any entity. Each row is a best-of-N competition
// across several models. `scored` controls whether judge scores show (a binary-only
// test/sample has null scores → the winner is decided by pass count). Deterministic
// per seed so different entities look different without per-entity fixtures.
export function getMockRunHistory(
  seed: string,
  scored: boolean,
): MockRunHistoryRow[] {
  const runCount = 3 + (seed.length % 2) // 3 or 4
  const rows: MockRunHistoryRow[] = []

  for (let r = 0; r < runCount; r++) {
    const rk = `${seed}_${r}`
    const bestOfN = 2 + (hash(`${rk}n`) % 2) // 2 or 3
    const modelsCount = 4 + (hash(`${rk}m`) % 2) // 4 or 5
    const total = 3 + (hash(`${rk}t`) % 3) // 3..5 tests
    const start = hash(`${rk}x`) % (MOCK_MODELS.length - modelsCount + 1)
    const chosen = MOCK_MODELS.slice(start, start + modelsCount)

    const models: MockRunModelResult[] = chosen.map((m) => {
      const mk = `${rk}_${m.id}`
      const score = 0.55 + rand01(`${mk}s`) * 0.42 // 0.55..0.97
      const passed = Math.min(total, Math.round(score * total))
      const tokens = 7000 + Math.floor(rand01(`${mk}k`) * 11000) // 7k..18k
      const avgCost = Math.max(
        0.01,
        Number(((tokens / 1_000_000) * m.costPerMTok).toFixed(2)),
      )
      const tokensPerSec = m.tokensPerSec + (hash(`${mk}v`) % 12) - 6
      return {
        modelId: m.id,
        model: m.name,
        brand: m.brand,
        attempts: bestOfN,
        avgCost,
        tokens,
        tokensPerSec,
        passed,
        total,
        score: scored ? Number(score.toFixed(2)) : null,
        winner: false,
      }
    })

    // Winner: highest score when scored, else most tests passed; tie-break cheaper.
    const winner = [...models].sort((a, b) => {
      const ap = scored ? (a.score ?? 0) : a.passed
      const bp = scored ? (b.score ?? 0) : b.passed
      if (bp !== ap) return bp - ap
      return a.avgCost - b.avgCost
    })[0]
    winner.winner = true

    const totalCost = Number(
      models.reduce((sum, m) => sum + m.avgCost * m.attempts, 0).toFixed(2),
    )

    rows.push({
      id: `${seed}_h${r}`,
      at: RUN_TIMES[r % RUN_TIMES.length],
      status: winner.passed / total >= 0.8 ? 'pass' : 'fail',
      bestOfN,
      modelsCount,
      totalCost,
      passed: winner.passed,
      total,
      best: winner,
      models,
    })
  }

  return rows
}
