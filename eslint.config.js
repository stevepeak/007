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

/** @type {import("eslint").Linter.Config[]} */

// Tests ARE typechecked — `tsconfig.test.json` (non-UI) and `tsconfig.ui.json`
// (UI) both cover them, and `bun run typecheck` runs all three projects. They
// were previously excluded from tsc AND from ESLint, which meant `bun test` —
// which strips types rather than checking them — was the only thing that ever
// read 16k lines of test code. Generated drizzle migrations stay ignored.
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
  // excludes it. Without this every file under src/ui fails to parse, which is
  // why 37k lines sat unlinted.
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
      // Every one of the 192 sites this flagged was one of those two patterns;
      // none created a component. Silencing the rule is the accurate call here,
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

      // React Compiler diagnostics. These are NOT bugs found — every
      // `set-state-in-effect` site was checked and each is a pattern React
      // sanctions: resetting state when an identity prop changes, re-syncing to
      // a refetched server value, `useLayoutEffect` measurement that cannot be
      // derived, and reconciling browser history (an external store). The
      // `purity` ones are `Date.now()` read during render to build a query
      // window — real, but fixing them means restructuring how those windows are
      // captured, which is its own change with its own review.
      //
      // Making src/ui React-Compiler-clean is tracked separately; suppressing
      // here keeps the signal honest rather than pretending the code is clean.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  // The one-way dependency rule, enforced instead of merely documented.
  // README.md states it (`ui → server → storage → engine`, `cloudflare →
  // storage → engine`) and the package's whole claim to being publishable rests
  // on `engine` depending only on `ai` + `zod`. Prose can't fail CI; this can.
  // Two engine TESTS had already drifted across the boundary before this rule
  // existed — see cloudflare/engine-contract.test.ts, where they now live.
  {
    files: ['src/engine/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/storage/**', '**/cloudflare/**', '**/server/**', '**/ui/**'],
              message:
                'engine must not import other layers — it depends only on `ai` + `zod`, which is what makes it publishable. Move the shared value into engine, or put the test in the higher layer.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/storage/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cloudflare/**', '**/server/**', '**/ui/**'],
              message:
                'storage sits below cloudflare/server/ui — depend downward (engine) only.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/server/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cloudflare/**', '**/ui/**'],
              message:
                'server sits below ui and beside cloudflare — depend on storage/engine only.',
            },
          ],
        },
      ],
    },
  },
  { ignores: ['migrations/**'] },
]
