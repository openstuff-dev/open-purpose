/**
 * Groups, organizations, people, agents, memberships, tokens and read grants.
 *
 * Who may do what:
 *  - Server admins create groups.
 *  - Group admins create organizations, grant read access between them, and manage everyone in the group.
 *  - Organization admins manage memberships and agents in their organization.
 */
import type { Access, Actor, ActorKind, Role } from '../auth.js';
import { generateToken, hashToken, requireSuperadmin, tokenPrefix } from '../auth.js';
import type { Db, Pool, Queryable } from '../db.js';
import { tx, withScope } from '../db.js';
import { AppError, badRequest, forbidden, mapPgError, notFound } from '../errors.js';
import { slugify } from '../domain/remote.js';
import { claimSlug } from './aliases.js';
import { insertDocument, insertSection } from './content.js';
import type { Group, Organization } from './types.js';
import type { SlugAlias } from '@openpurpose/contracts';

// ───────────────────────────── tokens ─────────────────────────────

async function insertToken(c: Queryable, actorId: string, label: string, token = generateToken()): Promise<string> {
  await c.query(
    'INSERT INTO api_tokens (actor_id, token_hash, prefix, label) VALUES ($1, $2, $3, $4)',
    [actorId, hashToken(token), tokenPrefix(token), label],
  );
  return token;
}

/** Number of other groups an actor belongs to. Tokens are personal, so they can only be managed where all of them live. */
async function otherGroups(pool: Pool, actorId: string, groupId: string): Promise<number> {
  return withScope(pool, { groupId: null, bypass: true }, async (c) => {
    const { rows } = await c.query<{ n: number }>(
      'SELECT count(DISTINCT group_id)::int AS n FROM memberships WHERE actor_id = $1 AND group_id <> $2', [actorId, groupId]);
    return rows[0].n;
  });
}

// ───────────────────────────── default content ─────────────────────────────

async function seedGroupDocs(c: Queryable, actorId: string | null): Promise<void> {
  const level = { organization_id: null, project_id: null, scope_id: null };
  const purpose = await insertDocument(c, level, { kind: 'purpose', title: 'Group purpose', slug: 'purpose', mode: 'locked', position: 0 });
  await insertSection(c, purpose.id, {
    heading: 'What holds for every organization',
    body: '_Rules every organization in the group follows: security, legal, privacy, brand._',
    mode: 'locked',
  }, actorId, 'Created with group');
  await insertDocument(c, level, { kind: 'guidelines', title: 'Group-wide guidelines', slug: 'guidelines', mode: 'propose', position: 1 });
}

async function seedOrgDocs(c: Queryable, orgId: string, actorId: string | null): Promise<void> {
  const level = { organization_id: orgId, project_id: null, scope_id: null };
  const purpose = await insertDocument(c, level, { kind: 'purpose', title: 'Organization purpose', slug: 'purpose', mode: 'locked', position: 0 });
  await insertSection(c, purpose.id, {
    heading: 'Who we are and what we build',
    body: '_Describe the organization, its customers and the quality bar every piece of software should meet._',
    mode: 'locked',
  }, actorId, 'Created with organization');
  const logic = await insertDocument(c, level, { kind: 'business_logic', title: 'Shared business logic', slug: 'business-logic', mode: 'propose', position: 1 });
  await insertSection(c, logic.id, {
    heading: 'Domain vocabulary',
    body: '_Define the terms every project uses (customer, order, tenant, ...), and what they mean here._',
    mode: 'propose',
  }, actorId, 'Created with organization');
  await insertDocument(c, level, { kind: 'guidelines', title: 'Engineering guidelines', slug: 'guidelines', mode: 'propose', position: 2 });
}

// ───────────────────────────── groups ─────────────────────────────

export async function listGroups(pool: Pool, actor: Actor): Promise<Array<Group & { organizations: number; members: number }>> {
  requireSuperadmin(actor);
  return withScope(pool, { groupId: null, bypass: true }, async (c) => {
    const { rows } = await c.query<Group & { organizations: number; members: number }>(
      `SELECT g.id, g.slug, g.name, g.created_at,
              (SELECT count(*)::int FROM organizations o WHERE o.group_id = g.id) AS organizations,
              (SELECT count(DISTINCT actor_id)::int FROM memberships m WHERE m.group_id = g.id) AS members
         FROM groups g ORDER BY g.name`);
    return rows;
  });
}

/**
 * Create a group with its first organization. The first admin is either the
 * calling server admin, or a new person whose token is returned once.
 */
export async function createGroup(
  pool: Pool, actor: Actor,
  input: { name: string; slug?: string; organization_name: string; organization_slug?: string; admin_name?: string },
): Promise<{ group: Group; organization: Organization; token?: string }> {
  requireSuperadmin(actor);
  if (!input.name?.trim()) throw badRequest('name is required');
  if (!input.organization_name?.trim()) throw badRequest('organization_name is required');
  try {
    const { rows } = await pool.query<Group>(
      'INSERT INTO groups (slug, name) VALUES ($1, $2) RETURNING id, slug, name, created_at',
      [input.slug || slugify(input.name), input.name.trim()]);
    const group = rows[0];
    try {
      return await withScope(pool, { groupId: group.id }, async (c) => {
        const org = await insertOrganization(c, { name: input.organization_name, slug: input.organization_slug }, actor.id);
        await seedGroupDocs(c, actor.id);
        let token: string | undefined;
        let adminId = actor.id;
        if (input.admin_name?.trim()) {
          const { rows: a } = await c.query<{ id: string }>(`INSERT INTO actors (name, kind) VALUES ($1, 'human') RETURNING id`, [input.admin_name.trim()]);
          adminId = a[0].id;
          token = await insertToken(c, adminId, 'first sign-in');
        }
        await c.query(`INSERT INTO memberships (actor_id, organization_id, role) VALUES ($1, NULL, 'admin')`, [adminId]);
        return { group, organization: org, token };
      });
    } catch (err) {
      await pool.query('DELETE FROM groups WHERE id = $1', [group.id]);
      throw err;
    }
  } catch (err) {
    throw mapPgError(err);
  }
}

export async function renameGroup(db: Db, a: Access, name: string): Promise<void> {
  a.requireAdmin(null);
  if (!name.trim()) throw badRequest('name is required');
  await db.query('UPDATE groups SET name = $2 WHERE id = $1', [a.group.id, name.trim()]);
}

// ───────────────────────────── organizations ─────────────────────────────

export interface OrgListItem extends Organization {
  readable: boolean;
  role: Role | null;
  projects: number | null;
  /** Organizations whose members may read this one. */
  readers: string[];
  /** Old slugs it still answers to. */
  aliases: SlugAlias[];
}

export async function listOrganizations(db: Queryable, a: Access): Promise<OrgListItem[]> {
  const { rows } = await db.query<Organization & { projects: number; aliases: SlugAlias[] }>(
    `SELECT o.id, o.slug, o.name, o.summary, o.created_at, o.archived_at,
            (SELECT count(*)::int FROM projects p WHERE p.organization_id = o.id AND p.archived_at IS NULL) AS projects,
            COALESCE((SELECT json_agg(json_build_object('id', x.id, 'old_slug', x.old_slug, 'created_at', x.created_at) ORDER BY x.created_at DESC)
                        FROM slug_aliases x WHERE x.organization_id = o.id), '[]') AS aliases
       FROM organizations o ORDER BY o.archived_at NULLS FIRST, o.name`);
  const readers = new Map<string, string[]>();
  for (const [reader, targets] of a.grants) {
    for (const t of targets) readers.set(t, [...(readers.get(t) ?? []), reader]);
  }
  return rows.map((o) => {
    const readable = a.canRead(o.id);
    return {
      ...o,
      summary: readable ? o.summary : '',
      readable,
      role: a.orgRole(o.id),
      projects: readable ? o.projects : null,
      readers: readers.get(o.id) ?? [],
    };
  });
}

async function insertOrganization(c: Queryable, input: { name: string; slug?: string; summary?: string }, actorId: string | null): Promise<Organization> {
  const { rows } = await c.query<Organization>(
    `INSERT INTO organizations (slug, name, summary) VALUES ($1, $2, $3)
     RETURNING id, slug, name, summary, created_at, archived_at`,
    [input.slug || slugify(input.name), input.name.trim(), input.summary ?? '']);
  await seedOrgDocs(c, rows[0].id, actorId);
  return rows[0];
}

export async function createOrganization(
  db: Db, a: Access, input: { name: string; slug?: string; summary?: string; take_alias?: boolean },
): Promise<Organization> {
  a.requireAdmin(null);
  if (!input.name?.trim()) throw badRequest('name is required');
  const slug = input.slug || slugify(input.name);
  try {
    return await tx(db, async (c) => {
      await claimSlug(c, 'organization', {}, slug, null, input.take_alias);
      return insertOrganization(c, { ...input, slug }, a.actor.id);
    });
  } catch (err) {
    throw mapPgError(err);
  }
}

export async function updateOrganization(
  db: Db, a: Access, id: string, input: { name?: string; slug?: string; summary?: string; archived?: boolean },
): Promise<Organization> {
  a.requireAdmin(id);
  if (input.slug !== undefined || input.archived !== undefined) a.requireAdmin(null);
  try {
    const { rows } = await db.query<Organization>(
      `UPDATE organizations SET name = COALESCE($2, name), slug = COALESCE($3, slug), summary = COALESCE($4, summary),
              archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN COALESCE(archived_at, now()) ELSE NULL END
        WHERE id = $1 RETURNING id, slug, name, summary, created_at, archived_at`,
      [id, input.name?.trim() || null, input.slug?.toLowerCase() || null, input.summary ?? null, input.archived ?? null]);
    if (!rows[0]) throw notFound('Organization');
    return rows[0];
  } catch (err) {
    throw mapPgError(err);
  }
}

/** Let members of `reader` read `target`. Group admins only. */
export async function setReadGrant(db: Db, a: Access, readerId: string, targetId: string, allowed: boolean): Promise<void> {
  a.requireAdmin(null);
  if (readerId === targetId) throw badRequest('An organization can always read itself');
  if (!a.org(readerId) || !a.org(targetId)) throw notFound('Organization');
  if (allowed) {
    await db.query(
      'INSERT INTO org_read_grants (reader_org_id, target_org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [readerId, targetId]);
  } else {
    await db.query('DELETE FROM org_read_grants WHERE reader_org_id = $1 AND target_org_id = $2', [readerId, targetId]);
  }
}

// ───────────────────────────── people and agents ─────────────────────────────

export interface MemberRow {
  id: string;
  name: string;
  kind: ActorKind;
  is_superadmin: boolean;
  disabled_at: string | null;
  created_at: string;
  memberships: Array<{ id: string; organization_id: string | null; role: Role }>;
  tokens: Array<{ id: string; prefix: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>;
  /** Whether the viewer may manage this person's or agent's tokens and account. */
  manageable: boolean;
}

/** Everyone the viewer administers: the whole group for group admins, their organizations otherwise. */
export async function listMembers(db: Queryable, pool: Pool, a: Access): Promise<MemberRow[]> {
  const adminOrgs = a.orgs.filter((o) => a.canAdmin(o.id)).map((o) => o.id);
  if (!a.canAdmin(null) && adminOrgs.length === 0) throw forbidden('Only admins can manage people and agents');
  const { rows } = await db.query<Omit<MemberRow, 'manageable'>>(
    `SELECT a.id, a.name, a.kind, a.is_superadmin, a.disabled_at, a.created_at,
            json_agg(json_build_object('id', m.id, 'organization_id', m.organization_id, 'role', m.role)
                     ORDER BY m.organization_id NULLS FIRST) AS memberships,
            COALESCE((SELECT json_agg(json_build_object('id', t.id, 'prefix', t.prefix, 'label', t.label,
                       'created_at', t.created_at, 'last_used_at', t.last_used_at, 'revoked_at', t.revoked_at) ORDER BY t.created_at)
                        FROM api_tokens t WHERE t.actor_id = a.id), '[]') AS tokens
       FROM memberships m JOIN actors a ON a.id = m.actor_id
      WHERE $1 OR m.organization_id = ANY($2::uuid[])
      GROUP BY a.id ORDER BY a.kind DESC, a.name`,
    [a.canAdmin(null), adminOrgs],
  );
  const out: MemberRow[] = [];
  for (const r of rows) out.push({ ...r, manageable: await canManageActor(pool, a, r.id, r.kind, r.memberships) });
  return out;
}

async function canManageActor(
  pool: Pool, a: Access, actorId: string, kind: ActorKind, memberships: Array<{ organization_id: string | null }>,
): Promise<boolean> {
  if (actorId === a.actor.id) return true;
  if (a.actor.is_superadmin) return true;
  const levelsOk = memberships.every((m) => a.canAdmin(m.organization_id));
  if (!levelsOk) return false;
  return (await otherGroups(pool, actorId, a.group.id)) === 0 || kind === 'agent';
}

async function loadMember(db: Queryable, actorId: string) {
  const { rows } = await db.query<{ id: string; name: string; kind: ActorKind; memberships: Array<{ id: string; organization_id: string | null; role: Role }> }>(
    `SELECT a.id, a.name, a.kind,
            COALESCE(json_agg(json_build_object('id', m.id, 'organization_id', m.organization_id, 'role', m.role))
                     FILTER (WHERE m.id IS NOT NULL), '[]') AS memberships
       FROM actors a LEFT JOIN memberships m ON m.actor_id = a.id
      WHERE a.id = $1 GROUP BY a.id`,
    [actorId]);
  if (!rows[0] || rows[0].memberships.length === 0) throw notFound('Person or agent');
  return rows[0];
}

function validRole(kind: ActorKind, role: Role | undefined, orgId: string | null): Role {
  if (kind === 'agent') {
    if (!orgId) throw badRequest('Agents belong to an organization; choose one');
    return 'agent';
  }
  const r = role ?? 'editor';
  if (!['admin', 'editor', 'viewer'].includes(r)) throw badRequest('role must be admin, editor or viewer');
  return r;
}

/** Create a person or an agent with one membership, and return their first token (shown once). */
export async function createMember(
  db: Db, a: Access,
  input: { name: string; kind: ActorKind; organization_id?: string | null; role?: Role; token_label?: string },
): Promise<{ actor: { id: string; name: string; kind: ActorKind }; token: string }> {
  const orgId = input.organization_id ?? null;
  a.requireAdmin(orgId);
  if (!input.name?.trim()) throw badRequest('name is required');
  if (input.kind !== 'human' && input.kind !== 'agent') throw badRequest('kind must be human or agent');
  const role = validRole(input.kind, input.role, orgId);
  return tx(db, async (c) => {
    const { rows } = await c.query<{ id: string; name: string; kind: ActorKind }>(
      'INSERT INTO actors (name, kind) VALUES ($1, $2) RETURNING id, name, kind', [input.name.trim(), input.kind]);
    await c.query('INSERT INTO memberships (actor_id, organization_id, role) VALUES ($1, $2, $3)', [rows[0].id, orgId, role]);
    const token = await insertToken(c, rows[0].id, input.token_label ?? 'default');
    return { actor: rows[0], token };
  });
}

/** Give someone already in this group a role at another level (e.g. Azure viewer for a GitHub editor). */
export async function addMembership(
  db: Db, a: Access, actorId: string, input: { organization_id?: string | null; role?: Role },
): Promise<void> {
  const orgId = input.organization_id ?? null;
  a.requireAdmin(orgId);
  const m = await loadMember(db, actorId);
  if (m.kind === 'agent') throw badRequest('Agents belong to exactly one organization. Create another agent instead.');
  const role = validRole(m.kind, input.role, orgId);
  try {
    await db.query('INSERT INTO memberships (actor_id, organization_id, role) VALUES ($1, $2, $3)', [actorId, orgId, role]);
  } catch (err) {
    const e = mapPgError(err);
    if (e instanceof AppError && e.code === 'conflict') throw new AppError('conflict', `${m.name} already has a role there`);
    throw e;
  }
}

export async function updateMembership(db: Db, a: Access, membershipId: string, role: Role): Promise<void> {
  const { rows } = await db.query<{ actor_id: string; organization_id: string | null; role: Role }>(
    'SELECT actor_id, organization_id, role FROM memberships WHERE id = $1', [membershipId]);
  const m = rows[0];
  if (!m) throw notFound('Membership');
  a.requireAdmin(m.organization_id);
  if (m.role === 'agent' || role === 'agent') throw badRequest('Agent roles cannot be changed');
  if (m.actor_id === a.actor.id && m.role === 'admin' && role !== 'admin' && !a.actor.is_superadmin) {
    throw badRequest('You cannot demote yourself');
  }
  validRole('human', role, m.organization_id);
  await db.query('UPDATE memberships SET role = $2 WHERE id = $1', [membershipId, role]);
}

export async function removeMembership(db: Db, a: Access, membershipId: string): Promise<void> {
  const { rows } = await db.query<{ actor_id: string; organization_id: string | null; role: Role }>(
    'SELECT actor_id, organization_id, role FROM memberships WHERE id = $1', [membershipId]);
  const m = rows[0];
  if (!m) throw notFound('Membership');
  a.requireAdmin(m.organization_id);
  if (m.actor_id === a.actor.id && m.organization_id === null && !a.actor.is_superadmin) {
    throw badRequest('You cannot remove your own group role');
  }
  await db.query('DELETE FROM memberships WHERE id = $1', [membershipId]);
}

async function requireManage(db: Queryable, pool: Pool, a: Access, actorId: string): Promise<{ id: string; name: string; kind: ActorKind }> {
  const m = await loadMember(db, actorId);
  if (!(await canManageActor(pool, a, actorId, m.kind, m.memberships))) {
    throw forbidden(`${m.name} also belongs to other groups or organizations you don't administer; a server admin manages their account`);
  }
  return m;
}

export async function updateActor(db: Db, pool: Pool, a: Access, actorId: string, input: { name?: string; disabled?: boolean }): Promise<void> {
  await requireManage(db, pool, a, actorId);
  if (actorId === a.actor.id && input.disabled) throw badRequest('You cannot disable yourself');
  await db.query(
    `UPDATE actors SET name = COALESCE($2, name),
            disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN now() ELSE NULL END
      WHERE id = $1`,
    [actorId, input.name?.trim() || null, input.disabled ?? null]);
}

export async function issueToken(db: Db, pool: Pool, a: Access, actorId: string, label: string): Promise<string> {
  await requireManage(db, pool, a, actorId);
  return insertToken(db, actorId, label || 'token');
}

export async function revokeToken(db: Db, pool: Pool, a: Access, tokenId: string): Promise<void> {
  const { rows } = await db.query<{ actor_id: string }>('SELECT actor_id FROM api_tokens WHERE id = $1 AND revoked_at IS NULL', [tokenId]);
  if (!rows[0]) throw notFound('Active token');
  await requireManage(db, pool, a, rows[0].actor_id);
  await db.query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1', [tokenId]);
}

// ───────────────────────────── your own tokens ─────────────────────────────

export async function myTokens(pool: Pool, actor: Actor) {
  const { rows } = await pool.query(
    `SELECT id, prefix, label, created_at, last_used_at, revoked_at FROM api_tokens WHERE actor_id = $1 ORDER BY created_at`,
    [actor.id]);
  return rows;
}

export async function issueOwnToken(pool: Pool, actor: Actor, label: string): Promise<string> {
  if (actor.kind !== 'human') throw forbidden('Agents cannot create tokens');
  return insertToken(pool, actor.id, label || 'token');
}

export async function revokeOwnToken(pool: Pool, actor: Actor, tokenId: string): Promise<void> {
  const r = await pool.query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND actor_id = $2 AND revoked_at IS NULL', [tokenId, actor.id]);
  if (!r.rowCount) throw notFound('Active token');
}

// ───────────────────────────── first boot ─────────────────────────────

/**
 * First boot: create the first group, organization and server admin.
 * Also gives an upgraded v1 group its group-level documents.
 * Returns the admin token when one was generated (so it can be logged once).
 */
export async function bootstrap(
  pool: Pool, opts: { groupName: string; orgName: string; token?: string },
): Promise<{ createdAdmin: boolean; token?: string }> {
  const groups = await withScope(pool, { groupId: null, bypass: true }, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(4243)');
    return (await c.query<{ id: string }>('SELECT id FROM groups')).rows;
  });

  if (groups.length === 0) {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO groups (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING RETURNING id',
      [slugify(opts.groupName), opts.groupName]);
    if (!rows[0]) return { createdAdmin: false }; // another replica won the race
    return withScope(pool, { groupId: rows[0].id }, async (c) => {
      await insertOrganization(c, { name: opts.orgName }, null);
      await seedGroupDocs(c, null);
      const { rows: admin } = await c.query<{ id: string }>(
        `INSERT INTO actors (name, kind, is_superadmin) VALUES ('Admin', 'human', true) RETURNING id`);
      await c.query(`INSERT INTO memberships (actor_id, organization_id, role) VALUES ($1, NULL, 'admin')`, [admin[0].id]);
      const token = await insertToken(c, admin[0].id, 'bootstrap', opts.token);
      return { createdAdmin: true, token: opts.token ? undefined : token };
    });
  }

  // Groups upgraded from v1 have organization documents but no group-level ones yet.
  for (const g of groups) {
    await withScope(pool, { groupId: g.id }, async (c) => {
      const { rowCount } = await c.query('SELECT 1 FROM documents WHERE organization_id IS NULL LIMIT 1');
      if (!rowCount) await seedGroupDocs(c, null);
    });
  }
  return { createdAdmin: false };
}
