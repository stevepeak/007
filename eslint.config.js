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
  { ignores: ['knip.ts', 'eslint.config.js'] },
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
  { ignores: ['src/ui/**', 'migrations/**'] },
]
