import { defineESLintConfig } from '@ocavue/eslint-config'

// Inlined from the former shared `@law/eslint-config/bun.js` so this repo lints
// standalone (no monorepo workspace dependency).
const config = await defineESLintConfig(
  { react: true, markdown: false },
  { languageOptions: { globals: { Bun: true } } },
  {
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
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

// Test files run under `bun test` and are typechecked by the Bun runtime, so
// they're excluded from the tsc project (see tsconfig exclude). ESLint's typed
// project service can't resolve them either — ignore them here. Generated
// drizzle migrations are ignored too.
// `src/ui` (React/tsx) is typechecked via tsconfig.ui.json and is outside the
// base bun tsconfig's project service, so the typed lint rules can't resolve
// it — ignore it here (mirrors the repo's separate-worker-tsconfig pattern).
export default [
  ...config,
  { ignores: ['src/**/*.test.ts', 'src/ui/**', 'migrations/**'] },
]
