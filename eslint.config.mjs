import openstuff from '@openstuff-dev/lint/eslint';

export default [
  ...openstuff,
  {
    files: ['**/*.ts'],
    rules: {
      // `name || fallback` on strings is on purpose: a blank string falls back too.
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
    },
  },
];
