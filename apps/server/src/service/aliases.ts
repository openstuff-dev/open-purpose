import type { Access } from '../auth.js';
import type { Queryable } from '../db.js';
import { AppError, notFound } from '../errors.js';
import type { SlugAlias, SlugKind } from '@openpurpose/contracts';

/**
 * Old slugs of renamed organizations, projects and scopes. They keep resolving
 * until someone removes them; a current slug always wins over an alias.
 *
 * Slugs are unique per namespace: organizations per group, projects per
 * organization, scopes per level (group, organization or project).
 */
export type { SlugAlias, SlugKind } from '@openpurpose/contracts';

/** Where a slug must be unique: the organization of a project, the level of a scope. */
export interface Namespace {
  organization_id?: string | null;
  project_id?: string | null;
}

const COLUMN: Record<SlugKind, string> = {
  organization: 'organization_id',
  project: 'project_id',
  scope: 'scope_id',
};

export async function listAliases(db: Queryable, kind: SlugKind, id: string): Promise<SlugAlias[]> {
  const { rows } = await db.query<SlugAlias>(
    `SELECT id, old_slug, created_at FROM slug_aliases WHERE ${COLUMN[kind]} = $1 ORDER BY created_at DESC`,
    [id],
  );
  return rows;
}

/** Another organization, project or scope in the namespace that used to be called `slug`. */
export async function aliasOwner(
  db: Queryable,
  kind: SlugKind,
  ns: Namespace,
  slug: string,
  exceptId: string | null,
): Promise<{ alias_id: string; id: string; name: string; slug: string } | null> {
  const sql = {
    organization: `SELECT x.id AS alias_id, o.id, o.name, o.slug FROM slug_aliases x JOIN organizations o ON o.id = x.organization_id
                    WHERE x.old_slug = $1 AND o.id IS DISTINCT FROM $2`,
    project: `SELECT x.id AS alias_id, p.id, p.name, p.slug FROM slug_aliases x JOIN projects p ON p.id = x.project_id
               WHERE x.old_slug = $1 AND p.id IS DISTINCT FROM $2 AND p.organization_id = $3`,
    scope: `SELECT x.id AS alias_id, s.id, s.name, s.slug FROM slug_aliases x JOIN scopes s ON s.id = x.scope_id
             WHERE x.old_slug = $1 AND s.id IS DISTINCT FROM $2
               AND s.organization_id IS NOT DISTINCT FROM $3 AND s.project_id IS NOT DISTINCT FROM $4`,
  }[kind];
  const params: unknown[] = [slug, exceptId];
  if (kind !== 'organization') params.push(ns.organization_id ?? null);
  if (kind === 'scope') params.push(ns.project_id ?? null);
  const { rows } = await db.query<{ alias_id: string; id: string; name: string; slug: string }>(
    sql,
    params,
  );
  return rows[0] ?? null;
}

/**
 * A new or renamed slug that is still another one's alias would quietly take over
 * every repository and [[link]] that uses it. Refuse unless the caller says to take
 * it, and then remove the alias so the old owner stops answering to it.
 */
export async function claimSlug(
  db: Queryable,
  kind: SlugKind,
  ns: Namespace,
  slug: string,
  exceptId: string | null,
  take: boolean | undefined,
): Promise<void> {
  const owner = await aliasOwner(db, kind, ns, slug, exceptId);
  if (!owner) return;
  if (!take) {
    throw new AppError(
      'conflict',
      `"${slug}" is the old slug of ${owner.name} (now "${owner.slug}"). Repositories, agents and [[links]] that still use "${slug}" reach ${owner.name}. ` +
      'Taking the slug points them here instead.',
      { alias_of: { id: owner.id, name: owner.name, slug: owner.slug }, slug },
    );
  }
  await db.query('DELETE FROM slug_aliases WHERE id = $1', [owner.alias_id]);
}

/**
 * After a slug changed from `from` to `to`: remember `from`, and forget `to` if it was an old name.
 */
export async function recordRename(
  db: Queryable,
  kind: SlugKind,
  id: string,
  from: string,
  to: string,
  actorId: string | null,
): Promise<void> {
  if (from === to) return;
  const col = COLUMN[kind];
  await db.query(`DELETE FROM slug_aliases WHERE ${col} = $1 AND old_slug = $2`, [id, to]);
  await db.query(
    `INSERT INTO slug_aliases (${col}, old_slug, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [id, from, actorId],
  );
}

/** Retire an old slug. Same rights as renaming its owner. */
export async function deleteAlias(db: Queryable, a: Access, id: string): Promise<void> {
  const { rows } = await db.query<{
    organization_id: string | null;
    project_org: string | null;
    scope_org: string | null;
    is_org: boolean;
  }>(
    `SELECT x.organization_id, p.organization_id AS project_org, s.organization_id AS scope_org, x.organization_id IS NOT NULL AS is_org
       FROM slug_aliases x LEFT JOIN projects p ON p.id = x.project_id LEFT JOIN scopes s ON s.id = x.scope_id
      WHERE x.id = $1`,
    [id],
  );
  const r = rows.at(0);
  if (!r) throw notFound('Old slug');
  if (r.is_org) a.requireAdmin(null);
  else a.requireEdit(r.project_org ?? r.scope_org);
  await db.query('DELETE FROM slug_aliases WHERE id = $1', [id]);
}
