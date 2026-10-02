import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['node_modules/', 'dist/', 'scripts/'],
  },

  js.configs.recommended,

  // Plain JS (test fixtures, config files): the rules the CLI tests exercise.
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      'no-console': 'error',
      'no-debugger': 'error',
      'no-unused-vars': 'warn',
    },
  },

  ...tseslint.configs.recommended,

  // TypeScript source and tests.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      // The CLI writes to stdout/stderr intentionally.
      'no-console': 'off',
      // `createRequire` is used to read package.json for --version.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
