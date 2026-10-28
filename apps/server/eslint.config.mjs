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
];
