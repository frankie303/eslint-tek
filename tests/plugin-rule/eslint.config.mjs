import reduce from 'eslint-plugin-reduce';

export default [
  {
    files: ['**/*.js'],
    plugins: { reduce },
    rules: { 'reduce/no-spread-in-reduce': 'error' },
  },
];
