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
export type MockLastRun = {
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

export type MockSampleResult = {
  status: 'pass' | 'fail'
  /** Judge-only score for this sample, 0..1. Null when no scored checks. */
  score: number | null
}

/** One outcome check on a sample. `family` drives how a verdict is shown. */
export type MockCheck = {
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

export type MockEvalRunStatus = 'running' | 'completed' | 'failed'

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

// One row in an entity's "Test runs" history (a set, a sample, or a single test).
export type MockRunHistoryRow = {
  id: string
  /** Human-friendly timestamp label. */
  at: string
  status: 'pass' | 'fail'
  /** Judge-only score, 0..1. Null when the entity has no scored checks. */
  score: number | null
}

// NOTE: entity reads/writes now live in mock-store.ts (the versioned in-memory
// store, seeded from MOCK_EVAL_SETS / MOCK_SAMPLES above). This file only holds
// the seed + the fabricated run-history helper below.

// A fabricated run history for any entity. `scored` controls whether scores show
// (a binary-only test/sample has null scores). Deterministic per seed so different
// entities look a little different without needing per-entity fixtures.
export function getMockRunHistory(
  seed: string,
  scored: boolean,
): MockRunHistoryRow[] {
  const rows: Omit<MockRunHistoryRow, 'id'>[] = [
    { at: 'Jul 14, 3:20pm', status: 'pass', score: 0.9 },
    { at: 'Jul 13, 9:41am', status: 'pass', score: 0.86 },
    { at: 'Jul 11, 2:02pm', status: 'fail', score: 0.58 },
    { at: 'Jul 9, 10:15am', status: 'pass', score: 0.81 },
  ]
  // Vary length slightly by seed so entities differ; drop scores when not scored.
  const take = 3 + (seed.length % 2)
  return rows.slice(0, take).map((r, i) => ({
    ...r,
    id: `${seed}_h${i}`,
    score: scored ? r.score : null,
  }))
}
