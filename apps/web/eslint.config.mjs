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
  {
    pattern: String.raw`class="([^"]*\s)?(chip|chip-x|flag|status|mode-badge)[\s"]`,
    message: 'Use os-chip, os-badge or os-status-dot from @openstuff-dev/ui-angular instead of .chip, .flag, .status or .mode-badge.',
  },
  {
    pattern: String.raw`class="([^"]*\s)?segmented[\s"]`,
    message: 'Use <os-segmented-control> from @openstuff-dev/ui-angular (or .os-segmented with radios when options need icons or counts) instead of .segmented.',
  },
  {
    pattern: String.raw`class="([^"]*\s)?tabs[\s"]`,
    message: 'Use <os-tabs> from @openstuff-dev/ui-angular (or .os-tab-list and .os-tab for link tabs and tab-styled filters) instead of .tabs.',
  },
  {
    pattern: String.raw`class="([^"]*\s)?(data-table|cell-sub|empty-row)[\s"]`,
    message: 'Use .os-data-table (or <os-data-table>) with .os-cell-sub and .os-data-table-empty from @openstuff-dev/ui instead of .data-table, .cell-sub or .empty-row.',
  },
  {
    pattern: String.raw`class="([^"]*\s)?(menu|menu-item|menu-label|menu-sep|tip|tip-wrap)[\s"]`,
    message: 'Use os-menu with os-popover-trigger, os-menu-item, os-menu-label and os-menu-separator, or os-tooltip, from @openstuff-dev/ui-angular instead of .menu or .tip.',
  },
  {
    pattern: String.raw`class="([^"]*\s)?(callout|token-callout|doc-notice|empty|notice|notices)[\s"]`,
    message: 'Use <os-callout> or <os-empty-state> from @openstuff-dev/ui-angular, or Notices (shown with the Toaster), instead of .callout, .doc-notice, .empty or .notice.',
  },
  {
    pattern: String.raw`role="dialog"`,
    message: 'Use <dialog os-dialog> or <dialog os-drawer> from @openstuff-dev/ui-angular instead of an element with role="dialog".',
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
      'no-restricted-globals': [
        'error',
        { name: 'confirm', message: 'Use ConfirmDialog from @openstuff-dev/ui-angular.' },
        { name: 'prompt', message: 'Ask in a <dialog os-dialog> with an os-field.' },
        { name: 'alert', message: 'Use Notices, or a <dialog os-dialog> for something that needs an answer.' },
      ],
    },
  },
];
