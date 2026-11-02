/**
 * Browser sessions for people who sign in through a provider instead of pasting a token.
 *
 * A session is an api_tokens row with kind = 'session' and an expiry, so every route that takes a
 * bearer token takes a session too. The sign-in callback never puts the token in a URL: it issues
 * a one-time code (60 s) that the web app swaps for the token.
 *
 * Who gets a session is decided here too, the same for every provider: see actorForIdentity.
 */
import crypto from 'node:crypto';
import type {
  AuthStatus,
  PendingSignup,
  SignupMode,
  SignupStatus,
} from '@openpurpose/contracts';
import { type Actor, generateToken, hashToken, requireSuperadmin, tokenPrefix } from '../auth.js';
import {
  type AuthProvider,
  type ExternalIdentity,
  type Invitation,
  SignInError,
} from '../auth/providers/index.js';
import type { Pool, Queryable } from '../db.js';
import { tx } from '../db.js';
import { AppError, badRequest, notFound } from '../errors.js';
import {
  type ActorState,
  freeGroupSlug,
  lockEmail,
  personByEmail,
  provisionWorkspace,
} from './admin.js';
import type { Group, Organization } from './types.js';

const CODE_SECONDS = 60;
/** Supabase's magic links last an hour by default and 24 hours at most. */
const INVITE_SECONDS = 24 * 3600;

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

// ───────────────────────────── identities and sign-up ─────────────────────────────

/**
 * Who a provider's identity signs in as. A known identity signs its actor in. An unknown one
 * with a verified email joins the person who already has that email: someone an admin added by
 * email, or who signed in another way before. Otherwise it depends on OPENPURPOSE_SIGNUP: off
 * refuses it, approval adds a pending person, open adds a person with their own workspace. A
 * pending person signs in too, to see that they're waiting.
 */
export async function actorForIdentity(
  pool: Pool,
  signup: SignupMode,
  identity: ExternalIdentity,
): Promise<string> {
  const email = identity.emailVerified ? identity.email?.trim().toLowerCase() || null : null;
  const { actorId, created } = await tx(pool, async (c) => {
    // Two callbacks for the same new identity must not create two people.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `identity:${identity.provider}:${identity.subject}`,
    ]);
    const { rows } = await c.query<ActorState & { actor_id: string }>(
      `UPDATE identities i SET last_sign_in_at = now(), email = COALESCE($3, i.email)
         FROM actors a
        WHERE a.id = i.actor_id AND i.provider = $1 AND i.subject = $2
        RETURNING i.actor_id, a.signup, a.disabled_at IS NOT NULL AS disabled`,
      [identity.provider, identity.subject, identity.email],
    );
    const known = rows.at(0);
    if (known) {
      mayEnter(known);
      return { actorId: known.actor_id, created: false };
    }
    let actorId: string | null = null;
    let created = false;
    if (email) {
      // Nor two new identities with the same email, or an invite at the same moment.
      await lockEmail(c, email);
      const same = await personByEmail(c, email);
      if (same) {
        mayEnter(same);
        actorId = same.id;
      }
    }
    if (!actorId) {
      if (signup === 'off')
        throw new SignInError('no-account', 'Unknown identity and OPENPURPOSE_SIGNUP=off');
      // Open sign-ups start as pending too, so a person whose workspace couldn't be made waits
      // for an admin instead of being stuck. Only a verified email is kept on the person, so an
      // unverified one can never pull someone else's identity in later.
      const { rows: actor } = await c.query<{ id: string }>(
        `INSERT INTO actors (name, kind, email, signup, signup_at)
         VALUES ($1, 'human', $2, 'pending', now()) RETURNING id`,
        [personName(identity), email],
      );
      actorId = actor[0].id;
      created = true;
    }
    await c.query(
      `INSERT INTO identities (actor_id, provider, subject, email, method, last_sign_in_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [actorId, identity.provider, identity.subject, identity.email, identity.method ?? null],
    );
    return { actorId, created };
  });
  if (created && signup === 'open') {
    try {
      await approve(pool, actorId, personName(identity));
    } catch {
      // They stay pending; a server admin can approve them by hand.
    }
  }
  return actorId;
}

function mayEnter(actor: ActorState): void {
  if (actor.disabled) throw new SignInError('disabled', 'This account is turned off');
  if (actor.signup === 'rejected') throw new SignInError('rejected', 'This sign-up was turned down');
}

// ───────────────────────────── adding people by email ─────────────────────────────

/** Whether an admin added a person with this email, so they may get a link with sign-up off. */
export async function isInvited(pool: Pool, email: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM actors WHERE kind = 'human' AND lower(email) = $1
        AND disabled_at IS NULL AND signup IS DISTINCT FROM 'rejected' LIMIT 1`,
    [email.toLowerCase()],
  );
  return rows.length > 0;
}

/**
 * Ask the provider to email someone an admin added a magic link. They open it in their own
 * browser, which has no verifier cookie, so the link carries an ?invite= id and the verifier
 * waits here (see takeInviteVerifier). Returns whether an email went out.
 */
export async function sendInviteLink(
  pool: Pool,
  provider: AuthProvider,
  email: string,
  callbackUrl: string,
  invitation: Invitation,
): Promise<{ sent: boolean; notice?: { level: 'info' | 'warn'; message: string } }> {
  const id = crypto.randomBytes(24).toString('base64url');
  const started = await provider.start({
    method: { kind: 'magic_link' },
    email,
    callbackUrl: `${callbackUrl}?invite=${id}`,
    allowNewUser: true,
    invitation,
  });
  if (started.verifier) {
    await pool.query(
      `INSERT INTO invite_links (id_hash, verifier, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))`,
      [hashToken(id), started.verifier, INVITE_SECONDS],
    );
  }
  // The provider answers "sent" even when it refused, so the sign-in form gives nothing away;
  // its notice says why.
  return { sent: !!started.emailSent && !started.notice, notice: started.notice };
}

/** The verifier for an invite link. Works once. */
export async function takeInviteVerifier(pool: Pool, id: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ verifier: string; live: boolean }>(
    'DELETE FROM invite_links WHERE id_hash = $1 RETURNING verifier, expires_at > now() AS live',
    [hashToken(id)],
  );
  pool.query('DELETE FROM invite_links WHERE expires_at < now()').catch(() => undefined);
  const row = rows.at(0);
  return row?.live ? row.verifier : undefined;
}

function personName(identity: ExternalIdentity): string {
  return identity.name?.trim() || identity.email?.split('@')[0] || 'New person';
}

/** Where the signed-in person is with their sign-up. Needs no workspace. */
export async function status(pool: Pool, actor: Actor): Promise<AuthStatus> {
  const { rows } = await pool.query<AuthStatus>(
    'SELECT name, email, signup FROM actors WHERE id = $1',
    [actor.id],
  );
  return rows[0];
}

export async function listSignups(
  pool: Pool,
  actor: Actor,
  signup: SignupStatus,
): Promise<PendingSignup[]> {
  requireSuperadmin(actor);
  const { rows } = await pool.query<PendingSignup>(
    `SELECT a.id, a.name, a.email, a.signup, a.signup_at, i.provider, i.method
       FROM actors a
       LEFT JOIN LATERAL (SELECT provider, method FROM identities WHERE actor_id = a.id
                           ORDER BY created_at LIMIT 1) i ON true
      WHERE a.signup = $1 ORDER BY a.signup_at`,
    [signup],
  );
  return rows;
}

/** Approve a pending sign-up: the person gets a workspace of their own and is its admin. */
export async function approveSignup(
  pool: Pool,
  actor: Actor,
  actorId: string,
  workspace: string,
): Promise<{ group: Group; organization: Organization }> {
  requireSuperadmin(actor);
  if (!workspace.trim()) throw badRequest('workspace is required');
  return approve(pool, actorId, workspace, actor.id);
}

async function approve(
  pool: Pool,
  actorId: string,
  workspace: string,
  approvedBy: string | null = null,
): Promise<{ group: Group; organization: Organization }> {
  // Claiming it first means two approvals can't both make a workspace.
  const { rowCount } = await pool.query(
    `UPDATE actors SET signup = 'approved' WHERE id = $1 AND signup = 'pending'`,
    [actorId],
  );
  if (!rowCount) throw await notPending(pool, actorId);
  for (let attempt = 1; ; attempt++) {
    try {
      return await provisionWorkspace(pool, actorId, {
        name: workspace,
        slug: await freeGroupSlug(pool, workspace),
        created_by: approvedBy ?? actorId,
      });
    } catch (err) {
      // Someone with the same name signed up at the same moment and took the free slug: pick
      // the next one.
      if (attempt < 5 && isSlugTaken(err)) continue;
      await pool.query(`UPDATE actors SET signup = 'pending' WHERE id = $1`, [actorId]);
      throw err;
    }
  }
}

const isSlugTaken = (err: unknown) =>
  err instanceof AppError && err.code === 'conflict' && err.message.includes('groups_slug_key');

/** Turn a pending sign-up down. They can't sign in again, and their sessions end now. */
export async function rejectSignup(pool: Pool, actor: Actor, actorId: string): Promise<void> {
  requireSuperadmin(actor);
  await tx(pool, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE actors SET signup = 'rejected' WHERE id = $1 AND signup = 'pending'`,
      [actorId],
    );
    if (!rowCount) throw await notPending(c, actorId);
    await c.query(
      `UPDATE api_tokens SET revoked_at = now()
        WHERE actor_id = $1 AND kind = 'session' AND revoked_at IS NULL`,
      [actorId],
    );
  });
}

async function notPending(c: Queryable, actorId: string): Promise<AppError> {
  const { rows } = await c.query<{ signup: SignupStatus | null }>(
    'SELECT signup FROM actors WHERE id = $1',
    [actorId],
  );
  const row = rows.at(0);
  if (!row?.signup) return notFound('Sign-up');
  return new AppError('conflict', `This sign-up was already ${row.signup}`);
}
