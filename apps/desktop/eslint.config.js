// ESLint v9 flat config. Used by `pnpm -C apps/desktop lint` and CI.
// Goal: catch real bugs (unused vars, exhaustive-deps, dead branches) without
// fighting style — Prettier / tsc handle formatting + types respectively.

import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/target/**', '**/*.d.ts'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Promise: 'readonly',
        Set: 'readonly',
        Map: 'readonly',
        JSON: 'readonly',
        Math: 'readonly',
        Number: 'readonly',
        Array: 'readonly',
        Object: 'readonly',
        Boolean: 'readonly',
        Date: 'readonly',
        Error: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLButtonElement: 'readonly',
        React: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    rules: {
      // Unused vars — allow `_`-prefixed (intentional discards).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-unused-vars': 'off', // turned off in favor of the typescript-eslint version above
      // Hooks rules — non-negotiable, real-bug class.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Prefer let/const, no var.
      'no-var': 'error',
      'prefer-const': 'warn',
      // Catch obvious mistakes.
      'no-debugger': 'error',
      'no-undef': 'off', // typescript handles this
    },
  },
];
