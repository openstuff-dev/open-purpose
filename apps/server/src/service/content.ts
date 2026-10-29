import type { Access } from '../auth.js';
import type { Db, Queryable } from '../db.js';
import { tx } from '../db.js';
import { AppError, badRequest, mapPgError, notFound } from '../errors.js';
import { normalizePath } from '../domain/scopes.js';
import { normalizeTags } from '../domain/stacks.js';
import { slugify } from '../domain/remote.js';
import { extractLinks } from '../domain/links.js';
import { documentActivity, type DocumentActivity, noDocumentActivity } from './activity.js';
import { claimSlug } from './aliases.js';
import type {
  DocKind,
  Document,
  EditMode,
  Level,
  Scope,
  Section,
  SectionVersion,
} from './types.js';
import { DOC_KINDS, EDIT_MODES } from './types.js';

export function assertMode(mode: string | undefined): EditMode | undefined {
  if (mode === undefined) return undefined;
  if (!EDIT_MODES.includes(mode as EditMode))
    throw badRequest(`mode must be one of ${EDIT_MODES.join(', ')}`);
  return mode as EditMode;
}

export function assertKind(kind: string): DocKind {
  if (!DOC_KINDS.includes(kind as DocKind))
    throw badRequest(`kind must be one of ${DOC_KINDS.join(', ')}`);
  return kind as DocKind;
}

async function wrap<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw mapPgError(err);
  }
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * Fill in the parent levels: a scope implies its project and organization, a
 * project implies its organization. Everything null = group-wide.
 */
export async function resolveLevel(db: Queryable, level: Partial<Level>): Promise<Level> {
  if (level.scope_id) {
    const { rows } = await db.query<Scope>(
      'SELECT id, organization_id, project_id FROM scopes WHERE id = $1',
      [level.scope_id],
    );
    const s = rows.at(0);
    if (!s) throw notFound('Scope');
    if (level.project_id && level.project_id !== s.project_id)
      throw badRequest('scope_id does not belong to project_id');
    if (level.organization_id && level.organization_id !== s.organization_id)
      throw badRequest('scope_id does not belong to organization_id');
    return { organization_id: s.organization_id, project_id: s.project_id, scope_id: s.id };
  }
  if (level.project_id) {
    const { rows } = await db.query<{ organization_id: string }>(
      'SELECT organization_id FROM projects WHERE id = $1',
      [level.project_id],
    );
    if (!rows[0]) throw notFound('Project');
    if (level.organization_id && level.organization_id !== rows[0].organization_id)
      throw badRequest('project_id does not belong to organization_id');
    return {
      organization_id: rows[0].organization_id,
      project_id: level.project_id,
      scope_id: null,
    };
  }
  if (level.organization_id) {
    const { rowCount } = await db.query('SELECT 1 FROM organizations WHERE id = $1', [
      level.organization_id,
    ]);
    if (!rowCount) throw notFound('Organization');
  }
  return { organization_id: level.organization_id ?? null, project_id: null, scope_id: null };
}

// ───────────────────────────── scopes ─────────────────────────────

export interface ScopeInput {
  slug?: string;
  name: string;
  description?: string;
  path_globs?: string[];
  stacks?: string[];
  /** Repositories of the scope's project it is bound to. */
  repository_ids?: string[];
  position?: number;
  /** Take the slug even if it is another scope's old slug. */
  take_alias?: boolean;
}

const SCOPE_COLS = `id, organization_id, project_id, slug, name, description, path_globs, stacks, position,
  ARRAY(SELECT sr.repository_id FROM scope_repositories sr WHERE sr.scope_id = scopes.id ORDER BY sr.created_at) AS repository_ids`;

export function cleanGlobs(globs: string[] | undefined): string[] {
  return [...new Set((globs ?? []).map(normalizePath).filter(Boolean))];
}

async function bindRepositories(
  c: Queryable,
  scope: Scope,
  ids: string[] | undefined,
): Promise<Scope> {
  if (ids === undefined) return scope;
  const unique = [...new Set(ids)];
  if (unique.length && !scope.project_id)
    throw badRequest('Only project scopes can be bound to repositories');
  if (unique.some((id) => !isUuid(id))) throw badRequest('repository_ids must be repository ids');
  const { rows } = await c.query<{ id: string }>(
    'SELECT id FROM repositories WHERE id = ANY($1::uuid[]) AND project_id = $2',
    [unique, scope.project_id],
  );
  if (rows.length !== unique.length)
    throw badRequest("repository_ids must be repositories of the scope's project");
  await c.query(
    'DELETE FROM scope_repositories WHERE scope_id = $1 AND NOT (repository_id = ANY($2::uuid[]))',
    [scope.id, unique],
  );
  for (const id of unique) {
    await c.query(
      'INSERT INTO scope_repositories (scope_id, repository_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [scope.id, id],
    );
  }
  return { ...scope, repository_ids: unique };
}

/** Scopes defined at exactly this level (group, organization or project). */
export async function listScopes(
  db: Queryable,
  a: Access,
  level: { organization_id: string | null; project_id: string | null },
): Promise<Scope[]> {
  const lv = await resolveLevel(db, level);
  a.requireRead(lv.organization_id);
  const { rows } = await db.query<Scope>(
    `SELECT ${SCOPE_COLS} FROM scopes
      WHERE organization_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2
      ORDER BY position, name`,
    [lv.organization_id, lv.project_id],
  );
  return rows;
}

export async function getScope(db: Queryable, a: Access, id: string): Promise<Scope> {
  const { rows } = await wrap(
    db.query<Scope>(`SELECT ${SCOPE_COLS} FROM scopes WHERE id = $1`, [id]),
  );
  if (!rows[0]) throw notFound('Scope');
  a.requireRead(rows[0].organization_id);
  return rows[0];
}

export async function createScope(
  db: Db,
  a: Access,
  level: { organization_id?: string | null; project_id?: string | null },
  input: ScopeInput,
): Promise<Scope> {
  const lv = await resolveLevel(db, level);
  a.requireEdit(lv.organization_id);
  if (!input.name.trim()) throw badRequest('name is required');
  const slug = input.slug || slugify(input.name);
  return wrap(
    tx(db, async (c) => {
      await claimSlug(c, 'scope', lv, slug, null, input.take_alias);
      const { rows } = await c.query<Scope>(
        `INSERT INTO scopes (organization_id, project_id, slug, name, description, path_globs, stacks, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${SCOPE_COLS}`,
        [
          lv.organization_id,
          lv.project_id,
          slug,
          input.name.trim(),
          input.description ?? '',
          cleanGlobs(input.path_globs),
          normalizeTags(input.stacks ?? []),
          input.position ?? 0,
        ],
      );
      return bindRepositories(c, rows[0], input.repository_ids);
    }),
  );
}

export async function updateScope(
  db: Db,
  a: Access,
  id: string,
  input: Partial<ScopeInput>,
): Promise<Scope> {
  const cur = await getScope(db, a, id);
  a.requireEdit(cur.organization_id);
  return wrap(
    tx(db, async (c) => {
      const { rows } = await c.query<Scope>(
        `UPDATE scopes SET slug = $2, name = $3, description = $4, path_globs = $5, stacks = $6,
              position = $7, updated_at = now()
        WHERE id = $1 RETURNING ${SCOPE_COLS}`,
        [
          id,
          input.slug ?? cur.slug,
          input.name ?? cur.name,
          input.description ?? cur.description,
          input.path_globs ? cleanGlobs(input.path_globs) : cur.path_globs,
          input.stacks ? normalizeTags(input.stacks) : cur.stacks,
          input.position ?? cur.position,
        ],
      );
      return bindRepositories(c, rows[0], input.repository_ids);
    }),
  );
}

export async function deleteScope(db: Db, a: Access, id: string): Promise<void> {
  const cur = await getScope(db, a, id);
  a.requireEdit(cur.organization_id);
  await db.query('DELETE FROM scopes WHERE id = $1', [id]);
}

// ───────────────────────────── documents ─────────────────────────────

const DOC_COLS =
  'id, organization_id, project_id, scope_id, kind, slug, title, mode, position, created_at, updated_at, disabled_at';

/**
 * Documents at exactly one level. No permission check; callers check.
 * `forAgents` leaves out disabled documents, which agents never get.
 */
export async function documentsAt(
  db: Queryable,
  level: Level,
  opts: { forAgents?: boolean } = {},
): Promise<Document[]> {
  const { rows } = await db.query<Document>(
    `SELECT ${DOC_COLS} FROM documents
      WHERE organization_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2
        AND scope_id IS NOT DISTINCT FROM $3 AND ($4::boolean IS NOT TRUE OR disabled_at IS NULL)
      ORDER BY kind, position, title`,
    [level.organization_id, level.project_id, level.scope_id, opts.forAgents ?? false],
  );
  return rows;
}

/** Documents at a level, with how much agents use them. Agents only see enabled ones. */
export async function listDocuments(
  db: Queryable,
  a: Access,
  level: Partial<Level>,
): Promise<(Document & DocumentActivity)[]> {
  const lv = await resolveLevel(db, level);
  a.requireRead(lv.organization_id);
  const docs = await documentsAt(db, lv, { forAgents: a.isAgent });
  const activity = await documentActivity(db, docs);
  return docs.map((d) => ({ ...d, ...(activity.get(d.id) ?? noDocumentActivity(d)) }));
}

/** Internal: load without a permission check. */
export async function loadDocument(db: Queryable, id: string): Promise<Document> {
  if (!isUuid(id)) throw notFound('Document');
  const { rows } = await db.query<Document>(`SELECT ${DOC_COLS} FROM documents WHERE id = $1`, [
    id,
  ]);
  if (!rows[0]) throw notFound('Document');
  return rows[0];
}

export async function getDocument(db: Queryable, a: Access, id: string): Promise<Document> {
  const doc = await loadDocument(db, id);
  a.requireRead(doc.organization_id);
  if (a.isAgent && doc.disabled_at) throw disabledForAgents();
  return doc;
}

const disabledForAgents = () =>
  new AppError(
    'not_found',
    "This document is disabled, so agents can't read or change it. A person can enable it again in OpenPurpose.",
  );

/** Disable a document (agents stop getting it) or enable it again. */
export async function setDocumentDisabled(
  db: Db,
  a: Access,
  id: string,
  disabled: boolean,
): Promise<Document> {
  const cur = await getDocument(db, a, id);
  a.requireEdit(cur.organization_id);
  const { rows } = await db.query<Document>(
    `UPDATE documents SET disabled_at = CASE WHEN $2 THEN COALESCE(disabled_at, now()) END,
            disabled_by = CASE WHEN $2 THEN $3::uuid END
      WHERE id = $1 RETURNING ${DOC_COLS}`,
    [id, disabled, a.actor.id],
  );
  return rows[0];
}

export interface DocumentInput {
  kind: DocKind;
  title: string;
  slug?: string;
  mode?: EditMode;
  position?: number;
}

/** Internal: no permission check. Used by bootstrap, project creation and learning approval. */
export async function insertDocument(
  db: Queryable,
  level: Level,
  input: DocumentInput,
): Promise<Document> {
  const kind = assertKind(input.kind);
  const { rows } = await wrap(
    db.query<Document>(
      `INSERT INTO documents (organization_id, project_id, scope_id, kind, slug, title, mode, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${DOC_COLS}`,
      [
        level.organization_id,
        level.project_id,
        level.scope_id,
        kind,
        input.slug ?? slugify(input.title),
        input.title.trim(),
        assertMode(input.mode) ?? 'propose',
        input.position ?? 0,
      ],
    ),
  );
  return rows[0];
}

export async function createDocument(
  db: Db,
  a: Access,
  level: Partial<Level>,
  input: DocumentInput,
): Promise<Document> {
  if (!input.title.trim()) throw badRequest('title is required');
  const lv = await resolveLevel(db, level);
  a.requireEdit(lv.organization_id);
  return insertDocument(db, lv, input);
}

export async function updateDocument(
  db: Db,
  a: Access,
  id: string,
  input: Partial<Omit<DocumentInput, 'kind'>> & { kind?: DocKind },
): Promise<Document> {
  const cur = await getDocument(db, a, id);
  a.requireEdit(cur.organization_id);
  const { rows } = await wrap(
    db.query<Document>(
      `UPDATE documents SET kind = $2, title = $3, slug = $4, mode = $5, position = $6, updated_at = now()
      WHERE id = $1 RETURNING ${DOC_COLS}`,
      [
        id,
        input.kind ? assertKind(input.kind) : cur.kind,
        input.title ?? cur.title,
        input.slug ?? cur.slug,
        assertMode(input.mode) ?? cur.mode,
        input.position ?? cur.position,
      ],
    ),
  );
  return rows[0];
}

export async function deleteDocument(db: Db, a: Access, id: string): Promise<void> {
  const cur = await getDocument(db, a, id);
  a.requireEdit(cur.organization_id);
  await db.query('DELETE FROM documents WHERE id = $1', [id]);
}

/**
 * Find (or create) the "Learnings" document at a level. A newly approved
 * learning must reach agents, so a disabled one is enabled again.
 */
export async function ensureLearningsDocument(db: Queryable, level: Level): Promise<Document> {
  const existing = (await documentsAt(db, level)).find((d) => d.kind === 'learnings');
  if (existing?.disabled_at) {
    const { rows } = await db.query<Document>(
      `UPDATE documents SET disabled_at = NULL, disabled_by = NULL WHERE id = $1 RETURNING ${DOC_COLS}`,
      [existing.id],
    );
    return rows[0];
  }
  if (existing) return existing;
  return insertDocument(db, level, {
    kind: 'learnings',
    title: 'Learnings',
    slug: 'learnings',
    mode: 'propose',
    position: 100,
  });
}

// ───────────────────────────── sections ─────────────────────────────

const SECTION_COLS = `s.id, s.document_id, s.heading, s.body, s.mode, s.position, s.version, s.updated_at,
  s.updated_by, a.name AS updated_by_name`;

/** Accept a full section UUID or an unambiguous prefix of at least 8 hex characters. */
export async function resolveSectionRef(db: Queryable, ref: string): Promise<string> {
  const r = ref.trim().toLowerCase().replace(/^s:/, '');
  if (isUuid(r)) return r;
  if (!/^[0-9a-f-]{8,36}$/.test(r)) throw badRequest(`Invalid section id "${ref}"`);
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM sections WHERE id::text LIKE $1 || \'%\' LIMIT 2',
    [r],
  );
  if (rows.length === 0) throw notFound('Section');
  if (rows.length > 1)
    throw badRequest(`Section id prefix "${ref}" is ambiguous; use more characters`);
  return rows[0].id;
}

/** Internal: load without a permission check. */
export async function loadSection(
  db: Queryable,
  ref: string,
  opts: { forUpdate?: boolean } = {},
): Promise<Section> {
  const id = await resolveSectionRef(db, ref);
  const { rows } = await db.query<Section>(
    `SELECT ${SECTION_COLS} FROM sections s LEFT JOIN actors a ON a.id = s.updated_by
      WHERE s.id = $1 ${opts.forUpdate ? 'FOR UPDATE OF s' : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound('Section');
  return rows[0];
}

/** A section plus the organization it belongs to (for permission checks). */
export async function getSection(
  db: Queryable,
  a: Access,
  ref: string,
  opts: { forUpdate?: boolean } = {},
): Promise<Section & { organization_id: string | null }> {
  const s = await loadSection(db, ref, opts);
  const doc = await loadDocument(db, s.document_id);
  a.requireRead(doc.organization_id);
  if (a.isAgent && doc.disabled_at) throw disabledForAgents();
  return { ...s, organization_id: doc.organization_id };
}

export async function listSections(db: Queryable, documentIds: string[]): Promise<Section[]> {
  if (documentIds.length === 0) return [];
  const { rows } = await db.query<Section>(
    `SELECT ${SECTION_COLS} FROM sections s LEFT JOIN actors a ON a.id = s.updated_by
      WHERE s.document_id = ANY($1::uuid[]) ORDER BY s.document_id, s.position, s.created_at`,
    [documentIds],
  );
  return rows;
}

/** Re-index the [[wikilinks]] of a section. Called on every write. */
export async function syncLinks(c: Queryable, sectionId: string, body: string): Promise<void> {
  await c.query('DELETE FROM section_links WHERE section_id = $1', [sectionId]);
  const links = extractLinks(body);
  if (links.length === 0) return;
  await c.query(
    `INSERT INTO section_links (section_id, target_kind, target, label)
     SELECT $1, k, t, l FROM unnest($2::text[], $3::text[], $4::text[]) AS x(k, t, l)
     ON CONFLICT DO NOTHING`,
    [sectionId, links.map((l) => l.kind), links.map((l) => l.target), links.map((l) => l.label)],
  );
}

export interface SectionInput {
  heading: string;
  body?: string;
  mode?: EditMode;
  position?: number;
}

/** Internal: insert + version 1 snapshot. No permission check. */
export async function insertSection(
  c: Queryable,
  documentId: string,
  input: SectionInput,
  actorId: string | null,
  note: string,
): Promise<Section> {
  if (!input.heading.trim()) throw badRequest('heading is required');
  const doc = await loadDocument(c, documentId);
  let position = input.position;
  if (position === undefined) {
    const { rows } = await c.query<{ next: number }>(
      'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM sections WHERE document_id = $1',
      [documentId],
    );
    position = rows[0].next;
  }
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO sections (document_id, heading, body, mode, position, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      documentId,
      input.heading.trim(),
      input.body ?? '',
      assertMode(input.mode) ?? doc.mode,
      position,
      actorId,
    ],
  );
  const id = rows[0].id;
  await syncLinks(c, id, input.body ?? '');
  await c.query(
    `INSERT INTO section_versions (section_id, version, heading, body, mode, actor_id, note)
     SELECT id, version, heading, body, mode, $2, $3 FROM sections WHERE id = $1`,
    [id, actorId, note],
  );
  await c.query('UPDATE documents SET updated_at = now() WHERE id = $1', [documentId]);
  return loadSection(c, id);
}

export interface SectionChange {
  heading?: string;
  body?: string;
  mode?: EditMode;
}

/** Internal: bump version, snapshot. No permission check. */
export async function applySectionChange(
  c: Queryable,
  section: Section,
  change: SectionChange,
  actorId: string | null,
  note: string,
): Promise<Section> {
  const heading = change.heading?.trim() || section.heading;
  const body = change.body ?? section.body;
  const mode = assertMode(change.mode) ?? section.mode;
  if (heading === section.heading && body === section.body && mode === section.mode) return section;
  await c.query(
    `UPDATE sections SET heading = $2, body = $3, mode = $4, version = version + 1,
            updated_at = now(), updated_by = $5
      WHERE id = $1`,
    [section.id, heading, body, mode, actorId],
  );
  if (body !== section.body) await syncLinks(c, section.id, body);
  await c.query(
    `INSERT INTO section_versions (section_id, version, heading, body, mode, actor_id, note)
     SELECT id, version, heading, body, mode, $2, $3 FROM sections WHERE id = $1`,
    [section.id, actorId, note],
  );
  await c.query('UPDATE documents SET updated_at = now() WHERE id = $1', [section.document_id]);
  return loadSection(c, section.id);
}

export function checkVersion(section: Section, expected: number | undefined): void {
  if (expected !== undefined && expected !== section.version) {
    throw new AppError(
      'conflict',
      `Section was changed by someone else (now at version ${section.version}, you had ${expected}). Re-read it and try again.`,
      {
        current_version: section.version,
      },
    );
  }
}

export async function reorderSections(
  db: Db,
  a: Access,
  documentId: string,
  ids: string[],
): Promise<Section[]> {
  const doc = await getDocument(db, a, documentId);
  a.requireEdit(doc.organization_id);
  return tx(db, async (c) => {
    for (let i = 0; i < ids.length; i++) {
      await c.query('UPDATE sections SET position = $3 WHERE id = $1 AND document_id = $2', [
        ids[i],
        documentId,
        i,
      ]);
    }
    return listSections(c, [documentId]);
  });
}

export async function deleteSection(db: Db, a: Access, ref: string): Promise<void> {
  const s = await getSection(db, a, ref);
  a.requireEdit(s.organization_id);
  await db.query('DELETE FROM sections WHERE id = $1', [s.id]);
}

export async function listVersions(
  db: Queryable,
  a: Access,
  ref: string,
): Promise<SectionVersion[]> {
  const s = await getSection(db, a, ref);
  const { rows } = await db.query<SectionVersion>(
    `SELECT v.id::text, v.section_id, v.version, v.heading, v.body, v.mode, v.actor_id,
            a.name AS actor_name, v.note, v.created_at
       FROM section_versions v LEFT JOIN actors a ON a.id = v.actor_id
      WHERE v.section_id = $1 ORDER BY v.version DESC`,
    [s.id],
  );
  return rows;
}

export async function revertSection(
  db: Db,
  a: Access,
  ref: string,
  version: number,
): Promise<Section> {
  return tx(db, async (c) => {
    const s = await getSection(c, a, ref, { forUpdate: true });
    a.requireEdit(s.organization_id);
    const { rows } = await c.query<SectionVersion>(
      'SELECT heading, body, mode FROM section_versions WHERE section_id = $1 AND version = $2',
      [s.id, version],
    );
    if (!rows[0]) throw notFound(`Version ${version}`);
    return applySectionChange(c, s, rows[0], a.actor.id, `Reverted to version ${version}`);
  });
}

// ───────────────────────────── search ─────────────────────────────

export interface SearchHit {
  section_id: string;
  heading: string;
  snippet: string;
  mode: EditMode;
  document_id: string;
  document_title: string;
  organization_id: string | null;
  organization_slug: string | null;
  project_id: string | null;
  project_slug: string | null;
  scope_slug: string | null;
  rank: number;
}

export interface SearchOptions {
  /** Only that project, its organization and the group-wide content. */
  projectId?: string | null;
  organizationId?: string | null;
  /**
   * Where the searcher is: hits there rank first (the project, then its organization). Nothing is
   * left out.
   */
  nearProjectId?: string | null;
  nearOrganizationId?: string | null;
  /** Only hits in the near project, or in the near organization (with its projects). */
  within?: 'project' | 'organization';
  limit?: number;
}

/** Full-text search over everything the actor can read. */
export async function searchSections(
  db: Queryable,
  a: Access,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  let orgFilter: string | null = opts.organizationId ?? null;
  if (opts.projectId)
    orgFilter = (await resolveLevel(db, { project_id: opts.projectId })).organization_id;
  const nearProject = opts.nearProjectId ?? null;
  const nearOrg = nearProject
    ? (await resolveLevel(db, { project_id: nearProject })).organization_id
    : (opts.nearOrganizationId ?? null);
  if (opts.within === 'project' && !nearProject)
    throw badRequest('within=project needs near_project_id');
  if (opts.within === 'organization' && !nearOrg)
    throw badRequest('within=organization needs near_project_id or near_organization_id');
  const { rows } = await db.query<SearchHit>(
    `WITH q AS (SELECT websearch_to_tsquery('simple', $1) AS tsq)
     SELECT s.id AS section_id, s.heading, s.mode, d.id AS document_id, d.title AS document_title,
            d.organization_id, o.slug AS organization_slug, d.project_id, p.slug AS project_slug, sc.slug AS scope_slug,
            ts_rank(s.search, q.tsq) + CASE WHEN s.heading ILIKE '%' || $1 || '%' THEN 0.5 ELSE 0 END
              + CASE WHEN d.project_id = $6::uuid THEN 2 WHEN d.organization_id = $7::uuid THEN 1 ELSE 0 END AS rank,
            ts_headline('simple', s.body, q.tsq, 'MaxWords=30, MinWords=10, StartSel=**, StopSel=**') AS snippet
       FROM sections s
       JOIN documents d ON d.id = s.document_id
       LEFT JOIN organizations o ON o.id = d.organization_id
       LEFT JOIN projects p ON p.id = d.project_id
       LEFT JOIN scopes sc ON sc.id = d.scope_id
       CROSS JOIN q
      WHERE (s.search @@ q.tsq OR s.heading ILIKE '%' || $1 || '%' OR s.body ILIKE '%' || $1 || '%')
        AND (d.organization_id IS NULL OR d.organization_id = ANY($2::uuid[]))
        AND ($3::uuid IS NULL OR d.organization_id IS NULL OR d.organization_id = $3::uuid)
        AND ($4::uuid IS NULL OR d.project_id IS NULL OR d.project_id = $4::uuid)
        AND ($8::text IS DISTINCT FROM 'project' OR d.project_id = $6::uuid)
        AND ($8::text IS DISTINCT FROM 'organization' OR d.organization_id = $7::uuid)
        AND ($9::boolean IS NOT TRUE OR d.disabled_at IS NULL)
      ORDER BY rank DESC, s.updated_at DESC
      LIMIT $5`,
    [
      q,
      a.readableOrgIds(),
      orgFilter,
      opts.projectId ?? null,
      limit,
      nearProject,
      nearOrg,
      opts.within ?? null,
      a.isAgent,
    ],
  );
  return rows;
}
