import type { Access } from '../auth.js';
import type { Db, Queryable } from '../db.js';
import { tx } from '../db.js';
import { AppError, badRequest, mapPgError, notFound } from '../errors.js';
import { parseRemote, slugify, type RemoteInfo } from '../domain/remote.js';
import { insertDocument, insertSection } from './content.js';
import type { Project, Repository } from './types.js';

const PROJECT_COLS = 'p.id, p.organization_id, p.slug, p.name, p.summary, p.reviewed, p.created_at, p.updated_at, p.archived_at';

export interface ProjectListItem extends Project {
  organization_slug: string;
  organization_name: string;
  repository_count: number;
  pending_proposals: number;
}

/** Projects in the organizations the actor can read; optionally one organization only. */
export async function listProjects(
  db: Queryable, a: Access, opts: { q?: string; includeArchived?: boolean; organizationId?: string | null } = {},
): Promise<ProjectListItem[]> {
  if (opts.organizationId) a.requireRead(opts.organizationId);
  const { rows } = await db.query<ProjectListItem>(
    `SELECT ${PROJECT_COLS}, o.slug AS organization_slug, o.name AS organization_name,
            (SELECT count(*)::int FROM repositories r WHERE r.project_id = p.id) AS repository_count,
            (SELECT count(*)::int FROM proposals x WHERE x.project_id = p.id AND x.status = 'pending') AS pending_proposals
       FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE p.organization_id = ANY($3::uuid[])
        AND ($4::uuid IS NULL OR p.organization_id = $4)
        AND ($1::text IS NULL OR p.slug ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%'
             OR EXISTS (SELECT 1 FROM repositories r WHERE r.project_id = p.id AND r.remote_key ILIKE '%' || $1 || '%'))
        AND ($2 OR p.archived_at IS NULL)
      ORDER BY p.reviewed, o.name, p.name`,
    [opts.q?.trim() || null, opts.includeArchived ?? false, a.readableOrgIds(), opts.organizationId ?? null],
  );
  return rows;
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * Find a project by id, by "org/slug", or by slug. A bare slug is looked up in
 * the current organization first, then in every other organization the actor
 * can read; it must be unambiguous there.
 */
export async function getProject(db: Queryable, a: Access, ref: string): Promise<Project> {
  let rows: Project[];
  if (isUuid(ref)) {
    rows = (await db.query<Project>(`SELECT ${PROJECT_COLS} FROM projects p WHERE p.id = $1`, [ref])).rows;
  } else if (ref.includes('/')) {
    const [orgSlug, slug] = ref.toLowerCase().split('/', 2);
    const org = a.orgBySlug(orgSlug);
    if (!org) throw notFound(`Organization "${orgSlug}"`);
    rows = (await db.query<Project>(`SELECT ${PROJECT_COLS} FROM projects p WHERE p.organization_id = $1 AND p.slug = $2`, [org.id, slug])).rows;
  } else {
    const all = (await db.query<Project>(`SELECT ${PROJECT_COLS} FROM projects p WHERE p.slug = lower($1)`, [ref])).rows;
    const own = all.filter((p) => p.organization_id === a.orgId);
    const readable = all.filter((p) => a.canRead(p.organization_id));
    rows = own.length ? own : readable;
    if (rows.length > 1) {
      throw badRequest(`"${ref}" exists in several organizations: ${rows.map((p) => `${a.org(p.organization_id)?.slug}/${p.slug}`).join(', ')}. Use org/slug.`);
    }
    if (!rows.length && all.length) a.requireRead(all[0].organization_id);
  }
  if (!rows[0]) throw notFound(`Project "${ref}"`);
  a.requireRead(rows[0].organization_id);
  return rows[0];
}

export interface ProjectInput {
  organization_id?: string | null;
  slug?: string;
  name: string;
  summary?: string;
  /** Initial text for the project's purpose section. */
  purpose?: string;
  /** Optional git remote to map to the new project straight away. */
  remote_url?: string;
}

/**
 * Editors create reviewed projects. Agents may create projects in their own
 * organization (so an agent in an unknown repo is never stuck); those are
 * flagged for review.
 */
export async function createProject(db: Db, a: Access, input: ProjectInput): Promise<Project> {
  const orgId = input.organization_id ?? a.orgId;
  if (!orgId) throw badRequest('organization_id is required');
  a.requireContribute(orgId);
  if (!input.name?.trim()) throw badRequest('name is required');
  const slug = input.slug ? input.slug.toLowerCase() : slugify(input.name);
  try {
    return await tx(db, async (c) => {
      const { rows } = await c.query<Project>(
        `INSERT INTO projects (organization_id, slug, name, summary, reviewed, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, organization_id, slug, name, summary, reviewed, created_at, updated_at, archived_at`,
        [orgId, slug, input.name.trim(), input.summary ?? '', a.canEdit(orgId), a.actor.id],
      );
      const project = rows[0];
      const level = { organization_id: orgId, project_id: project.id, scope_id: null };
      const purpose = await insertDocument(c, level, { kind: 'purpose', title: 'Project purpose', slug: 'purpose', mode: 'propose', position: 0 });
      await insertSection(c, purpose.id, {
        heading: 'What this project does',
        body: input.purpose?.trim() || '_Not written yet. Describe what the project does, who uses it and what "good" looks like._',
        mode: 'propose',
      }, a.actor.id, 'Created with project');
      await insertDocument(c, level, { kind: 'guidelines', title: 'How we build it', slug: 'guidelines', mode: 'propose', position: 1 });
      if (input.remote_url) await insertRepository(c, a, project, input.remote_url);
      return project;
    });
  } catch (err) {
    throw mapPgError(err);
  }
}

export async function updateProject(
  db: Db, a: Access, ref: string,
  input: Partial<Pick<Project, 'slug' | 'name' | 'summary' | 'reviewed'>> & { archived?: boolean; organization_id?: string },
): Promise<Project> {
  const cur = await getProject(db, a, ref);
  a.requireEdit(cur.organization_id);
  if (input.organization_id && input.organization_id !== cur.organization_id) {
    a.requireEdit(input.organization_id);
  }
  try {
    return await tx(db, async (c) => {
      const { rows } = await c.query<Project>(
        `UPDATE projects SET slug = $2, name = $3, summary = $4, reviewed = $5,
                archived_at = CASE WHEN $6::boolean IS NULL THEN archived_at
                                   WHEN $6 THEN COALESCE(archived_at, now()) ELSE NULL END,
                organization_id = $7, updated_at = now()
          WHERE id = $1
          RETURNING id, organization_id, slug, name, summary, reviewed, created_at, updated_at, archived_at`,
        [cur.id, input.slug?.toLowerCase() ?? cur.slug, input.name ?? cur.name, input.summary ?? cur.summary,
          input.reviewed ?? cur.reviewed, input.archived ?? null, input.organization_id ?? cur.organization_id],
      );
      // Moving a project to another organization moves its scopes, documents and proposals with it.
      if (rows[0].organization_id !== cur.organization_id) {
        for (const t of ['scopes', 'documents', 'proposals']) {
          await c.query(`UPDATE ${t} SET organization_id = $2 WHERE project_id = $1`, [cur.id, rows[0].organization_id]);
        }
      }
      return rows[0];
    });
  } catch (err) {
    throw mapPgError(err);
  }
}

export async function deleteProject(db: Db, a: Access, ref: string): Promise<void> {
  const p = await getProject(db, a, ref);
  a.requireEdit(p.organization_id);
  await db.query('DELETE FROM projects WHERE id = $1', [p.id]);
}

// ───────────────────────────── repositories ─────────────────────────────

export async function listRepositories(db: Queryable, projectId: string): Promise<Repository[]> {
  const { rows } = await db.query<Repository>(
    'SELECT id, project_id, remote_key, remote_url, created_at FROM repositories WHERE project_id = $1 ORDER BY remote_key',
    [projectId],
  );
  return rows;
}

async function insertRepository(c: Queryable, a: Access, project: Project, remoteUrl: string): Promise<Repository> {
  let info: RemoteInfo;
  try {
    info = parseRemote(remoteUrl);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const existing = await c.query<{ project_id: string; slug: string; organization_id: string }>(
    `SELECT r.project_id, p.slug, p.organization_id FROM repositories r JOIN projects p ON p.id = r.project_id WHERE r.remote_key = $1`,
    [info.key],
  );
  const hit = existing.rows[0];
  if (hit) {
    if (hit.project_id === project.id) {
      const { rows } = await c.query<Repository>(
        'SELECT id, project_id, remote_key, remote_url, created_at FROM repositories WHERE remote_key = $1', [info.key]);
      return rows[0];
    }
    const where = a.canRead(hit.organization_id) ? `project "${a.org(hit.organization_id)?.slug}/${hit.slug}"` : `a project in ${a.org(hit.organization_id)?.name}`;
    throw new AppError('conflict', `Repository ${info.key} is already mapped to ${where}`);
  }
  const { rows } = await c.query<Repository>(
    `INSERT INTO repositories (project_id, remote_key, remote_url, created_by) VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, remote_key, remote_url, created_at`,
    [project.id, info.key, remoteUrl.trim(), a.actor.id],
  );
  return rows[0];
}

/** Agents may map a repo to a project in their own organization (low risk, easy to undo in the UI). */
export async function addRepository(db: Db, a: Access, projectRef: string, remoteUrl: string): Promise<Repository> {
  const project = await getProject(db, a, projectRef);
  a.requireContribute(project.organization_id);
  try {
    return await insertRepository(db, a, project, remoteUrl);
  } catch (err) {
    throw mapPgError(err);
  }
}

export async function deleteRepository(db: Db, a: Access, id: string): Promise<void> {
  const { rows } = await db.query<{ organization_id: string }>(
    'SELECT p.organization_id FROM repositories r JOIN projects p ON p.id = r.project_id WHERE r.id = $1', [id]);
  if (!rows[0]) throw notFound('Repository');
  a.requireEdit(rows[0].organization_id);
  await db.query('DELETE FROM repositories WHERE id = $1', [id]);
}

// ───────────────────────────── resolution ─────────────────────────────

export interface Resolution {
  project: Project | null;
  /** How the project was found: an explicit slug (e.g. from .agentcontext.json) or the git remote. */
  via: 'project' | 'remote' | null;
  remote: RemoteInfo | null;
  /** When nothing matched: projects whose name looks like the repo, for the agent to offer the user. */
  suggestions: Array<{ slug: string; name: string; summary: string; organization_slug: string }>;
}

export async function resolveProject(
  db: Queryable, a: Access, input: { project?: string | null; remote_url?: string | null },
): Promise<Resolution> {
  let remote: RemoteInfo | null = null;
  if (input.remote_url) {
    try {
      remote = parseRemote(input.remote_url);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  }
  if (input.project) {
    return { project: await getProject(db, a, input.project), via: 'project', remote, suggestions: [] };
  }
  if (remote) {
    const { rows } = await db.query<Project & { org_name: string }>(
      `SELECT ${PROJECT_COLS} FROM repositories r JOIN projects p ON p.id = r.project_id WHERE r.remote_key = $1`,
      [remote.key],
    );
    if (rows[0]) {
      if (!a.canRead(rows[0].organization_id)) {
        throw new AppError('forbidden', `This repository belongs to a project in ${a.org(rows[0].organization_id)?.name}, which you can't read. Ask a group admin for read access.`);
      }
      return { project: rows[0], via: 'remote', remote, suggestions: [] };
    }
  }
  const words = remote ? remote.repo.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3) : [];
  let suggestions: Resolution['suggestions'] = [];
  if (words.length) {
    const { rows } = await db.query<Resolution['suggestions'][number]>(
      `SELECT p.slug, p.name, p.summary, o.slug AS organization_slug
         FROM projects p JOIN organizations o ON o.id = p.organization_id
        WHERE p.archived_at IS NULL AND p.organization_id = ANY($2::uuid[])
          AND (p.slug ILIKE ANY($1) OR p.name ILIKE ANY($1))
        ORDER BY (p.organization_id = $3::uuid) DESC, p.name LIMIT 10`,
      [words.map((w) => `%${w}%`), a.readableOrgIds(), a.orgId],
    );
    suggestions = rows;
  }
  return { project: null, via: null, remote, suggestions };
}
