import openstuff from '@openstuff-dev/lint/eslint';

const warn = (entry) => (Array.isArray(entry) ? ['warn', ...entry.slice(1)] : entry === 'off' || entry === 0 ? entry : 'warn');

/**
 * Reports every rule as a warning, so CI shows what the shared rules find
 * without failing while the existing code is brought in line.
 */
export function asWarnings(configs) {
  return configs.map((config) =>
    config.rules
      ? { ...config, rules: Object.fromEntries(Object.entries(config.rules).map(([name, entry]) => [name, warn(entry)])) }
      : config,
  );
}

export default asWarnings(openstuff);
