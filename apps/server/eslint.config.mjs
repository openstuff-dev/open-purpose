import config from '../../eslint.config.mjs';

export default [
  ...config,
  {
    // Tests and the Vitest config sit outside tsconfig.json, which only builds src.
    // One project service serves every file, so the option goes on all of them.
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['test/*.ts', 'vitest.config.ts'] } },
    },
  },
  {
    // Tests read the API's JSON untyped through api<T = any>() and assert on it, and a regex
    // that doesn't match should fail the test, so `any` and `!` are fine here.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      // Fakes implement async interfaces without awaiting anything.
      '@typescript-eslint/require-await': 'off',
    },
  },
];
