/// <reference types="node" />
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const port = 18110;
const databaseUrl = process.env['E2E_DATABASE_URL'] ?? '';

// Same guard as the server's integration tests: this creates an admin in whatever database it gets.
if (!/\/[^/]*_e2e(\?.*)?$/.test(databaseUrl)) {
  throw new Error('Set E2E_DATABASE_URL to a throwaway database whose name ends in _e2e.');
}

export const adminToken = 'e2e-admin-token-0123456789abcdef';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['junit', { outputFile: 'e2e-results.xml' }]],
  outputDir: 'e2e-output',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env['E2E_CHROME_CHANNEL'],
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node ../server/dist/index.js',
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      DATABASE_URL: databaseUrl,
      OPENPURPOSE_BOOTSTRAP_TOKEN: adminToken,
      OPENPURPOSE_PUBLIC_URL: `http://127.0.0.1:${port}`,
      WEB_DIR: resolve(__dirname, 'dist/web/browser'),
    },
  },
});
