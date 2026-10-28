import angular from '@openstuff-dev/lint/eslint/angular';
import { asWarnings } from '../../eslint.config.mjs';

export default asWarnings([
  ...angular,
  {
    files: ['**/*.ts'],
    rules: {
      '@angular-eslint/component-selector': ['error', { type: 'element', prefix: 'app', style: 'kebab-case' }],
      '@angular-eslint/directive-selector': ['error', { type: 'attribute', prefix: 'app', style: 'camelCase' }],
    },
  },
]);
