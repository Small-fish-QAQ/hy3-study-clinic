import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'output/**',
      // Frozen research tools are evidence, independently verified without rewriting their bytes.
      'docs/architecture-audit/**',
      'docs/architecture-redesign/**',
      'docs/architecture-simplification-plan/**',
      '**/.claude/worktrees/**',
      '**/*.config.js',
      '**/*.config.ts',
      'apps/web/vite.config.ts',
      // Published frozen evaluator bytes are checked by identity and offline replay.
      'eval/final-showcase/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Plain Node demo/evaluation scripts (run with `node scripts/*.mjs` /
    // `node eval/*.mjs`).
    files: ['scripts/**/*.mjs', 'eval/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        Response: 'readonly',
        AbortSignal: 'readonly',
        performance: 'readonly',
        DOMException: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
);
