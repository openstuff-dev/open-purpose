import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { SignInError } from '../src/auth/providers/provider.js';
import { createSupabaseProvider, identityOf } from '../src/auth/providers/supabase.js';

const config: AuthConfig = {
  provider: 'supabase',
  signup: 'approval',
  supabaseUrl: 'https://abc.supabase.co/',
  supabaseKey: 'sb_publishable_test',
  siteUrl: '',
  sessionDays: 30,
};
const callbackUrl = 'https://purpose.example.com/api/auth/callback';
const magicLink = { kind: 'magic_link' } as const;
const github = { kind: 'oauth', provider: 'github', label: 'GitHub' } as const;

let fetchMock: ReturnType<typeof vi.fn>;
const answer = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
const request = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url: new URL(url), init, body: JSON.parse(init.body as string) };
};
const challengeOf = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('supabase provider', () => {
  it('needs a URL and a key', () => {
    expect(() => createSupabaseProvider({ ...config, supabaseKey: '' })).toThrow(
      /OPENPURPOSE_SUPABASE_KEY/,
    );
  });

  it('offers a magic link and GitHub', () => {
    expect(createSupabaseProvider(config).methods()).toEqual([magicLink, github]);
  });

  it('sends GitHub to /authorize with a PKCE challenge', async () => {
    const started = await createSupabaseProvider(config).start({ method: github, callbackUrl });
    const url = new URL(started.redirect!);
    expect(url.origin + url.pathname).toBe('https://abc.supabase.co/auth/v1/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      provider: 'github',
      redirect_to: callbackUrl,
      code_challenge: challengeOf(started.verifier!),
      code_challenge_method: 's256',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks /otp for a magic link', async () => {
    answer(200, {});
    const started = await createSupabaseProvider(config).start({
      method: magicLink,
      email: 'ada@example.com',
      callbackUrl,
    });
    expect(started.emailSent).toBe(true);
    const { url, init, body } = request();
    expect(url.pathname).toBe('/auth/v1/otp');
    expect(url.searchParams.get('redirect_to')).toBe(callbackUrl);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).apikey).toBe('sb_publishable_test');
    expect(body).toEqual({
      email: 'ada@example.com',
      create_user: true,
      code_challenge: challengeOf(started.verifier!),
      code_challenge_method: 's256',
    });
  });

  it('creates no Supabase user when sign-ups are off, and says the same either way', async () => {
    answer(422, { code: 'otp_disabled', msg: 'Signups not allowed for otp' });
    const started = await createSupabaseProvider({ ...config, signup: 'off' }).start({
      method: magicLink,
      email: 'stranger@example.com',
      callbackUrl,
    });
    expect(request().body.create_user).toBe(false);
    expect(started.emailSent).toBe(true);
  });

  it('passes on rate limits and bad emails', async () => {
    const p = createSupabaseProvider(config);
    const start = () => p.start({ method: magicLink, email: 'ada@example.com', callbackUrl });
    answer(429, { code: 'over_email_send_rate_limit', msg: 'Email rate limit exceeded' });
    await expect(start()).rejects.toMatchObject({ code: 'too_many_requests' });
    answer(400, { error_code: 'validation_failed', msg: 'Unable to validate email address' });
    await expect(start()).rejects.toThrow(AppError);
    answer(500, {});
    await expect(start()).rejects.not.toThrow(AppError);
  });

  it('trades the code for the user', async () => {
    answer(200, {
      access_token: 'jwt',
      user: { id: 'u-1', email: 'Ada@Example.com', user_metadata: { full_name: 'Ada Lovelace' } },
    });
    const identity = await createSupabaseProvider(config).finish({
      query: { code: 'c-1' },
      verifier: 'v-1',
    });
    const { url, body } = request();
    expect(url.pathname).toBe('/auth/v1/token');
    expect(url.searchParams.get('grant_type')).toBe('pkce');
    expect(body).toEqual({ auth_code: 'c-1', code_verifier: 'v-1' });
    expect(identity).toEqual({
      provider: 'supabase',
      subject: 'u-1',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    });
  });

  it.each([
    ['an error in the callback', { error: 'access_denied', error_code: 'otp_expired' }, 'v', 'failed'],
    ['no code', {}, 'v', 'failed'],
    ['no verifier cookie (another browser)', { code: 'c' }, undefined, 'other-browser'],
  ])('refuses %s', async (_, query, verifier, reason) => {
    const finish = createSupabaseProvider(config).finish({ query, verifier });
    await expect(finish).rejects.toThrow(SignInError);
    await expect(finish).rejects.toMatchObject({ reason });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['bad_code_verifier', 'other-browser'],
    ['flow_state_not_found', 'failed'],
  ])('maps a failed exchange (%s) to %s', async (code, reason) => {
    answer(400, { code, msg: 'nope' });
    await expect(
      createSupabaseProvider(config).finish({ query: { code: 'c' }, verifier: 'v' }),
    ).rejects.toMatchObject({ reason });
  });
});

describe('identityOf', () => {
  it('falls back from full_name to name to the GitHub login', () => {
    expect(identityOf({ id: 'a', user_metadata: { name: ' Ada ' } }).name).toBe('Ada');
    expect(identityOf({ id: 'a', user_metadata: { full_name: '', user_name: 'ada' } }).name).toBe(
      'ada',
    );
    expect(identityOf({ id: 'a', email: '' })).toEqual({
      provider: 'supabase',
      subject: 'a',
      email: null,
      name: null,
    });
  });
});
