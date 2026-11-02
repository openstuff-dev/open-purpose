import type pg from 'pg';
import type { Access } from '../auth.js';
import type { Queryable } from '../db.js';
import { notFound } from '../errors.js';
import type { SlugAlias } from '@openpurpose/contracts';
import {
  activityById,
  type DocumentActivity,
  type DocumentReadRow,
  lastReadSql,
  NO_SECTION_ACTIVITY,
  sectionActivitySql,
  type SectionActivityRow,
  TRACKING_SINCE_SQL,
  withActivity,
} from './activity.js';
import { API_FROM, API_META, type ApiSpecMeta } from './apis.js';
import {
  documentsWithActivitySql,
  getDocument,
  SCOPE_COLS,
  SECTION_COLS,
} from './content.js';
import { getProject, PROJECT_COLS } from './projects.js';
import type { Document, Project, Repository, Scope, Section } from './types.js';

/*
 * The project and document pages, each in two round trips: one to find what was asked for and
 * check access, one multi-statement query for everything on the page. Each trip costs 25-40 ms
 * in production, and one connection runs its queries one at a time, so Promise.all wouldn't help.
 * Several statements can't take $1, so ids go in as literals; they come from the database and
 * are checked to be uuids.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(id: string | null): string {
  if (id === null) return 'NULL';
  if (!UUID.test(id)) throw new Error(`Not a uuid: ${id}`);
  return `'${id}'::uuid`;
}

const orgOf = (a: Access, id: string | null) => {
  const org = id ? a.org(id) : undefined;
  return org && { id: org.id, slug: org.slug, name: org.name };
};

/** What `GET /projects/:id` shows: the project, its repositories, scopes, documents and APIs. */
export async function projectPage(db: Queryable, a: Access, ref: string) {
  const p: Project = await getProject(db, a, ref);
  const organization = orgOf(a, p.organization_id);
  if (!organization) throw notFound('Organization');
  const id = uuid(p.id);
  const org = uuid(p.organization_id);
  const [repositories, scopes, documents, apis, aliases] = (await db.query(`
    SELECT id, project_id, remote_key, remote_url, created_at FROM repositories
     WHERE project_id = ${id} ORDER BY remote_key;
    SELECT ${SCOPE_COLS} FROM scopes
     WHERE organization_id IS NOT DISTINCT FROM ${org} AND project_id = ${id}
     ORDER BY position, name;
    ${documentsWithActivitySql([org, id, 'NULL'], String(a.isAgent))};
    SELECT ${API_META} ${API_FROM} WHERE s.project_id = ${id} ORDER BY s.created_at;
    SELECT id, old_slug, created_at FROM slug_aliases
     WHERE project_id = ${id} ORDER BY created_at DESC`)) as unknown as [
    pg.QueryResult<Repository>,
    pg.QueryResult<Scope>,
    pg.QueryResult<Document & DocumentReadRow>,
    pg.QueryResult<ApiSpecMeta>,
    pg.QueryResult<SlugAlias>,
  ];
  return {
    ...p,
    organization,
    can_edit: a.canEdit(p.organization_id),
    repositories: repositories.rows,
    scopes: scopes.rows,
    documents: documents.rows.map(withActivity),
    apis: apis.rows,
    aliases: aliases.rows,
  };
}

/** What `GET /documents/:id` shows: the document, its sections with their reads, and its level. */
export async function documentPage(db: Queryable, a: Access, ref: string) {
  const doc = await getDocument(db, a, ref);
  const id = uuid(doc.id);
  const [sections, reads, docRead, projects, scopes] = (await db.query(`
    SELECT ${SECTION_COLS} FROM sections s LEFT JOIN actors a ON a.id = s.updated_by
     WHERE s.document_id = ${id} ORDER BY s.archived_at DESC NULLS FIRST, s.position, s.created_at;
    ${sectionActivitySql(`sections s WHERE s.document_id = ${id}`)};
    SELECT ${lastReadSql(id)} AS last_read_at, ${TRACKING_SINCE_SQL} AS tracking_since;
    SELECT ${PROJECT_COLS} FROM projects p WHERE p.id = ${uuid(doc.project_id)};
    SELECT ${SCOPE_COLS} FROM scopes WHERE id = ${uuid(doc.scope_id)}`)) as unknown as [
    pg.QueryResult<Section>,
    pg.QueryResult<SectionActivityRow>,
    pg.QueryResult<Pick<DocumentReadRow, 'last_read_at' | 'tracking_since'>>,
    pg.QueryResult<Project>,
    pg.QueryResult<Scope>,
  ];
  const activity = activityById(reads.rows);
  const { disabled_at, last_read_at, staleness }: DocumentActivity = withActivity({
    ...doc,
    ...docRead.rows[0],
  });
  return {
    ...doc,
    disabled_at,
    last_read_at,
    staleness,
    sections: sections.rows
      .filter((s) => !s.archived_at)
      .map((s) => ({ ...s, activity: activity.get(s.id) ?? NO_SECTION_ACTIVITY })),
    /** People only: agents never get archived sections. Newest first. */
    archived_sections: a.isAgent ? [] : sections.rows.filter((s) => s.archived_at),
    project: projects.rows.at(0) ?? null,
    scope: scopes.rows.at(0) ?? null,
    organization: orgOf(a, doc.organization_id),
    can_edit: a.canEdit(doc.organization_id),
  };
}

/** A document a section can move to: same organization, any level. */
export interface MoveTarget {
  id: string;
  title: string;
  kind: Document['kind'];
  /** Where it hangs, e.g. "Customer Portal › Frontend". */
  where: string;
}

/**
 * The documents a section of this one can move to: the others of the same organization, those of
 * its own project first.
 */
export async function moveTargets(db: Queryable, a: Access, ref: string): Promise<MoveTarget[]> {
  const doc = await getDocument(db, a, ref);
  const { rows } = await db.query<MoveTarget>(
    `SELECT d.id, d.title, d.kind, concat_ws(' › ', COALESCE(p.name, o.name, $4), sc.name) AS "where"
       FROM documents d
       LEFT JOIN projects p ON p.id = d.project_id
       LEFT JOIN scopes sc ON sc.id = d.scope_id
       LEFT JOIN organizations o ON o.id = d.organization_id
      WHERE d.organization_id IS NOT DISTINCT FROM $1 AND d.id <> $2 AND (p.id IS NULL OR p.archived_at IS NULL)
      ORDER BY d.project_id IS NOT DISTINCT FROM $3 DESC, d.project_id IS NULL DESC, "where", d.position, d.title`,
    [doc.organization_id, doc.id, doc.project_id, a.group.name],
  );
  return rows;
}
