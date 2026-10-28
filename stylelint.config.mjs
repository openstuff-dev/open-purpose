export default {
  extends: ['@openstuff-dev/lint/stylelint'],
  rules: {
    // The app's stylesheet is grouped by page, and the rule compares selectors for different
    // elements (.rail li a and .doc-list li a), so it only reports noise here.
    'no-descending-specificity': null,
  },
  overrides: [
    {
      // Agent mode is a fixed terminal costume over the themed UI (dark only), so it keeps its
      // own palette instead of tokens.
      files: ['apps/web/src/agent-mode.css'],
      rules: {
        'color-no-hex': null,
        'function-disallowed-list': null,
      },
    },
  ],
};
