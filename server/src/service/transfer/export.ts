import type { Access } from '../../auth.js';
import type { Queryable } from '../../db.js';
import { notFound } from '../../errors.js';
import { FORMAT, FORMAT_VERSION } from './format.js';
import type {
  ExportApiSpec, ExportDocument, ExportFile, ExportIncludes, ExportOrganization, ExportPerson, ExportProject,
  ExportProposal, ExportScope,
} from '@openpurpose/contracts';

export const DEFAULT_INCLUDES: ExportIncludes = { history: true, proposals: true, people: false, api_specs: true };

/** The whole group (organizationId null, group admins) or one organization (its admins). */
export async function exportContent(
  db: Queryable, a: Access, organizationId: string | null, includes: ExportIncludes, serverVersion: string,
): Promise<ExportFile> {
  if (organizationId && !a.org(organizationId)) throw notFound('Organization');
  a.requireAdmin(organizationId);
  const org = organizationId;

  // Every actor reference goes through `who`: without people, it is null.
  const actors = new Set<string>();
  const who = (id: string | null): string | null => {
    if (!id || !includes.people) return null;
    actors.add(id);
    return id;
  };

  const organizations = (await db.query<ExportOrganization>(
    `SELECT o.id AS key, o.slug, o.name, o.summary, o.created_at, o.archived_at, o.context_max_tokens,
            ARRAY(SELECT x.old_slug FROM slug_aliases x WHERE x.organization_id = o.id ORDER BY x.created_at) AS aliases
       FROM organizations o WHERE $1::uuid IS NULL OR o.id = $1 ORDER BY o.created_at, o.slug`, [org])).rows;

  const readGrants = org ? [] : (await db.query<{ reader: string; target: string }>(
    'SELECT reader_org_id AS reader, target_org_id AS target FROM org_read_grants ORDER BY created_at')).rows;

  const repos = (await db.query<ExportProject['repositories'][number] & { project_id: string }>(
    `SELECT r.id AS key, r.project_id, r.remote_key, r.remote_url, r.created_by, r.created_at
       FROM repositories r JOIN projects p ON p.id = r.project_id
      WHERE $1::uuid IS NULL OR p.organization_id = $1 ORDER BY r.created_at`, [org])).rows;
  const projects = (await db.query<ExportProject>(
    `SELECT p.id AS key, p.organization_id AS organization, p.slug, p.name, p.summary, p.reviewed, p.created_by,
            p.created_at, p.updated_at, p.archived_at,
            ARRAY(SELECT x.old_slug FROM slug_aliases x WHERE x.project_id = p.id ORDER BY x.created_at) AS aliases
       FROM projects p WHERE $1::uuid IS NULL OR p.organization_id = $1 ORDER BY p.created_at, p.slug`, [org])).rows
    .map((p) => ({
      ...p,
      created_by: who(p.created_by),
      repositories: repos.filter((r) => r.project_id === p.key)
        .map(({ project_id: _, ...r }) => ({ ...r, created_by: who(r.created_by) })),
    }));

  const apiSpecs = !includes.api_specs ? [] : (await db.query<ExportApiSpec>(
    `SELECT s.id AS key, s.project_id AS project, s.name, s.source_url, s.filename, s.spec, s.source_format,
            s.spec_version, s.title, s.version, s.endpoint_count, s.schema_count, s.content_hash, s.fetched_at,
            s.fetch_error, s.created_by, s.updated_by, s.created_at, s.updated_at
       FROM api_specs s JOIN projects p ON p.id = s.project_id
      WHERE $1::uuid IS NULL OR p.organization_id = $1 ORDER BY s.created_at`, [org])).rows
    .map((s) => ({ ...s, created_by: who(s.created_by), updated_by: who(s.updated_by) }));

  const scopes = (await db.query<ExportScope>(
    `SELECT s.id AS key, s.organization_id AS organization, s.project_id AS project, s.slug, s.name, s.description,
            s.path_globs, s.stacks, s.position, s.created_at, s.updated_at,
            ARRAY(SELECT x.old_slug FROM slug_aliases x WHERE x.scope_id = s.id ORDER BY x.created_at) AS aliases,
            ARRAY(SELECT sr.repository_id::text FROM scope_repositories sr WHERE sr.scope_id = s.id ORDER BY sr.created_at) AS repositories
       FROM scopes s WHERE $1::uuid IS NULL OR s.organization_id = $1
      ORDER BY s.organization_id NULLS FIRST, s.project_id NULLS FIRST, s.position, s.slug`, [org])).rows;

  type SectionRow = Omit<ExportDocument['sections'][number], 'versions'> & { document_id: string };
  const sections = (await db.query<SectionRow>(
    `SELECT s.id AS key, s.document_id, s.heading, s.body, s.mode, s.position, s.version, s.created_at, s.updated_at, s.updated_by
       FROM sections s JOIN documents d ON d.id = s.document_id
      WHERE $1::uuid IS NULL OR d.organization_id = $1 ORDER BY s.position, s.created_at`, [org])).rows;
  type VersionRow = ExportDocument['sections'][number]['versions'][number] & { section_id: string };
  const versions = !includes.history ? [] : (await db.query<VersionRow>(
    `SELECT v.section_id, v.version, v.heading, v.body, v.mode, v.actor_id AS actor, v.note, v.created_at
       FROM section_versions v JOIN sections s ON s.id = v.section_id JOIN documents d ON d.id = s.document_id
      WHERE $1::uuid IS NULL OR d.organization_id = $1 ORDER BY v.section_id, v.version`, [org])).rows;
  const versionsOf = groupBy(versions, (v) => v.section_id);
  const sectionsOf = groupBy(sections, (s) => s.document_id);

  const documents = (await db.query<Omit<ExportDocument, 'sections'>>(
    `SELECT d.id AS key, d.organization_id AS organization, d.project_id AS project, d.scope_id AS scope, d.kind, d.slug,
            d.title, d.mode, d.position, d.created_at, d.updated_at
       FROM documents d WHERE $1::uuid IS NULL OR d.organization_id = $1
      ORDER BY d.organization_id NULLS FIRST, d.project_id NULLS FIRST, d.scope_id NULLS FIRST, d.position, d.slug`, [org])).rows
    .map((d) => ({
      ...d,
      sections: (sectionsOf.get(d.key) ?? []).map(({ document_id: _, ...s }) => ({
        ...s,
        updated_by: who(s.updated_by),
        versions: (versionsOf.get(s.key) ?? []).map(({ section_id: __, ...v }) => ({ ...v, actor: who(v.actor) })),
      })),
    }));

  const proposals = includes.proposals ? await exportProposals(db, org, documents, who) : [];

  let people: ExportPerson[] = [];
  if (includes.people) {
    const memberships = (await db.query<{ actor_id: string; organization: string | null; role: ExportPerson['memberships'][number]['role'] }>(
      `SELECT actor_id, organization_id AS organization, role FROM memberships
        WHERE $1::uuid IS NULL OR organization_id = $1 ORDER BY created_at`, [org])).rows;
    for (const m of memberships) actors.add(m.actor_id);
    const { rows } = await db.query<{ key: string; name: string; kind: ExportPerson['kind'] }>(
      'SELECT id AS key, name, kind FROM actors WHERE id = ANY($1::uuid[]) ORDER BY kind DESC, name', [[...actors]]);
    people = rows.map((p) => ({
      ...p,
      memberships: memberships.filter((m) => m.actor_id === p.key).map(({ organization, role }) => ({ organization, role })),
    }));
  }

  const file: ExportFile = {
    format: FORMAT,
    version: FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    server_version: serverVersion,
    source: {
      kind: org ? 'organization' : 'group',
      group: {
        slug: a.group.slug, name: a.group.name,
        context_max_tokens: (await db.query<{ max: number | null }>('SELECT context_max_tokens AS max FROM groups WHERE id = $1', [a.group.id])).rows[0]?.max ?? null,
      },
      organization: org,
    },
    includes,
    people,
    organizations,
    read_grants: readGrants,
    projects,
    api_specs: apiSpecs,
    scopes,
    documents,
    proposals,
  };
  // Dates become ISO strings, exactly as they will be in the file.
  return JSON.parse(JSON.stringify(file)) as ExportFile;
}

/** Proposals on content that isn't in the export (e.g. a learning promoted to the group) are left out. */
async function exportProposals(
  db: Queryable, org: string | null, documents: ExportDocument[], who: (id: string | null) => string | null,
): Promise<ExportProposal[]> {
  const docKeys = new Set(documents.map((d) => d.key));
  const sectionKeys = new Set(documents.flatMap((d) => d.sections.map((s) => s.key)));
  type Row = Omit<ExportProposal, 'revisions' | 'events' | 'threads'>;
  const rows = (await db.query<Row>(
    `SELECT id AS key, kind, status, organization_id AS organization, project_id AS project, scope_id AS scope,
            document_id AS document, section_id AS section, result_section_id AS result_section, base_version, heading,
            body, rationale, context, revision, created_by, created_at, updated_at, reviewed_by, reviewed_at, review_note
       FROM proposals WHERE $1::uuid IS NULL OR organization_id = $1 ORDER BY created_at`, [org])).rows
    .filter((p) => (!p.document || docKeys.has(p.document)) && (!p.section || sectionKeys.has(p.section)));
  const keys = rows.map((p) => p.key);

  const revisions = groupBy((await db.query<ExportProposal['revisions'][number] & { proposal_id: string }>(
    `SELECT proposal_id, revision, heading, body, note, actor_id AS actor, created_at FROM proposal_revisions
      WHERE proposal_id = ANY($1::uuid[]) ORDER BY revision`, [keys])).rows, (r) => r.proposal_id);
  const events = groupBy((await db.query<ExportProposal['events'][number] & { proposal_id: string }>(
    `SELECT proposal_id, kind, revision, note, actor_id AS actor, created_at FROM proposal_events
      WHERE proposal_id = ANY($1::uuid[]) ORDER BY created_at`, [keys])).rows, (e) => e.proposal_id);
  type ThreadRow = Omit<ExportProposal['threads'][number], 'comments'> & { id: string; proposal_id: string };
  const threads = (await db.query<ThreadRow>(
    `SELECT id, proposal_id, revision, line_start, line_end, anchor, resolved_at, resolved_by, created_by, created_at
       FROM review_threads WHERE proposal_id = ANY($1::uuid[]) ORDER BY created_at`, [keys])).rows;
  const comments = groupBy((await db.query<ExportProposal['threads'][number]['comments'][number] & { thread_id: string }>(
    `SELECT thread_id, actor_id AS actor, body, suggestion, applied_at, applied_by, created_at FROM review_comments
      WHERE thread_id = ANY($1::uuid[]) ORDER BY created_at`, [threads.map((t) => t.id)])).rows, (c) => c.thread_id);
  const threadsOf = groupBy(threads, (t) => t.proposal_id);

  return rows.map((p) => ({
    ...p,
    result_section: p.result_section && sectionKeys.has(p.result_section) ? p.result_section : null,
    created_by: who(p.created_by),
    reviewed_by: who(p.reviewed_by),
    revisions: (revisions.get(p.key) ?? []).map(({ proposal_id: _, ...r }) => ({ ...r, actor: who(r.actor) })),
    events: (events.get(p.key) ?? []).map(({ proposal_id: _, ...e }) => ({ ...e, actor: who(e.actor) })),
    threads: (threadsOf.get(p.key) ?? []).map(({ id, proposal_id: _, ...t }) => ({
      ...t,
      resolved_by: who(t.resolved_by),
      created_by: who(t.created_by),
      comments: (comments.get(id) ?? []).map(({ thread_id: __, ...c }) => ({
        ...c, actor: who(c.actor), applied_by: who(c.applied_by),
      })),
    })),
  }));
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(r);
  }
  return out;
}

