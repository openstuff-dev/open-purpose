import crypto from 'node:crypto';
import type { Pool } from './db.js';
import { withScope } from './db.js';
import { AppError, forbidden } from './errors.js';
import type { Actor, GroupRef, Role } from '@openpurpose/contracts';

export type { Actor, ActorKind, GroupRef, Role } from '@openpurpose/contracts';

export interface Membership {
  group_id: string;
  /** null = a role in the group itself. */
  organization_id: string | null;
  role: Role;
}

export interface OrgRef {
  id: string;
  slug: string;
  name: string;
  archived_at: string | null;
  /** Old slugs the organization still answers to. */
  aliases: string[];
}

/**
 * Who is asking, in which group, and what they may do there. Built once per
 * request (or MCP tool call) and passed to every service.
 */
export class Access {
  constructor(
    readonly actor: Actor,
    readonly group: GroupRef,
    /** Every organization in the group (names are not secret inside a group). */
    readonly orgs: OrgRef[],
    /** The actor's memberships in this group. */
    readonly memberships: Membership[],
    /** reader org id → org ids it may read. */
    readonly grants: Map<string, Set<string>>,
    /** The organization this request works in: an agent's own, or the one a person picked. */
    readonly orgId: string | null,
  ) {}

  get isAgent(): boolean {
    return this.actor.kind === 'agent';
  }

  /** The actor's role on the group itself (server admins count as group admins). */
  get groupRole(): Role | null {
    if (this.actor.is_superadmin && !this.isAgent) return 'admin';
    return this.memberships.find((m) => m.organization_id === null)?.role ?? null;
  }

  /** The actor's effective role in an organization. */
  orgRole(orgId: string): Role | null {
    const own = this.memberships.find((m) => m.organization_id === orgId)?.role ?? null;
    const viaGroup = this.groupRole;
    if (viaGroup === 'admin') return 'admin';
    if (own) return own;
    return viaGroup ? 'viewer' : null;
  }

  /** Read access to a level. orgId null = group-wide content, readable by everyone in the group. */
  canRead(orgId: string | null): boolean {
    if (orgId === null) return this.groupRole !== null || this.memberships.length > 0;
    if (this.orgRole(orgId)) return true;
    return this.memberships.some(
      (m) => m.organization_id && this.grants.get(m.organization_id)?.has(orgId),
    );
  }

  /** People who may edit content and review proposals at a level. */
  canEdit(orgId: string | null): boolean {
    if (this.isAgent) return false;
    const role = orgId === null ? this.groupRole : this.orgRole(orgId);
    return role === 'admin' || role === 'editor';
  }

  /** People who may manage members and settings at a level. */
  canAdmin(orgId: string | null): boolean {
    if (this.isAgent) return false;
    return (orgId === null ? this.groupRole : this.orgRole(orgId)) === 'admin';
  }

  /**
   * Agents may write (subject to edit modes) in their own organization and to group-wide content.
   */
  canAgentWrite(orgId: string | null): boolean {
    if (!this.isAgent) return false;
    return orgId === null || this.memberships.some((m) => m.organization_id === orgId);
  }

  /** May create proposals or apply mode-governed edits at this level. */
  canContribute(orgId: string | null): boolean {
    return this.canEdit(orgId) || this.canAgentWrite(orgId);
  }

  readableOrgIds(): string[] {
    return this.orgs.filter((o) => this.canRead(o.id)).map((o) => o.id);
  }

  org(id: string | null): OrgRef | null {
    return id ? (this.orgs.find((o) => o.id === id) ?? null) : null;
  }

  orgBySlug(slug: string): OrgRef | null {
    const s = slug.toLowerCase();
    return (
      this.orgs.find((o) => o.slug === s || o.id === slug) ??
      this.orgs.find((o) => o.aliases.includes(s)) ??
      null
    );
  }

  requireRead(orgId: string | null, what = 'this'): void {
    if (!this.canRead(orgId)) {
      const org = this.org(orgId);
      throw forbidden(
        `You don't have access to ${org ? `the ${org.name} organization` : what}. Ask a group admin for read access.`,
      );
    }
  }

  requireEdit(orgId: string | null): void {
    if (!this.canEdit(orgId))
      throw forbidden(`Only editors and admins of ${this.levelName(orgId)} can do this`);
  }

  requireAdmin(orgId: string | null): void {
    if (!this.canAdmin(orgId))
      throw forbidden(`Only admins of ${this.levelName(orgId)} can do this`);
  }

  requireContribute(orgId: string | null): void {
    if (!this.canContribute(orgId)) {
      if (this.isAgent)
        throw forbidden(
          'Agents can only write to their own organization and to group-wide content',
        );
      throw forbidden(`Viewers are read-only in ${this.levelName(orgId)}`);
    }
  }

  levelName(orgId: string | null): string {
    return this.org(orgId)?.name ?? this.group.name;
  }
}

const TOKEN_PREFIX = 'chr_';

export function generateToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Short, non-secret prefix shown in the UI so people can tell tokens apart. */
export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + 6);
}

export function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim();
}

export async function actorFromToken(pool: Pool, token: string | undefined): Promise<Actor> {
  if (!token) throw new AppError('unauthorized', 'Missing bearer token');
  const { rows } = await pool.query<Actor & { token_id: string }>(
    `SELECT a.id, a.name, a.kind, a.is_superadmin, t.id AS token_id
       FROM api_tokens t JOIN actors a ON a.id = t.actor_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND a.disabled_at IS NULL`,
    [hashToken(token)],
  );
  const row = rows.at(0);
  if (!row) throw new AppError('unauthorized', 'Invalid or revoked token');
  pool
    .query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.token_id])
    // Only a convenience for the token list; never fail a request over it.
    .catch(() => undefined);
  return { id: row.id, name: row.name, kind: row.kind, is_superadmin: row.is_superadmin };
}

/** The groups an actor belongs to (server admins: all groups). */
export async function groupsOf(pool: Pool, actor: Actor): Promise<GroupRef[]> {
  return withScope(pool, { groupId: null, bypass: true }, async (c) => {
    const { rows } = await c.query<GroupRef>(
      actor.is_superadmin && actor.kind === 'human'
        ? 'SELECT id, slug, name FROM groups ORDER BY name'
        : `SELECT DISTINCT g.id, g.slug, g.name FROM memberships m JOIN groups g ON g.id = m.group_id
            WHERE m.actor_id = $1 ORDER BY g.name`,
      actor.is_superadmin && actor.kind === 'human' ? [] : [actor.id],
    );
    return rows;
  });
}

/**
 * Build the Access for one request.
 * @param wantGroup group id or slug the client asked for (header); defaults to the actor's
 *   first group.
 * @param wantOrg organization id or slug the client works in (header/param); agents always get
 *   their own.
 */
export async function resolveAccess(
  pool: Pool,
  actor: Actor,
  wantGroup?: string | null,
  wantOrg?: string | null,
): Promise<Access> {
  const groups = await groupsOf(pool, actor);
  if (groups.length === 0) {
    throw new AppError(
      'forbidden',
      actor.is_superadmin
        ? 'There are no groups yet. Create one first.'
        : 'You are not a member of any group yet. Ask an admin to add you.',
    );
  }
  const group = wantGroup
    ? groups.find((g) => g.id === wantGroup || g.slug === wantGroup.toLowerCase())
    : groups[0];
  if (!group) throw new AppError('forbidden', 'You are not a member of that group');

  return withScope(pool, { groupId: group.id }, async (c) => {
    const orgs = await c.query<OrgRef>(`SELECT o.id, o.slug, o.name, o.archived_at,
              ARRAY(SELECT x.old_slug FROM slug_aliases x WHERE x.organization_id = o.id) AS aliases
         FROM organizations o ORDER BY o.name`);
    const memberships = await c.query<Membership>(
      'SELECT group_id, organization_id, role FROM memberships WHERE actor_id = $1',
      [actor.id],
    );
    const grants = await c.query<{ reader_org_id: string; target_org_id: string }>(
      'SELECT reader_org_id, target_org_id FROM org_read_grants',
    );
    const grantMap = new Map<string, Set<string>>();
    for (const g of grants.rows) {
      const targets = grantMap.get(g.reader_org_id) ?? new Set<string>();
      targets.add(g.target_org_id);
      grantMap.set(g.reader_org_id, targets);
    }
    let orgId: string | null = null;
    if (actor.kind === 'agent') {
      orgId = memberships.rows.find((m) => m.organization_id)?.organization_id ?? null;
    } else if (wantOrg) {
      // A remembered organization from another group is ignored rather than an error.
      orgId =
        orgs.rows.find((x) => x.id === wantOrg || x.slug === wantOrg.toLowerCase())?.id ?? null;
    }
    if (!orgId && actor.kind !== 'agent') {
      const own = memberships.rows.filter((m) => m.organization_id);
      if (own.length === 1) orgId = own[0].organization_id;
      else if (own.length === 0 && orgs.rows.length === 1) orgId = orgs.rows[0].id;
    }
    const probe = new Access(actor, group, orgs.rows, memberships.rows, grantMap, orgId);
    if (orgId && !probe.canRead(orgId)) orgId = null;
    return new Access(actor, group, orgs.rows, memberships.rows, grantMap, orgId);
  });
}

/**
 * What an agent in `orgId` would get, built from a person's access. Agent mode
 * in the UI uses this so people see exactly what agents read. It never widens
 * access: the person must be able to read everything that agent could read.
 */
export function agentViewOf(person: Access, orgId: string | null = person.orgId): Access {
  if (person.isAgent) return person;
  if (!orgId)
    throw new AppError('bad_request', 'Pick an organization first: agents always belong to one.');
  if (!canViewAsAgent(person, orgId)) {
    throw forbidden(
      `Agents in ${person.levelName(orgId)} can read organizations you can't, so you can't view as one of them.`,
    );
  }
  return simulatedAgent(person, orgId);
}

function simulatedAgent(person: Access, orgId: string): Access {
  return new Access(
    { ...person.actor, kind: 'agent', is_superadmin: false },
    person.group,
    person.orgs,
    [{ group_id: person.group.id, organization_id: orgId, role: 'agent' }],
    person.grants,
    orgId,
  );
}

/** Whether a person may use agent mode for agents in this organization. */
export function canViewAsAgent(person: Access, orgId: string): boolean {
  if (person.isAgent || !person.canRead(orgId)) return false;
  const view = simulatedAgent(person, orgId);
  return person.orgs.every((o) => !view.canRead(o.id) || person.canRead(o.id));
}

export function requireSuperadmin(actor: Actor): void {
  if (!(actor.is_superadmin && actor.kind === 'human'))
    throw forbidden('Only server admins can do this');
}
