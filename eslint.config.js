import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.claude/worktrees/**',
      '**/*.config.js',
      '**/*.config.ts',
      'apps/web/vite.config.ts',
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
      },
    },
  },
);
