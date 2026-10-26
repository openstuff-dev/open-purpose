/**
 * Export a group or organization to one JSON file, and import such a file as new
 * organizations in this group. Exports are also the backup format.
 *
 * Rows refer to each other by `key`, the row's id where it was exported. An
 * import gives every row a new id, so the same file can be imported twice.
 */
import { z } from 'zod';
import type { Access } from '../auth.js';
import type { Db, Queryable } from '../db.js';
import { tx } from '../db.js';
import { AppError, mapPgError, notFound } from '../errors.js';
import { aliasOwner } from './aliases.js';
import { seedGroupDocs } from './admin.js';
import { syncLinks } from './content.js';
import { DOC_KINDS, EDIT_MODES } from './types.js';
import type {
  ExportApiSpec, ExportDocument, ExportFile, ExportIncludes, ExportOrganization, ExportPerson, ExportProject,
  ExportProposal, ExportScope, ImportReport,
} from '@openpurpose/contracts';

export const DEFAULT_INCLUDES: ExportIncludes = { history: true, proposals: true, people: false, api_specs: true };

const FORMAT = 'openpurpose-export';
const FORMAT_VERSION = 1;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

// ───────────────────────────── export ─────────────────────────────

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
    `SELECT o.id AS key, o.slug, o.name, o.summary, o.created_at, o.archived_at,
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
      group: { slug: a.group.slug, name: a.group.name },
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

// ───────────────────────────── the file format ─────────────────────────────

const key = z.string().min(1).max(200);
const ref = key.nullable();
const slug = z.string().regex(SLUG, 'must be lowercase letters, digits and dashes');
const time = z.iso.datetime({ offset: true });
const mode = z.enum(EDIT_MODES as ['locked', 'propose', 'open']);
const role = z.enum(['admin', 'editor', 'viewer', 'agent']);

const fileSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(FORMAT_VERSION),
  exported_at: time,
  server_version: z.string(),
  source: z.object({
    kind: z.enum(['group', 'organization']),
    group: z.object({ slug: z.string(), name: z.string() }),
    organization: ref,
  }),
  includes: z.object({ history: z.boolean(), proposals: z.boolean(), people: z.boolean(), api_specs: z.boolean() }),
  people: z.array(z.object({
    key,
    name: z.string().min(1).max(200),
    kind: z.enum(['human', 'agent']),
    memberships: z.array(z.object({ organization: ref, role })),
  })),
  organizations: z.array(z.object({
    key, slug, name: z.string().min(1), summary: z.string(), created_at: time, archived_at: time.nullable(), aliases: z.array(slug),
  })),
  read_grants: z.array(z.object({ reader: key, target: key })),
  projects: z.array(z.object({
    key, organization: key, slug, name: z.string().min(1), summary: z.string(), reviewed: z.boolean(),
    created_by: ref, created_at: time, updated_at: time, archived_at: time.nullable(), aliases: z.array(slug),
    repositories: z.array(z.object({ key, remote_key: z.string().min(1), remote_url: z.string().min(1), created_by: ref, created_at: time })),
  })),
  api_specs: z.array(z.object({
    key, project: key, name: z.string(), source_url: z.string().nullable(), filename: z.string().nullable(),
    spec: z.unknown(), source_format: z.enum(['json', 'yaml']), spec_version: z.string(), title: z.string(),
    version: z.string(), endpoint_count: z.number().int(), schema_count: z.number().int(), content_hash: z.string(),
    fetched_at: time.nullable(), fetch_error: z.string().nullable(), created_by: ref, updated_by: ref,
    created_at: time, updated_at: time,
  })),
  scopes: z.array(z.object({
    key, organization: ref, project: ref, slug, name: z.string().min(1), description: z.string(),
    path_globs: z.array(z.string()), stacks: z.array(z.string()), position: z.number().int(),
    created_at: time, updated_at: time, aliases: z.array(slug), repositories: z.array(key),
  })),
  documents: z.array(z.object({
    key, organization: ref, project: ref, scope: ref, kind: z.enum(DOC_KINDS as [ExportDocument['kind'], ...ExportDocument['kind'][]]),
    slug, title: z.string().min(1), mode, position: z.number().int(), created_at: time, updated_at: time,
    sections: z.array(z.object({
      key, heading: z.string().min(1), body: z.string(), mode, position: z.number().int(), version: z.number().int().min(1),
      created_at: time, updated_at: time, updated_by: ref,
      versions: z.array(z.object({
        version: z.number().int().min(1), heading: z.string(), body: z.string(), mode, actor: ref, note: z.string(), created_at: time,
      })),
    })),
  })),
  proposals: z.array(z.object({
    key, kind: z.enum(['edit_section', 'new_section', 'learning']),
    status: z.enum(['pending', 'changes_requested', 'approved', 'rejected']),
    organization: ref, project: ref, scope: ref, document: ref, section: ref, result_section: ref,
    base_version: z.number().int().nullable(), heading: z.string(), body: z.string(), rationale: z.string(),
    context: z.record(z.string(), z.unknown()), revision: z.number().int().min(1),
    created_by: ref, created_at: time, updated_at: time, reviewed_by: ref, reviewed_at: time.nullable(), review_note: z.string(),
    revisions: z.array(z.object({
      revision: z.number().int().min(1), heading: z.string(), body: z.string(), note: z.string(), actor: ref, created_at: time,
    })),
    events: z.array(z.object({
      kind: z.enum(['proposed', 'revised', 'changes_requested', 'approved', 'rejected', 'commented']),
      revision: z.number().int(), note: z.string(), actor: ref, created_at: time,
    })),
    threads: z.array(z.object({
      revision: z.number().int(), line_start: z.number().int().min(1).nullable(), line_end: z.number().int().min(1).nullable(),
      anchor: z.string(), resolved_at: time.nullable(), resolved_by: ref, created_by: ref, created_at: time,
      comments: z.array(z.object({
        actor: ref, body: z.string(), suggestion: z.string().nullable(), applied_at: time.nullable(), applied_by: ref, created_at: time,
      })),
    })),
  })),
});

const invalid = (msg: string) => new AppError('bad_request', `This file can't be imported: ${msg}`);

/** Check the shape of a file and that its rows point at each other consistently. */
export function parseExportFile(input: unknown): ExportFile {
  const head = (input ?? {}) as { format?: unknown; version?: unknown };
  if (head.format !== FORMAT) throw invalid('it is not an OpenPurpose export.');
  if (typeof head.version === 'number' && head.version > FORMAT_VERSION) {
    throw invalid(`it was exported by a newer OpenPurpose (format version ${head.version}). Upgrade this server first.`);
  }
  const file = fileSchema.parse(input) as ExportFile;

  const orgs = new Set(file.organizations.map((o) => o.key));
  const projects = new Map(file.projects.map((p) => [p.key, p]));
  const scopes = new Map(file.scopes.map((s) => [s.key, s]));
  const fail = (msg: string) => { throw invalid(msg); };
  const unique = (what: string, keys: string[]) => {
    if (new Set(keys).size !== keys.length) fail(`two ${what} have the same key.`);
  };
  unique('organizations', file.organizations.map((o) => o.key));
  unique('projects', file.projects.map((p) => p.key));
  unique('scopes', file.scopes.map((s) => s.key));
  unique('documents', file.documents.map((d) => d.key));
  unique('sections', file.documents.flatMap((d) => d.sections.map((s) => s.key)));

  for (const p of file.projects) {
    if (!orgs.has(p.organization)) fail(`project "${p.slug}" belongs to an organization that isn't in the file.`);
  }
  for (const s of file.api_specs) if (!projects.has(s.project)) fail(`API spec "${s.name}" belongs to a project that isn't in the file.`);
  for (const s of file.scopes) {
    const p = s.project ? projects.get(s.project) : null;
    if (s.project && !p) fail(`scope "${s.slug}" belongs to a project that isn't in the file.`);
    if (s.organization && !orgs.has(s.organization)) fail(`scope "${s.slug}" belongs to an organization that isn't in the file.`);
    if (p && p.organization !== s.organization) fail(`scope "${s.slug}" and its project are in different organizations.`);
    const repos = new Set(p?.repositories.map((r) => r.key) ?? []);
    if (s.repositories.some((r) => !repos.has(r))) fail(`scope "${s.slug}" is bound to a repository of another project.`);
  }
  for (const d of file.documents) {
    const level = d.scope ? scopes.get(d.scope) : d.project ? projects.get(d.project) : null;
    if ((d.scope || d.project) && !level) fail(`document "${d.slug}" belongs to a project or scope that isn't in the file.`);
    if (d.organization && !orgs.has(d.organization)) fail(`document "${d.slug}" belongs to an organization that isn't in the file.`);
    const s = d.scope ? scopes.get(d.scope)! : null;
    if (s && (s.organization !== d.organization || s.project !== d.project)) fail(`document "${d.slug}" and its scope are at different levels.`);
    if (!s && d.project && projects.get(d.project)!.organization !== d.organization) {
      fail(`document "${d.slug}" and its project are in different organizations.`);
    }
  }
  for (const g of file.read_grants) {
    if (!orgs.has(g.reader) || !orgs.has(g.target)) fail('a read grant names an organization that isn\'t in the file.');
  }
  return file;
}

// ───────────────────────────── import ─────────────────────────────

export interface ImportOptions {
  /** New slugs for organizations whose slug is taken here, by organization key. */
  renames?: Record<string, string>;
  /** Preview: run the whole import, report it, and roll it back. */
  dryRun: boolean;
}

class DryRun extends Error {}

/**
 * Import every organization in the file as a new organization in this group.
 * Group-wide content (documents, scopes, roles) is left out; it belongs to the group being imported into.
 */
export async function importContent(db: Db, a: Access, input: unknown, opts: ImportOptions): Promise<ImportReport> {
  a.requireAdmin(null);
  const file = parseExportFile(input);
  const report: ImportReport = {
    ok: true,
    applied: false,
    source: { ...file.source, exported_at: file.exported_at },
    organizations: [],
    counts: { people: 0, projects: 0, repositories: 0, api_specs: 0, scopes: 0, documents: 0, sections: 0, section_versions: 0, proposals: 0 },
    warnings: [],
  };

  const taken = async (s: string): Promise<string | null> => {
    const { rows } = await db.query<{ name: string }>('SELECT name FROM organizations WHERE slug = $1', [s]);
    if (rows[0]) return `${rows[0].name} already uses "${s}".`;
    const owner = await aliasOwner(db, 'organization', {}, s, null);
    return owner ? `"${s}" is an old slug of ${owner.name}; links that use it lead there.` : null;
  };
  const chosen = new Set<string>();
  for (const o of file.organizations) {
    const s = (opts.renames?.[o.key] ?? o.slug).trim().toLowerCase();
    let conflict = !SLUG.test(s) ? `"${s}" isn't a valid slug.` : chosen.has(s) ? `Another organization in the file uses "${s}".` : await taken(s);
    let suggested: string | null = null;
    if (conflict) {
      const base = SLUG.test(s) ? s.slice(0, 58) : o.slug.slice(0, 58);
      for (let i = 2; !suggested; i++) {
        const candidate = `${base}-${i}`;
        if (!chosen.has(candidate) && !(await taken(candidate))) suggested = candidate;
      }
    }
    chosen.add(suggested ?? s);
    if (conflict) report.ok = false;
    report.organizations.push({ key: o.key, name: o.name, slug: s, conflict, suggested_slug: suggested, id: null });
  }
  if (!report.ok && !opts.dryRun) {
    throw new AppError('conflict', 'Some organization slugs are already used here. Choose other slugs and import again.', { report });
  }

  try {
    await tx(db, async (c) => {
      // A preview with conflicts still runs on the suggested slugs, so its counts and warnings are real.
      await apply(c, a, file, report);
      if (opts.dryRun) throw new DryRun();
    });
    report.applied = true;
  } catch (err) {
    if (!(err instanceof DryRun)) throw mapPgError(err);
    for (const o of report.organizations) o.id = null;
  }
  return report;
}

async function apply(c: Queryable, a: Access, file: ExportFile, report: ImportReport): Promise<void> {
  const counts = report.counts;
  const warn = (msg: string) => report.warnings.push(msg);
  const ids = {
    people: new Map<string, string>(), orgs: new Map<string, string>(), projects: new Map<string, string>(),
    repos: new Map<string, string>(), scopes: new Map<string, string>(), docs: new Map<string, string>(),
    sections: new Map<string, string>(),
  };
  const actor = (k: string | null) => (k ? ids.people.get(k) ?? null : null);
  const id = (map: Map<string, string>, k: string | null) => (k ? map.get(k) ?? null : null);

  // People come in disabled and without tokens: someone here decides who may act.
  let groupRoles = 0;
  for (const p of file.people) {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO actors (name, kind, disabled_at) VALUES ($1, $2, now()) RETURNING id`, [p.name, p.kind]);
    ids.people.set(p.key, rows[0].id);
    counts.people++;
    groupRoles += p.memberships.filter((m) => !m.organization).length;
  }
  if (counts.people) warn(`${counts.people} people and agents are added disabled and without tokens. Enable them under People and agents.`);
  if (groupRoles) warn(`${groupRoles} group-wide roles are left out; roles in the group itself are set here.`);

  const usedAliases = new Set((await c.query<{ old_slug: string }>(
    'SELECT old_slug FROM slug_aliases WHERE organization_id IS NOT NULL')).rows.map((r) => r.old_slug));
  const newSlugs = new Set<string>();
  for (const o of report.organizations) newSlugs.add(o.conflict ? o.suggested_slug! : o.slug);
  const existingSlugs = new Set((await c.query<{ slug: string }>('SELECT slug FROM organizations')).rows.map((r) => r.slug));

  for (const [i, o] of file.organizations.entries()) {
    const target = report.organizations[i];
    const s = target.conflict ? target.suggested_slug! : target.slug;
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, summary, created_at, archived_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [s, o.name, o.summary, o.created_at, o.archived_at]);
    ids.orgs.set(o.key, rows[0].id);
    target.id = rows[0].id;
    if (s !== o.slug) warn(`${o.name} is imported as "${s}", so links to [[${o.slug}]] don't lead to it.`);
    for (const old of o.aliases) {
      if (old === s || newSlugs.has(old) || existingSlugs.has(old) || usedAliases.has(old)) {
        warn(`The old slug "${old}" of ${o.name} is already used here, so it is left out.`);
        continue;
      }
      usedAliases.add(old);
      await c.query('INSERT INTO slug_aliases (organization_id, old_slug) VALUES ($1, $2)', [rows[0].id, old]);
    }
  }
  for (const p of file.people) {
    for (const m of p.memberships) {
      const org = id(ids.orgs, m.organization);
      if (org) await c.query('INSERT INTO memberships (actor_id, organization_id, role) VALUES ($1, $2, $3)', [ids.people.get(p.key), org, m.role]);
    }
  }
  for (const g of file.read_grants) {
    await c.query('INSERT INTO org_read_grants (reader_org_id, target_org_id) VALUES ($1, $2)', [ids.orgs.get(g.reader), ids.orgs.get(g.target)]);
  }

  const remotes = new Set((await c.query<{ remote_key: string }>('SELECT remote_key FROM repositories')).rows.map((r) => r.remote_key));
  for (const p of file.projects) {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO projects (organization_id, slug, name, summary, reviewed, created_by, created_at, updated_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [ids.orgs.get(p.organization), p.slug, p.name, p.summary, p.reviewed, actor(p.created_by), p.created_at, p.updated_at, p.archived_at]);
    const projectId = rows[0].id;
    ids.projects.set(p.key, projectId);
    counts.projects++;
    const siblings = new Set(file.projects.filter((x) => x.organization === p.organization).map((x) => x.slug));
    for (const old of new Set(p.aliases)) {
      if (!siblings.has(old)) await c.query('INSERT INTO slug_aliases (project_id, old_slug) VALUES ($1, $2)', [projectId, old]);
    }
    for (const r of p.repositories) {
      if (remotes.has(r.remote_key)) {
        warn(`The repository ${r.remote_url} is already registered in this group, so it is left out of ${p.name}.`);
        continue;
      }
      remotes.add(r.remote_key);
      const { rows: repo } = await c.query<{ id: string }>(
        `INSERT INTO repositories (project_id, remote_key, remote_url, created_by, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [projectId, r.remote_key, r.remote_url, actor(r.created_by), r.created_at]);
      ids.repos.set(r.key, repo[0].id);
      counts.repositories++;
    }
  }

  for (const s of file.api_specs) {
    await c.query(
      `INSERT INTO api_specs (project_id, name, source_url, filename, spec, source_format, spec_version, title, version,
                              endpoint_count, schema_count, content_hash, fetched_at, fetch_error, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::json, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [ids.projects.get(s.project), s.name, s.source_url, s.filename, JSON.stringify(s.spec ?? null), s.source_format, s.spec_version,
        s.title, s.version, s.endpoint_count, s.schema_count, s.content_hash, s.fetched_at, s.fetch_error,
        actor(s.created_by), actor(s.updated_by), s.created_at, s.updated_at]);
    counts.api_specs++;
  }

  const groupScopes = file.scopes.filter((s) => !s.organization).length;
  for (const s of file.scopes.filter((x) => x.organization)) {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO scopes (organization_id, project_id, slug, name, description, path_globs, stacks, position, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [ids.orgs.get(s.organization!), id(ids.projects, s.project), s.slug, s.name, s.description, s.path_globs, s.stacks,
        s.position, s.created_at, s.updated_at]);
    ids.scopes.set(s.key, rows[0].id);
    counts.scopes++;
    const siblings = new Set(file.scopes.filter((x) => x.organization === s.organization && x.project === s.project).map((x) => x.slug));
    for (const old of new Set(s.aliases)) {
      if (!siblings.has(old)) await c.query('INSERT INTO slug_aliases (scope_id, old_slug) VALUES ($1, $2)', [rows[0].id, old]);
    }
    for (const r of s.repositories) {
      const repo = ids.repos.get(r);
      if (repo) await c.query('INSERT INTO scope_repositories (scope_id, repository_id) VALUES ($1, $2)', [rows[0].id, repo]);
    }
  }

  const groupDocs = file.documents.filter((d) => !d.organization).length;
  for (const d of file.documents.filter((x) => x.organization)) {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO documents (organization_id, project_id, scope_id, kind, slug, title, mode, position, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [ids.orgs.get(d.organization!), id(ids.projects, d.project), id(ids.scopes, d.scope), d.kind, d.slug, d.title, d.mode,
        d.position, d.created_at, d.updated_at]);
    ids.docs.set(d.key, rows[0].id);
    counts.documents++;
    for (const s of d.sections) {
      const { rows: sec } = await c.query<{ id: string }>(
        `INSERT INTO sections (document_id, heading, body, mode, position, version, created_at, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [rows[0].id, s.heading, s.body, s.mode, s.position, s.version, s.created_at, s.updated_at, actor(s.updated_by)]);
      const sectionId = sec[0].id;
      ids.sections.set(s.key, sectionId);
      counts.sections++;
      await syncLinks(c, sectionId, s.body);
      // Without history, the current text is the only version.
      const versions = s.versions.length ? s.versions : [{
        version: s.version, heading: s.heading, body: s.body, mode: s.mode, actor: s.updated_by, note: 'Imported', created_at: s.updated_at,
      }];
      for (const v of versions) {
        await c.query(
          `INSERT INTO section_versions (section_id, version, heading, body, mode, actor_id, note, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [sectionId, v.version, v.heading, v.body, v.mode, actor(v.actor), v.note, v.created_at]);
        counts.section_versions++;
      }
    }
  }

  let groupProposals = 0;
  let orphaned = 0;
  for (const p of file.proposals) {
    if (!p.organization) { groupProposals++; continue; }
    const doc = id(ids.docs, p.document);
    const section = id(ids.sections, p.section);
    if ((p.document && !doc) || (p.section && !section)) { orphaned++; continue; }
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO proposals (kind, status, organization_id, project_id, scope_id, document_id, section_id, result_section_id,
                              base_version, heading, body, rationale, context, revision, created_by, created_at, updated_at,
                              reviewed_by, reviewed_at, review_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
      [p.kind, p.status, ids.orgs.get(p.organization), id(ids.projects, p.project), id(ids.scopes, p.scope), doc, section,
        id(ids.sections, p.result_section), p.base_version, p.heading, p.body, p.rationale, p.context, p.revision,
        actor(p.created_by), p.created_at, p.updated_at, actor(p.reviewed_by), p.reviewed_at, p.review_note]);
    const proposalId = rows[0].id;
    counts.proposals++;
    for (const r of p.revisions) {
      await c.query(
        `INSERT INTO proposal_revisions (proposal_id, revision, heading, body, note, actor_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [proposalId, r.revision, r.heading, r.body, r.note, actor(r.actor), r.created_at]);
    }
    for (const e of p.events) {
      await c.query(
        `INSERT INTO proposal_events (proposal_id, kind, revision, note, actor_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [proposalId, e.kind, e.revision, e.note, actor(e.actor), e.created_at]);
    }
    for (const t of p.threads) {
      const { rows: thread } = await c.query<{ id: string }>(
        `INSERT INTO review_threads (proposal_id, revision, line_start, line_end, anchor, resolved_at, resolved_by, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [proposalId, t.revision, t.line_start, t.line_end, t.anchor, t.resolved_at, actor(t.resolved_by), actor(t.created_by), t.created_at]);
      for (const cm of t.comments) {
        await c.query(
          `INSERT INTO review_comments (thread_id, actor_id, body, suggestion, applied_at, applied_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [thread[0].id, actor(cm.actor), cm.body, cm.suggestion, cm.applied_at, actor(cm.applied_by), cm.created_at]);
      }
    }
  }

  const skipped = [
    groupDocs && `${groupDocs} documents`, groupScopes && `${groupScopes} scopes`, groupProposals && `${groupProposals} proposals`,
  ].filter(Boolean);
  if (skipped.length) warn(`Group-wide content is left out (${skipped.join(', ')}); this group keeps its own.`);
  if (orphaned) warn(`${orphaned} proposals are left out because the content they change isn't in the file.`);

  await seedGroupDocs(c, a.actor.id);
}
