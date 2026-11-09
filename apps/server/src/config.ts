import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SignupMode } from '@openpurpose/contracts';
import type { FetchPolicy } from '@openstuff-dev/server';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  /** The release this image was built from, set by the image build. `unknown` for a local build. */
  appVersion: string;
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
  /**
   * Behind a reverse proxy, trust its X-Forwarded-For so rate limits see the real client.
   * OPENPURPOSE_TRUST_PROXY: the proxy addresses (e.g. 10.0.0.0/8,127.0.0.1), or true to trust
   * anyone (warned about at startup). Off by default.
   */
  trustProxy: boolean | string;
  /** Encrypts saved connection secrets. Without one, a key is made and kept in the database. */
  secretKey: string | undefined;
  /** OpenVersion and OpenAnnounce this server connects to. Set here, they win over the tab. */
  openVersion: {
    url: string | undefined;
    publicKey: string | undefined;
    /** Lets this server publish its own version to OpenVersion on start. Never sent to browsers. */
    deployToken: string | undefined;
  };
  openAnnounce: {
    url: string | undefined;
    publicKey: string | undefined;
    signingSecret: string | undefined;
  };
  /** `private` lets this server call internal addresses, such as an OpenVersion on your network. */
  fetch: 'public' | 'private';
  /** With `private`: only these hosts. Empty means any. */
  fetchAllow: string[];
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
   * Private network addresses the server may still fetch specs from
   * (OPENPURPOSE_API_FETCH_ALLOW): host names, IP addresses or CIDR ranges. Everything else on
   * loopback, private, link-local or reserved addresses is refused.
   */
  allow: string[];
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
    appVersion: env.VERSION?.trim() || 'unknown',
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
      allow: (env.OPENPURPOSE_API_FETCH_ALLOW ?? '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
      refreshMinutes: Number(env.OPENPURPOSE_API_REFRESH_MINUTES ?? 60),
      maxBytes: Number(env.OPENPURPOSE_API_MAX_MB ?? 20) * 1024 * 1024,
      timeoutMs: 15_000,
    },
    importMaxBytes: Number(env.OPENPURPOSE_IMPORT_MAX_MB ?? 100) * 1024 * 1024,
    auth,
    trustProxy: trustProxy(env.OPENPURPOSE_TRUST_PROXY),
    secretKey: env.OPENPURPOSE_SECRET_KEY || undefined,
    openVersion: {
      url: env.OPENPURPOSE_OPENVERSION_URL?.replace(/\/$/, '') || undefined,
      publicKey: env.OPENPURPOSE_OPENVERSION_PUBLIC_KEY || undefined,
      deployToken: env.OPENPURPOSE_OPENVERSION_DEPLOY_TOKEN || undefined,
    },
    openAnnounce: {
      url: env.OPENPURPOSE_OPENANNOUNCE_URL?.replace(/\/$/, '') || undefined,
      publicKey: env.OPENPURPOSE_OPENANNOUNCE_PUBLIC_KEY || undefined,
      signingSecret: env.OPENPURPOSE_OPENANNOUNCE_SIGNING_SECRET || undefined,
    },
    fetch: env.OPENPURPOSE_FETCH === 'private' ? 'private' : 'public',
    fetchAllow: (env.OPENPURPOSE_FETCH_ALLOW ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  };
}

/** The fetch policy integrations use, from OPENPURPOSE_FETCH and OPENPURPOSE_FETCH_ALLOW. */
export const integrationFetchPolicy = (config: Config): FetchPolicy => ({
  mode: config.fetch,
  allow: config.fetchAllow,
  envPrefix: 'OPENPURPOSE',
});

function trustProxy(value: string | undefined): boolean | string {
  const v = (value ?? '').trim();
  if (!v || v === 'false' || v === 'off') return false;
  return v === 'true' || v === 'on' ? true : v;
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
