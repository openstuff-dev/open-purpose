/**
 * Browser sessions for people who sign in through a provider instead of pasting a token.
 *
 * A session is an api_tokens row with kind = 'session' and an expiry, so every route that takes a
 * bearer token takes a session too. The sign-in callback never puts the token in a URL: it issues
 * a one-time code (60 s) that the web app swaps for the token.
 */
import crypto from 'node:crypto';
import { generateToken, hashToken, tokenPrefix } from '../auth.js';
import type { Pool, Queryable } from '../db.js';
import { AppError } from '../errors.js';

const CODE_SECONDS = 60;

/** Issue a session token for an actor that expires after `days`. */
export async function createSession(c: Queryable, actorId: string, days: number): Promise<string> {
  const token = generateToken();
  await c.query(
    `INSERT INTO api_tokens (actor_id, token_hash, prefix, label, kind, expires_at)
     VALUES ($1, $2, $3, 'browser session', 'session', now() + make_interval(secs => $4))`,
    [actorId, hashToken(token), tokenPrefix(token), days * 86_400],
  );
  return token;
}

/** A one-time code the web app swaps for a new session (see exchangeAuthCode). */
export async function issueAuthCode(c: Queryable, actorId: string): Promise<string> {
  const code = crypto.randomBytes(24).toString('base64url');
  await c.query(
    `INSERT INTO auth_codes (code_hash, actor_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [hashToken(code), actorId, CODE_SECONDS],
  );
  return code;
}

/** Swap a one-time code for a session token. A code works once, and only within 60 seconds. */
export async function exchangeAuthCode(pool: Pool, code: string, days: number): Promise<string> {
  // Deleting it first means two requests with the same code can't both win.
  const { rows } = await pool.query<{ actor_id: string; live: boolean }>(
    'DELETE FROM auth_codes WHERE code_hash = $1 RETURNING actor_id, expires_at > now() AS live',
    [hashToken(code)],
  );
  const row = rows.at(0);
  if (!row?.live)
    throw new AppError('unauthorized', 'This sign-in link has expired or was already used. Sign in again.');
  // Old codes nobody swapped are of no use to anyone.
  pool.query('DELETE FROM auth_codes WHERE expires_at < now()').catch(() => undefined);
  return createSession(pool, row.actor_id, days);
}

/** Revoke the session behind this token. API tokens are left alone: revoke those in settings. */
export async function signOut(pool: Pool, token: string): Promise<void> {
  await pool.query(
    `UPDATE api_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND kind = 'session' AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}
