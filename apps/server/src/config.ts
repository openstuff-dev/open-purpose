import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SignupMode } from '@openpurpose/contracts';

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
  /** Largest export file accepted by an import. */
  importMaxBytes: number;
  /** Sign-in through an external provider and self sign-up. Off by default: tokens only. */
  auth: AuthConfig;
}

const SIGNUP_MODES: SignupMode[] = ['off', 'approval', 'open'];

export interface AuthConfig {
  /** External sign-in provider, e.g. 'supabase'. Empty = tokens only. */
  provider: string;
  signup: SignupMode;
  supabaseUrl: string;
  /** The Supabase project's publishable (anon) key. */
  supabaseKey: string;
  /** The marketing site, for the "Back to …" link on the sign-in page. */
  siteUrl: string;
  /** How long a browser session lasts. */
  sessionDays: number;
}

export interface ApiSpecConfig {
  /**
   * Whether the server may fetch spec URLs at all (OPENPURPOSE_API_FETCH=off disables it; uploads
   * still work).
   */
  fetch: boolean;
  /**
   * Re-fetch a URL spec in the background when an agent reads it and it's older than this. 0 = only
   * on demand.
   */
  refreshMinutes: number;
  /** Largest spec accepted, fetched or uploaded. */
  maxBytes: number;
  timeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  const auth = loadAuthConfig(env);
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    databaseUrl:
      env.DATABASE_URL ?? 'postgres://openpurpose:openpurpose@localhost:5432/openpurpose',
    bootstrapToken: env.OPENPURPOSE_BOOTSTRAP_TOKEN || undefined,
    groupName: env.OPENPURPOSE_GROUP_NAME || env.OPENPURPOSE_ORG_NAME || 'Our company',
    orgName: env.OPENPURPOSE_ORG_NAME || env.OPENPURPOSE_GROUP_NAME || 'Our company',
    webDir: env.OPENPURPOSE_WEB_DIR ?? path.resolve(here, '../../web/dist/web/browser'),
    migrationsDir: env.OPENPURPOSE_MIGRATIONS_DIR ?? path.resolve(here, '../migrations'),
    publicUrl: env.OPENPURPOSE_PUBLIC_URL ?? `http://localhost:${port}`,
    apiSpecs: {
      fetch: (env.OPENPURPOSE_API_FETCH ?? 'on').toLowerCase() !== 'off',
      refreshMinutes: Number(env.OPENPURPOSE_API_REFRESH_MINUTES ?? 60),
      maxBytes: Number(env.OPENPURPOSE_API_MAX_MB ?? 20) * 1024 * 1024,
      timeoutMs: 15_000,
    },
    importMaxBytes: Number(env.OPENPURPOSE_IMPORT_MAX_MB ?? 100) * 1024 * 1024,
    auth,
  };
}

function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const provider = (env.OPENPURPOSE_AUTH_PROVIDER ?? '').trim().toLowerCase();
  const signup = (env.OPENPURPOSE_SIGNUP || 'off').trim().toLowerCase() as SignupMode;
  if (!SIGNUP_MODES.includes(signup)) {
    throw new Error(
      `OPENPURPOSE_SIGNUP must be one of ${SIGNUP_MODES.join(', ')} (got "${env.OPENPURPOSE_SIGNUP}")`,
    );
  }
  // The provider sends people back to <public url>/api/auth/callback, so it must be the real one.
  if (provider && !env.OPENPURPOSE_PUBLIC_URL) {
    throw new Error(
      `OPENPURPOSE_AUTH_PROVIDER=${provider} needs OPENPURPOSE_PUBLIC_URL, e.g. https://purpose.example.com`,
    );
  }
  const sessionDays = Number(env.OPENPURPOSE_SESSION_DAYS || 30);
  if (!(sessionDays > 0)) {
    throw new Error(
      `OPENPURPOSE_SESSION_DAYS must be a positive number (got "${env.OPENPURPOSE_SESSION_DAYS}")`,
    );
  }
  return {
    provider,
    signup,
    supabaseUrl: env.OPENPURPOSE_SUPABASE_URL ?? '',
    supabaseKey: env.OPENPURPOSE_SUPABASE_KEY ?? '',
    siteUrl: env.OPENPURPOSE_SITE_URL ?? '',
    sessionDays,
  };
}
