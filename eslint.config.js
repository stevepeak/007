import { readdirSync } from 'node:fs'

import { defineESLintConfig } from '@ocavue/eslint-config'

// Inlined from the former shared `@law/eslint-config/bun.js` so this repo lints
// standalone (no monorepo workspace dependency).
const config = await defineESLintConfig(
  { react: true, markdown: false },
  { languageOptions: { globals: { Bun: true } } },
  {
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
      // Single-line JSDoc (`/** Foo */`) is the house style here
      'jsdoc/multiline-blocks': 'off',
      // Prettier lowercases hex digits when formatting, so align the unicorn
      // rule to lowercase to avoid a fight between pre-commit prettier and CI.
      'unicorn/number-literal-case': [
        'error',
        { hexadecimalValue: 'lowercase' },
      ],
    },
  },
  { ignores: ['eslint.config.js'] },
)

// ═══════════════════════════════════════════════════════════════════════════
// THE LAYERING RULE — one table, enforced, not merely documented.
//
// `src/` is eleven directories deep and the package's whole claim to being
// publishable rests on the dependencies running ONE WAY. Prose can't fail CI;
// this can. README.md's "Dependency direction" block and AGENTS.md §1 render
// the same table for humans — change all three together.
//
// A directory may import a directory in a STRICTLY LOWER tier. Same-tier
// imports are forbidden too: `cloudflare` and `ui` are both hosts and neither
// may reach the other, and two peers that may import each other are one
// refactor away from a cycle.
//
//   0  engine                  ai · zod · jsonata. Nothing from src/.
//   1  analytics · documents   telemetry encoding / .docx rendering
//   2  storage                 Drizzle over D1
//   3  connectors · eval       remote MCP servers / the eval harness
//   4  mcp                     the outbound MCP tool catalog
//   5  server                  the RPC data layer (composes everything below)
//   6  cloudflare · ui         the two hosts — nothing imports either
//   7  cli                     unrestricted — see the `cli: null` note below
//
// Two directories are allowed ONE upward edge each, for TYPES ONLY:
// `eval` and `mcp` are both drivers of `WfDataClient` — the RPC contract whose
// implementation the host injects — and that interface is declared in
// `server/protocol`. A `import type` is erased at build time, so it creates no
// runtime cycle; a value import would, which is why the allowance is narrow.
// `server` may then import them back (`handlers/evals.ts`, and `index.ts`
// re-exporting the MCP fetch handler) without closing a loop.
const LAYER_TIERS = {
  engine: 0,
  analytics: 1,
  documents: 1,
  storage: 2,
  connectors: 3,
  eval: 3,
  mcp: 4,
  server: 5,
  cloudflare: 6,
  ui: 6,
  // `cli` is the host of last resort — the `wf-spec` bin, which wires storage
  // to a local SQLite file and is not part of the published module graph. It
  // imports downward by nature and nothing imports it, so it gets no rule.
  // Every OTHER directory is still forbidden from importing it.
  cli: null,
}

// The table must be TOTAL. A new `src/<dir>` with no layer is a directory with
// no rule and no place on the map — which is exactly how half this tree ended up
// unrestricted before ART-189. Failing here means `bun run lint` and
// `bun run fix` both stop until someone decides where the directory sits; a mere
// test would let the drift ship and get noticed later, if at all.
const SRC_DIRS = readdirSync(new URL('./src', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

const unplaced = SRC_DIRS.filter((dir) => !(dir in LAYER_TIERS))
const phantom = Object.keys(LAYER_TIERS).filter(
  (dir) => !SRC_DIRS.includes(dir),
)
if (unplaced.length > 0 || phantom.length > 0) {
  throw new Error(
    [
      'eslint.config.js: LAYER_TIERS is out of sync with src/.',
      unplaced.length > 0 &&
        `  Unplaced (add a layer, and a row in README's "Dependency direction"): ${unplaced.join(', ')}`,
      phantom.length > 0 &&
        `  No such directory (remove the entry): ${phantom.join(', ')}`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

/** Directories each layer may reach for TYPES ONLY. See the note above. */
const LAYER_TYPE_ONLY = {
  eval: ['server'],
  mcp: ['server'],
}

/**
 * Directories whose TESTS may additionally take a value from the layer above.
 *
 * An integration test stands up the real `createLocalWfDataClient` to drive the
 * layer under test end to end (`mcp/{evals,lifecycle}-integration.test.ts`).
 * That is the test's subject, not a production dependency — tests ship in no
 * build. `engine` is deliberately absent: its tests get no latitude at all, and
 * the two that needed it live in the higher layer instead (see
 * `cloudflare/engine-contract.test.ts` and `eval/node-timeout-override.test.ts`).
 */
const LAYER_TEST_ESCAPES = {
  eval: ['server'],
  mcp: ['server'],
}

/**
 * Every way a file can spell an import of the TOP-LEVEL `src/<dir>`.
 *
 * Deliberately not `**\/${dir}`: that also matches `./data/connectors` and
 * `./connectors` — `src/storage/data/connectors.ts`, a sibling module that
 * merely shares a name with a layer. Crossing a top-level boundary in this tree
 * always means a specifier that climbs out with `../` first, and `src/` is four
 * segments deep at most (`ui/evals/run-report/model.ts`), so enumerating the
 * climbs is exact where a glob is not.
 */
const LAYER_CLIMBS = ['..', '../..', '../../..', '../../../..']

function layerPatterns(dir) {
  return [
    ...LAYER_CLIMBS.flatMap((up) => [`${up}/${dir}`, `${up}/${dir}/**`]),
    `@stevepeak/007/${dir}`,
    `@stevepeak/007/${dir}/**`,
  ]
}

/** Why `dir` may not reach `denied`, in the terms the table is written in. */
function layerMessage(dir, denied) {
  if (dir === 'engine') {
    return (
      'engine is layer 0: it must not import ANY other layer — it depends only on ' +
      '`ai`, `zod` and `jsonata`, which is what makes this package publishable. ' +
      'Move the shared value down into engine, or put the test in the higher layer.'
    )
  }
  const tier = LAYER_TIERS[dir]
  return (
    `src/${dir} is layer ${tier} and may import layers 0..${tier - 1} only — not ` +
    `${denied.join(', ')}. Depend downward: move the shared value to a lower ` +
    'layer, or move your code up. See README "Dependency direction" and AGENTS.md §1.'
  )
}

const LAYER_RULES = Object.keys(LAYER_TIERS).flatMap((dir) => {
  const tier = LAYER_TIERS[dir]
  if (tier === null) return []
  const typeOnly = LAYER_TYPE_ONLY[dir] ?? []
  // `null` (cli) reads as "above everything" here: nothing may import it.
  const denied = Object.keys(LAYER_TIERS).filter(
    (other) =>
      other !== dir &&
      (LAYER_TIERS[other] === null || LAYER_TIERS[other] >= tier),
  )
  const hard = denied.filter((other) => !typeOnly.includes(other))
  const groups = []
  if (hard.length > 0) {
    groups.push({
      group: hard.flatMap(layerPatterns),
      message: layerMessage(dir, hard),
    })
  }
  if (typeOnly.length > 0) {
    groups.push({
      group: typeOnly.flatMap(layerPatterns),
      allowTypeImports: true,
      message:
        `src/${dir} may reach ${typeOnly.join(', ')} for TYPES ONLY — it drives the ` +
        '`WfDataClient` contract, whose implementation the host injects. A value ' +
        'import would make the cycle real at runtime. Use `import type`.',
    })
  }
  const entries = [
    {
      files: [`src/${dir}/**`],
      rules: { 'no-restricted-imports': ['error', { patterns: groups }] },
    },
  ]
  const escapes = LAYER_TEST_ESCAPES[dir] ?? []
  if (escapes.length > 0) {
    // Same rule minus the escaped directories — ESLint replaces the whole rule
    // option rather than merging, so the test entry restates it.
    const testGroups = groups
      .map((g) => ({
        ...g,
        group: g.group.filter(
          (pattern) => !escapes.some((e) => layerPatterns(e).includes(pattern)),
        ),
      }))
      .filter((g) => g.group.length > 0)
    entries.push({
      files: [`src/${dir}/**/*.test.ts`, `src/${dir}/**/*.test.tsx`],
      rules: {
        'no-restricted-imports': ['error', { patterns: testGroups }],
      },
    })
  }
  return entries
})

/** @type {import("eslint").Linter.Config[]} */

// Tests ARE typechecked — `tsconfig.test.json` (non-UI) and `tsconfig.ui.json`
// (UI) both cover them, and `bun run typecheck` runs all three projects. They
// were previously excluded from tsc AND from ESLint, which meant `bun test` —
// which strips types rather than checking them — was the only thing that ever
// read the test code. Generated drizzle migrations stay ignored.
// `src/ui` (React/tsx) is typechecked via tsconfig.ui.json and is outside the
// base bun tsconfig's project service, so the typed lint rules can't resolve
// it — ignore it here (mirrors the repo's separate-worker-tsconfig pattern).
export default [
  ...config,
  // Point the typed-lint project service at the test project. Without this the
  // parser resolves test files against tsconfig.json, which does not include
  // them, and every one fails with "was not found by the project service".
  {
    files: ['src/**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        // The shared config turns `projectService` on, which resolves each file
        // against the NEAREST tsconfig — tsconfig.json, which excludes tests.
        // Switch this glob back to explicit `project` resolution so the typed
        // rules read tests through the project that actually contains them.
        projectService: false,
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A mock's `doGenerate: async () => ({...})` has no `await`, but the
      // provider signature is `(options) => PromiseLike<Result>` — the `async`
      // is what satisfies it. Dropping it to appease the rule would break the
      // type; the rule simply doesn't apply to promise-returning stubs.
      '@typescript-eslint/require-await': 'off',
      // `await expect(p).rejects.toThrow()` is typed as returning void by
      // @types/bun even though it returns a promise. Removing the `await` would
      // leave rejection assertions unawaited — silently passing tests — so the
      // rule is a false positive here, not a finding.
      '@typescript-eslint/await-thenable': 'off',
    },
  },
  // Same wiring for the React UI: it lives in its own DOM-typed project, which
  // the shared config's `projectService` never discovers because tsconfig.json
  // excludes it. Without this every file under src/ui fails to parse — and
  // parse failures are reported per file, not as a lint error, so the whole
  // UI can sit unlinted without CI noticing.
  {
    files: ['src/ui/**/*.ts', 'src/ui/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.ui.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Same Bun-typing false positives as the test glob above.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/await-thenable': 'off',
      // The SDK renders the HOST's design-system primitives, pulled out of
      // context per component (`const { Button } = useWfComponents()`), and
      // picks icons out of a module-level registry (`agentIcon(name)`). Both
      // read to this rule as "a component created during render" because it
      // cannot see through the context boundary — but `WfSdkProvider` memoises
      // the components object and the icon map is a module constant, so the
      // identities are stable and nothing remounts.
      //
      // Every site this flagged was one of those two patterns; none created a
      // component. Silencing the rule is the accurate call here,
      // not a concession — obeying it would mean abandoning host injection,
      // which is the whole point of the package.
      //
      // The one real hazard it gestures at lives in the HOST, not here: passing
      // an inline object literal as `components` defeats the provider's memo and
      // does remount every primitive. That belongs in the integration guide.
      '@eslint-react/static-components': 'off',
      'react-hooks/static-components': 'off',

      // Two plugins ship overlapping React rule sets — `react-hooks/*` (the
      // React team's, including the compiler diagnostics) and `@eslint-react/*`.
      // Where they duplicate, keep react-hooks authoritative and silence the
      // twin: otherwise every deliberate exemption has to be written twice, and
      // the existing `eslint-disable react-hooks/exhaustive-deps` comments in
      // wf-auto-form.tsx and sub-agent-picker.tsx already were half-silenced.
      '@eslint-react/exhaustive-deps': 'off',
      '@eslint-react/set-state-in-effect': 'off',

      // NOTE: the React Compiler diagnostics — `purity`, `immutability`,
      // `preserve-manual-memoization`, `set-state-in-effect` — are all ON.
      // Each surviving `set-state-in-effect` site carries an
      // `eslint-disable-next-line` with the reason inline, so each is a
      // decision on the record and a NEW violation still fails the build.

    },
  },
  // ═══════════════════════════════════════════════════════════════════════
  // THE LAYERING RULE (ART-189) — see LAYER_TIERS above.
  //
  // Generated from one table rather than hand-written per directory, because
  // the previous three hand-written blocks covered `engine`, `storage` and
  // `server` and left eight directories with no rule and no place on the map.
  // A new `src/<dir>` now fails at config load until someone decides where it
  // sits, which is the only way the table stays complete.
  ...LAYER_RULES,

  // Runtime code reports a swallowed fault through `WfSdkConfig.logger`, never
  // through `console` — a console line in a Worker is a Sentry breadcrumb at
  // best, so before this rule a production failure that the SDK deliberately
  // did not throw had no destination at all (ART-187). `engine/logger.ts` holds
  // the one console the package keeps: the default the seam falls back to.
  //
  // `src/cli` is exempt on purpose — a CLI's console IS its output — and so are
  // tests, which assert on it.
  {
    files: [
      'src/analytics/**',
      'src/cloudflare/**',
      'src/connectors/**',
      'src/documents/**',
      'src/engine/**',
      'src/eval/**',
      'src/mcp/**',
      'src/server/**',
      'src/storage/**',
    ],
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/engine/logger.ts'],
    rules: {
      // No allow-list: `console.log`/`info`/`debug` are not a fault channel
      // either, and the runtime dirs have none of them.
      'no-console': 'error',
    },
  },
  { ignores: ['migrations/**'] },
]
