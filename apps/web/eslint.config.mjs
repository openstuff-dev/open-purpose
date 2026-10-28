import angular from '@openstuff-dev/lint/eslint/angular';
import { asWarnings } from '../../eslint.config.mjs';

/** The shared no-restricted-syntax entries; a rule set later replaces them, so they're repeated. */
const shared = angular.flatMap((config) => config.rules?.['no-restricted-syntax']?.slice(1) ?? []);

/** Classes replaced by @openstuff-dev/ui components. Matches them in inline templates. */
const replaced = [
  {
    pattern: String.raw`class="([^"]*\s)?(btn|link-btn|icon-btn)[\s"]`,
    message: 'Use <button os-button> (or os-icon-button) from @openstuff-dev/ui-angular instead of .btn, .link-btn or .icon-btn.',
  },
  {
    pattern: String.raw`class="([^"]*\s)?(check|field-error)[\s"]`,
    message: 'Use <label os-check> with os-checkbox or os-radio, and <os-field [error]> or .os-error, from @openstuff-dev/ui-angular instead of .check or .field-error.',
  },
];

export default [
  ...asWarnings([
    ...angular,
    {
      files: ['**/*.ts'],
      rules: {
        '@angular-eslint/component-selector': ['error', { type: 'element', prefix: 'app', style: 'kebab-case' }],
        '@angular-eslint/directive-selector': ['error', { type: 'attribute', prefix: 'app', style: 'camelCase' }],
      },
    },
  ]),
  // Errors, not warnings: the old markup is gone, so it must not come back.
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...shared,
        ...replaced.map(({ pattern, message }) => ({ selector: `TemplateElement[value.raw=/${pattern}/]`, message })),
      ],
    },
  },
];
