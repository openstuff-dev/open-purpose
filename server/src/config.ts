import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  /** Token for the first admin, created on first boot when no actors exist. */
  bootstrapToken?: string;
  /** Name of the first group (tenant), used on first boot only. */
  groupName: string;
  /** Name of the first organization in that group, used on first boot only. */
  orgName: string;
  /** Directory with the built Angular app. Served at "/" when it exists. */
  webDir: string;
  migrationsDir: string;
  /** Public base URL, used only in help text (e.g. the MCP setup snippet). */
  publicUrl: string;
  /** Fetching API specs (OpenAPI/Swagger) from URLs. */
  apiSpecs: ApiSpecConfig;
}

export interface ApiSpecConfig {
  /** Whether the server may fetch spec URLs at all (CHARTER_API_FETCH=off disables it; uploads still work). */
  fetch: boolean;
  /** Re-fetch a URL spec in the background when an agent reads it and it's older than this. 0 = only on demand. */
  refreshMinutes: number;
  /** Largest spec accepted, fetched or uploaded. */
  maxBytes: number;
  timeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL ?? 'postgres://charter:charter@localhost:5432/charter',
    bootstrapToken: env.CHARTER_BOOTSTRAP_TOKEN || undefined,
    groupName: env.CHARTER_GROUP_NAME ?? env.CHARTER_ORG_NAME ?? 'Our company',
    orgName: env.CHARTER_ORG_NAME ?? 'Engineering',
    webDir: env.CHARTER_WEB_DIR ?? path.resolve(here, '../../web/dist/web/browser'),
    migrationsDir: env.CHARTER_MIGRATIONS_DIR ?? path.resolve(here, '../migrations'),
    publicUrl: env.CHARTER_PUBLIC_URL ?? `http://localhost:${port}`,
    apiSpecs: {
      fetch: (env.CHARTER_API_FETCH ?? 'on').toLowerCase() !== 'off',
      refreshMinutes: Number(env.CHARTER_API_REFRESH_MINUTES ?? 60),
      maxBytes: Number(env.CHARTER_API_MAX_MB ?? 20) * 1024 * 1024,
      timeoutMs: 15_000,
    },
  };
}
