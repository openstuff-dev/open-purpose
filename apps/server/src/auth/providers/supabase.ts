/**
 * Sign-in through Supabase Auth: a magic link by email, and GitHub. Talks to its REST API with
 * fetch (no supabase-js on the server). Both methods use PKCE and end on our callback with
 * `?code=…`, which finish() trades for the user. The endpoints follow auth-js (GoTrueClient).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AuthMethod } from '@openpurpose/contracts';
import type { AuthConfig } from '../../config.js';
import { AppError, badRequest } from '../../errors.js';
import { type AuthProvider, type ExternalIdentity, SignInError } from './provider.js';

interface SupabaseUser {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown>;
}

/** Supabase's error body. Newer API versions say `code`, older ones `error_code`. */
interface SupabaseError {
  code?: string | number;
  error_code?: string;
  msg?: string;
  message?: string;
  error_description?: string;
  error?: string;
}

export function createSupabaseProvider(config: AuthConfig): AuthProvider {
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error(
      'OPENPURPOSE_AUTH_PROVIDER=supabase needs OPENPURPOSE_SUPABASE_URL and OPENPURPOSE_SUPABASE_KEY',
    );
  }
  const base = `${config.supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
  const headers = { apikey: config.supabaseKey, 'content-type': 'application/json' };

  async function call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & SupabaseError;
    if (!res.ok) throw new SupabaseRequestError(res.status, data);
    return data;
  }

  return {
    id: 'supabase',
    methods: (): AuthMethod[] => [
      { kind: 'magic_link' },
      { kind: 'oauth', provider: 'github', label: 'GitHub' },
    ],

    async start({ method, email, callbackUrl }) {
      const verifier = randomBytes(32).toString('base64url');
      const pkce = {
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 's256',
      };
      if (method.kind === 'oauth') {
        const query = new URLSearchParams({
          provider: method.provider,
          redirect_to: callbackUrl,
          ...pkce,
        });
        return { redirect: `${base}/authorize?${query}`, verifier };
      }
      try {
        await call(`/otp?${new URLSearchParams({ redirect_to: callbackUrl })}`, {
          email,
          // With sign-ups off, only people Supabase already knows get a link.
          create_user: config.signup !== 'off',
          ...pkce,
        });
      } catch (err) {
        if (!(err instanceof SupabaseRequestError)) throw err;
        // Answer the same as for a sent link, so the form doesn't tell who has an account.
        if (err.code === 'otp_disabled' || err.code === 'signup_disabled')
          return { emailSent: true, verifier };
        if (err.status === 429)
          throw new AppError('too_many_requests', 'Too many sign-in emails. Try again in a few minutes.');
        if (err.status < 500) throw badRequest(err.message);
        throw err;
      }
      return { emailSent: true, verifier };
    },

    async finish({ query, verifier }) {
      if (query.error || query.error_code) {
        throw new SignInError(
          'failed',
          `Supabase sent back ${query.error_code || query.error}: ${query.error_description || ''}`,
        );
      }
      if (!query.code) throw new SignInError('failed', 'The callback has no code');
      // The verifier cookie is missing when a magic link is opened in another browser.
      if (!verifier) throw new SignInError('other-browser', 'No PKCE verifier cookie');
      let user: SupabaseUser | undefined;
      try {
        ({ user } = await call<{ user?: SupabaseUser }>('/token?grant_type=pkce', {
          auth_code: query.code,
          code_verifier: verifier,
        }));
      } catch (err) {
        if (!(err instanceof SupabaseRequestError)) throw err;
        // A verifier from another sign-in in this browser: the link belongs to a different one.
        const reason = err.code === 'bad_code_verifier' ? 'other-browser' : 'failed';
        throw new SignInError(reason, `Code exchange failed (${err.status}): ${err.message}`);
      }
      if (!user?.id) throw new SignInError('failed', 'The code exchange returned no user');
      return identityOf(user);
    },
  };
}

/** Exported for tests. */
export function identityOf(user: SupabaseUser): ExternalIdentity {
  const meta = user.user_metadata ?? {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    provider: 'supabase',
    subject: user.id,
    email: text(user.email)?.toLowerCase() ?? null,
    // GitHub fills full_name or name; user_name is the GitHub login.
    name: text(meta.full_name) ?? text(meta.name) ?? text(meta.user_name),
  };
}

class SupabaseRequestError extends Error {
  readonly code: string | null;

  constructor(
    readonly status: number,
    body: SupabaseError,
  ) {
    super(
      body.msg ?? body.message ?? body.error_description ?? body.error ?? `Supabase answered ${status}`,
    );
    this.code =
      typeof body.code === 'string' ? body.code : typeof body.error_code === 'string' ? body.error_code : null;
  }
}
