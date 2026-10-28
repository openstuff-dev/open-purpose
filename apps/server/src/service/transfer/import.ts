/**
 * Import an export file: each organization as a new one, merged into one that is
 * already here, or skipped; or the whole file as a new group.
 *
 * New and merged organizations go through the same steps: every row is matched to
 * one already here (by slug, old slug, heading or key) and only inserted when
 * nothing matches. A new organization simply has nothing to match yet.
 */
import type { Access, Actor } from '../../auth.js';
import { requireSuperadmin } from '../../auth.js';
import type { Db, Pool, Queryable } from '../../db.js';
import { beginScope, endScope, tx } from '../../db.js';
import { AppError, mapPgError } from '../../errors.js';
import { aliasOwner } from '../aliases.js';
import { seedGroupDocs } from '../admin.js';
import { syncLinks } from '../content.js';
import { SLUG, parseExportFile } from './format.js';
import type {
  EditMode,
  ExportDocument,
  ExportFile,
  ExportSection,
  ImportChange,
  ImportChangePolicy,
  ImportOptions,
  ImportReport,
} from '@openpurpose/contracts';

class DryRun extends Error {}

interface Run {
  c: Queryable;
  file: ExportFile;
  opts: ImportOptions;
  report: ImportReport;
  actorId: string;
  /** Import the file's group-wide content (documents, scopes, proposals) at this group's level. */
  groupContent: boolean;
  /** Give imported people their roles in the group itself (only a new group). */
  groupRoles: boolean;
  /** Shown as the note of updated sections and the rationale of proposals. */
  label: string;
}

function emptyReport(file: ExportFile): ImportReport {
  return {
    ok: true,
    applied: false,
    source: { ...file.source, exported_at: file.exported_at },
    group: null,
    organizations: [],
    group_content: {
      documents: file.documents.filter((d) => !d.organization).length,
      scopes: file.scopes.filter((s) => !s.organization).length,
      proposals: file.proposals.filter((p) => !p.organization).length,
      included: false,
    },
    counts: {
      people: 0,
      projects: 0,
      repositories: 0,
      api_specs: 0,
      scopes: 0,
      documents: 0,
      sections: 0,
      section_versions: 0,
      proposals: 0,
      findings: 0,
    },
    merged: {
      people: 0,
      projects: 0,
      api_specs: 0,
      scopes: 0,
      documents: 0,
      sections: 0,
      unchanged: 0,
      proposed: 0,
      updated: 0,
      kept: 0,
      removed: 0,
      conflicts: 0,
    },
    changes: [],
    warnings: [],
  };
}

function labelOf(file: ExportFile): string {
  const org = file.organizations.find((o) => o.key === file.source.organization);
  return `Imported from ${file.source.group.name}${org ? ` › ${org.name}` : ''} (exported ${file.exported_at.slice(0, 10)})`;
}

/** A free slug like `base-2`, for whatever `taken` says is in use. */
async function freeSlug(base: string, taken: (s: string) => Promise<unknown>): Promise<string> {
  const stem = base.slice(0, 58);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}`;
    if (!(await taken(candidate))) return candidate;
  }
}

// ───────────────────────────── into this group ─────────────────────────────

/**
 * Import into the caller's group. New organizations and group-wide content need a
 * group admin; merging into an organization needs an admin of that organization.
 */
export async function importContent(
  db: Db,
  a: Access,
  input: unknown,
  opts: ImportOptions & { dryRun: boolean },
): Promise<ImportReport> {
  const file = parseExportFile(input);
  const report = emptyReport(file);
  report.group_content.included = !!opts.group_content;
  if (opts.group_content) a.requireAdmin(null);

  const taken = async (s: string): Promise<string | null> => {
    const { rows } = await db.query<{ name: string }>(
      'SELECT name FROM organizations WHERE slug = $1',
      [s],
    );
    if (rows[0]) return `${rows[0].name} already uses "${s}".`;
    const owner = await aliasOwner(db, 'organization', {}, s, null);
    return owner ? `"${s}" is an old slug of ${owner.name}; links that use it lead there.` : null;
  };
  const chosen = new Set<string>();
  const mergeTargets = new Set<string>();
  for (const o of file.organizations) {
    // Only group admins can add organizations, so for anyone else an organization without a choice
    // is left out.
    const choice =
      opts.organizations?.[o.key] ??
      (a.canAdmin(null) ? { action: 'new' as const } : { action: 'skip' as const });
    const here = a.orgBySlug(o.slug);
    const entry: ImportReport['organizations'][number] = {
      key: o.key,
      name: o.name,
      slug: o.slug,
      action: choice.action,
      new_slug: null,
      into: null,
      existing: here ? { id: here.id, name: here.name } : null,
      conflict: null,
      suggested_slug: null,
      id: null,
    };
    report.organizations.push(entry);
    if (choice.action === 'skip') continue;
    if (choice.action === 'merge') {
      const into = a.org(choice.into);
      if (!into) {
        entry.conflict = "That organization isn't in this group.";
      } else {
        a.requireAdmin(into.id);
        entry.into = { id: into.id, name: into.name };
        if (mergeTargets.has(into.id))
          entry.conflict = `Another organization in the file is merged into ${into.name}.`;
        mergeTargets.add(into.id);
      }
      continue;
    }
    a.requireAdmin(null);
    const s = (choice.slug ?? o.slug).trim().toLowerCase();
    entry.new_slug = s;
    entry.conflict = !SLUG.test(s)
      ? `"${s}" isn't a valid slug.`
      : chosen.has(s)
        ? `Another organization in the file uses "${s}".`
        : await taken(s);
    if (entry.conflict) {
      entry.suggested_slug = await freeSlug(
        SLUG.test(s) ? s : o.slug,
        async (x) => chosen.has(x) || (await taken(x)),
      );
    }
    chosen.add(entry.suggested_slug ?? s);
  }
  report.ok = report.organizations.every((o) => !o.conflict);
  if (!report.ok && !opts.dryRun) {
    throw new AppError(
      'conflict',
      "Some organizations can't be imported as chosen. Change them and import again.",
      { report },
    );
  }

  try {
    await tx(db, async (c) => {
      // A preview with conflicts still runs (on suggested slugs), so its counts and warnings are
      // real.
      await apply({
        c,
        file,
        opts,
        report,
        actorId: a.actor.id,
        groupContent: !!opts.group_content,
        groupRoles: false,
        label: labelOf(file),
      });
      if (opts.dryRun) throw new DryRun();
    });
    report.applied = true;
  } catch (err) {
    if (!(err instanceof DryRun)) throw mapPgError(err);
    for (const o of report.organizations) o.id = null;
  }
  return report;
}

// ───────────────────────────── as a new group ─────────────────────────────

/**
 * Server admins: the whole file as a new group, with its group-wide content. The caller becomes its
 * admin.
 */
export async function importAsGroup(
  pool: Pool,
  actor: Actor,
  input: unknown,
  opts: { name?: string; slug?: string; dryRun: boolean },
): Promise<ImportReport> {
  requireSuperadmin(actor);
  const file = parseExportFile(input);
  const report = emptyReport(file);
  report.group_content.included = true;
  const name = opts.name?.trim() || file.source.group.name;
  const slug = (opts.slug ?? file.source.group.slug).trim().toLowerCase();
  const taken = async (s: string) =>
    (await pool.query('SELECT 1 FROM groups WHERE slug = $1', [s])).rowCount
      ? `Another group already uses "${s}".`
      : null;
  const conflict = !SLUG.test(slug) ? `"${slug}" isn't a valid slug.` : await taken(slug);
  const suggested = conflict ? await freeSlug(SLUG.test(slug) ? slug : 'group', taken) : null;
  report.group = { id: null, name, slug, conflict, suggested_slug: suggested };
  report.ok = !conflict;
  if (conflict && !opts.dryRun) throw new AppError('conflict', conflict, { report });

  for (const o of file.organizations) {
    report.organizations.push({
      key: o.key,
      name: o.name,
      slug: o.slug,
      action: 'new',
      new_slug: o.slug,
      into: null,
      existing: null,
      conflict: null,
      suggested_slug: null,
      id: null,
    });
  }

  const c = await beginScope(pool, { groupId: null });
  let commit = false;
  try {
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO groups (slug, name, context_max_tokens) VALUES ($1, $2, $3) RETURNING id',
      [suggested ?? slug, name, file.source.group.context_max_tokens ?? null],
    );
    await c.query('SELECT set_config(\'openpurpose.group_id\', $1, true)', [rows[0].id]);
    await c.query(
      'INSERT INTO memberships (actor_id, organization_id, role) VALUES ($1, NULL, \'admin\')',
      [actor.id],
    );
    await apply({
      c,
      file,
      opts: {},
      report,
      actorId: actor.id,
      groupContent: true,
      groupRoles: true,
      label: labelOf(file),
    });
    report.group.id = rows[0].id;
    commit = !opts.dryRun;
  } catch (err) {
    throw mapPgError(err);
  } finally {
    await endScope(c, commit);
  }
  report.applied = commit;
  if (!commit) {
    report.group.id = null;
    for (const o of report.organizations) o.id = null;
  }
  return report;
}

// ───────────────────────────── the steps ─────────────────────────────

const sameText = (a: { heading: string; body: string }, b: { heading: string; body: string }) =>
  a.heading === b.heading && a.body === b.body;
const headingKey = (h: string) => h.trim().toLowerCase();

async function apply(run: Run): Promise<void> {
  const { c, file, report } = run;
  const { counts, merged } = report;
  const warn = (msg: string) => report.warnings.push(msg);
  const policyOf = (key: string): ImportChangePolicy =>
    run.opts.section_changes?.[key] ?? run.opts.changes ?? 'propose';
  const ids = {
    people: new Map<string, string>(),
    orgs: new Map<string, string>(),
    projects: new Map<string, string>(),
    repos: new Map<string, string>(),
    scopes: new Map<string, string>(),
    docs: new Map<string, string>(),
    sections: new Map<string, string>(),
  };
  const actor = (k: string | null) => (k ? (ids.people.get(k) ?? null) : null);
  const id = (map: Map<string, string>, k: string | null) => (k ? (map.get(k) ?? null) : null);
  /** Rows the file touched in organizations that were merged; with remove_missing, the rest go. */
  const kept = { projects: new Set<string>(), scopes: new Set<string>(), docs: new Set<string>() };
  const mergedOrgs = new Set<string>();
  const updateMeta = run.opts.changes === 'file';
  let metaKept = 0;

  // A level is imported when its organization is, or (null) when group-wide content is.
  const orgOf = (k: string | null): string | null | undefined =>
    k ? ids.orgs.get(k) : run.groupContent ? null : undefined;
  const names = {
    org: new Map<string, string>(),
    project: new Map(file.projects.map((p) => [p.key, p.name])),
    scope: new Map(file.scopes.map((s) => [s.key, s.name])),
  };
  const placeOf = (d: ExportDocument) =>
    [
      d.organization ? names.org.get(d.organization) : 'Group',
      id(names.project, d.project),
      id(names.scope, d.scope),
      d.title,
    ]
      .filter(Boolean)
      .join(' › ');

  // ── people: matched by name to someone in this group, or added disabled and without tokens.
  const here = (
    await c.query<{ id: string; name: string; kind: string }>(
      'SELECT DISTINCT a.id, a.name, a.kind FROM actors a JOIN memberships m ON m.actor_id = a.id',
    )
  ).rows;
  const newPeople = new Set<string>();
  for (const p of file.people) {
    const match =
      here.find((h) => h.id === p.key) ??
      here.find(
        (h) => h.kind === p.kind && h.name.trim().toLowerCase() === p.name.trim().toLowerCase(),
      );
    if (match) {
      ids.people.set(p.key, match.id);
      merged.people++;
      continue;
    }
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO actors (name, kind, disabled_at) VALUES ($1, $2, now()) RETURNING id',
      [p.name, p.kind],
    );
    ids.people.set(p.key, rows[0].id);
    newPeople.add(p.key);
    counts.people++;
  }
  if (counts.people)
    warn(
      `${counts.people} people and agents are added disabled and without tokens. Enable them under People and agents.`,
    );
  if (merged.people)
    warn(
      `${merged.people} people in the file are already here (same name); their roles here stay as they are.`,
    );

  // ── organizations
  const existingSlugs = new Set(
    (await c.query<{ slug: string }>('SELECT slug FROM organizations')).rows.map((r) => r.slug),
  );
  const usedAliases = new Set(
    (
      await c.query<{ old_slug: string }>(
        'SELECT old_slug FROM slug_aliases WHERE organization_id IS NOT NULL',
      )
    ).rows.map((r) => r.old_slug),
  );
  const newSlugs = new Set(
    report.organizations
      .filter((o) => o.action === 'new')
      .flatMap((o) => o.suggested_slug ?? o.new_slug ?? []),
  );
  for (const [i, o] of file.organizations.entries()) {
    const entry = report.organizations[i];
    let orgId: string;
    let slug: string;
    if (entry.action === 'skip' || (entry.action === 'merge' && (entry.conflict || !entry.into)))
      continue;
    if (entry.action === 'merge' && entry.into) {
      const into = entry.into;
      orgId = into.id;
      slug = (
        await c.query<{ slug: string }>('SELECT slug FROM organizations WHERE id = $1', [orgId])
      ).rows[0].slug;
      mergedOrgs.add(orgId);
      names.org.set(o.key, into.name);
    } else {
      slug = entry.suggested_slug ?? entry.new_slug ?? o.slug;
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO organizations (slug, name, summary, created_at, archived_at, context_max_tokens)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [slug, o.name, o.summary, o.created_at, o.archived_at, o.context_max_tokens ?? null],
      );
      orgId = rows[0].id;
      names.org.set(o.key, o.name);
      if (slug !== o.slug)
        warn(`${o.name} is imported as "${slug}", so links to [[${o.slug}]] don't lead to it.`);
    }
    ids.orgs.set(o.key, orgId);
    entry.id = orgId;
    for (const old of [o.slug, ...o.aliases]) {
      if (old === slug) continue;
      if (newSlugs.has(old) || existingSlugs.has(old) || usedAliases.has(old)) {
        if (old !== o.slug)
          warn(`The old slug "${old}" of ${o.name} is already used here, so it is left out.`);
        continue;
      }
      // A merged organization also answers to the slug it had in the file.
      if (old === o.slug && entry.action === 'new') continue;
      usedAliases.add(old);
      await c.query('INSERT INTO slug_aliases (organization_id, old_slug) VALUES ($1, $2)', [
        orgId,
        old,
      ]);
    }
  }

  let groupRoles = 0;
  for (const p of file.people) {
    if (!newPeople.has(p.key)) continue;
    for (const m of p.memberships) {
      const org = m.organization ? ids.orgs.get(m.organization) : run.groupRoles ? null : undefined;
      if (org === undefined) {
        if (!m.organization) groupRoles++;
        continue;
      }
      await c.query(
        'INSERT INTO memberships (actor_id, organization_id, role) VALUES ($1, $2, $3)',
        [ids.people.get(p.key), org, m.role],
      );
    }
  }
  if (groupRoles)
    warn(`${groupRoles} roles in the group itself are left out; this group sets its own.`);
  for (const g of file.read_grants) {
    const reader = ids.orgs.get(g.reader);
    const target = ids.orgs.get(g.target);
    if (reader && target && reader !== target) {
      await c.query(
        'INSERT INTO org_read_grants (reader_org_id, target_org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [reader, target],
      );
    }
  }

  // ── projects and their repositories
  const remotes = new Map(
    (
      await c.query<{ remote_key: string; project_id: string }>(
        'SELECT remote_key, project_id FROM repositories',
      )
    ).rows.map((r) => [r.remote_key, r.project_id]),
  );
  for (const p of file.projects) {
    const orgId = ids.orgs.get(p.organization);
    if (!orgId) continue;
    const { rows: found } = await c.query<{
      id: string;
      name: string;
      summary: string;
      reviewed: boolean;
    }>(
      `SELECT id, name, summary, reviewed FROM projects
        WHERE organization_id = $1 AND (slug = $2 OR slug = ANY($3::text[]) OR id IN (SELECT project_id FROM slug_aliases WHERE old_slug = $2))
        ORDER BY slug = $2 DESC LIMIT 1`,
      [orgId, p.slug, p.aliases],
    );
    let projectId: string;
    if (found[0]) {
      projectId = found[0].id;
      merged.projects++;
      if (
        found[0].name !== p.name ||
        found[0].summary !== p.summary ||
        found[0].reviewed !== p.reviewed
      ) {
        if (updateMeta) {
          await c.query(
            'UPDATE projects SET name = $2, summary = $3, reviewed = $4, updated_at = now() WHERE id = $1',
            [projectId, p.name, p.summary, p.reviewed],
          );
        } else metaKept++;
      }
    } else {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO projects (organization_id, slug, name, summary, reviewed, created_by, created_at, updated_at, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          orgId,
          p.slug,
          p.name,
          p.summary,
          p.reviewed,
          actor(p.created_by),
          p.created_at,
          p.updated_at,
          p.archived_at,
        ],
      );
      projectId = rows[0].id;
      counts.projects++;
    }
    ids.projects.set(p.key, projectId);
    kept.projects.add(projectId);
    for (const old of new Set(p.aliases)) {
      await c.query(
        `INSERT INTO slug_aliases (project_id, old_slug)
         SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = $3 AND slug = $2)
         ON CONFLICT DO NOTHING`,
        [projectId, old, orgId],
      );
    }
    for (const r of p.repositories) {
      const owner = remotes.get(r.remote_key);
      if (owner === projectId) {
        const { rows } = await c.query<{ id: string }>(
          'SELECT id FROM repositories WHERE remote_key = $1',
          [r.remote_key],
        );
        ids.repos.set(r.key, rows[0].id);
        continue;
      }
      if (owner) {
        warn(
          `The repository ${r.remote_url} is already registered in this group, so it is left out of ${p.name}.`,
        );
        continue;
      }
      const { rows } = await c.query<{ id: string }>(
        'INSERT INTO repositories (project_id, remote_key, remote_url, created_by, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [projectId, r.remote_key, r.remote_url, actor(r.created_by), r.created_at],
      );
      remotes.set(r.remote_key, projectId);
      ids.repos.set(r.key, rows[0].id);
      counts.repositories++;
    }
  }

  // ── API specs: matched by name and source within the project
  for (const s of file.api_specs) {
    const projectId = ids.projects.get(s.project);
    if (!projectId) continue;
    const { rows: found } = await c.query<{ id: string; content_hash: string }>(
      `SELECT id, content_hash FROM api_specs WHERE project_id = $1 AND name = $2
          AND source_url IS NOT DISTINCT FROM $3 AND filename IS NOT DISTINCT FROM $4 LIMIT 1`,
      [projectId, s.name, s.source_url, s.filename],
    );
    const values = [
      JSON.stringify(s.spec ?? null),
      s.source_format,
      s.spec_version,
      s.title,
      s.version,
      s.endpoint_count,
      s.schema_count,
      s.content_hash,
      s.fetched_at,
      s.fetch_error,
    ];
    if (found[0]) {
      merged.api_specs++;
      if (found[0].content_hash === s.content_hash) continue;
      if (!updateMeta) {
        metaKept++;
        continue;
      }
      await c.query(
        `UPDATE api_specs SET spec = $2::json, source_format = $3, spec_version = $4, title = $5, version = $6, endpoint_count = $7,
                schema_count = $8, content_hash = $9, fetched_at = $10, fetch_error = $11, updated_by = $12, updated_at = now()
          WHERE id = $1`,
        [found[0].id, ...values, run.actorId],
      );
      continue;
    }
    await c.query(
      `INSERT INTO api_specs (project_id, name, source_url, filename, spec, source_format, spec_version, title, version,
                              endpoint_count, schema_count, content_hash, fetched_at, fetch_error, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::json, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        projectId,
        s.name,
        s.source_url,
        s.filename,
        ...values,
        actor(s.created_by),
        actor(s.updated_by),
        s.created_at,
        s.updated_at,
      ],
    );
    counts.api_specs++;
  }

  // ── scopes: matched by slug or old slug at their level
  for (const s of file.scopes) {
    const orgId = orgOf(s.organization);
    if (orgId === undefined) continue;
    const projectId = id(ids.projects, s.project);
    if (s.project && !projectId) continue;
    const { rows: found } = await c.query<{
      id: string;
      name: string;
      description: string;
      path_globs: string[];
      stacks: string[];
    }>(
      `SELECT id, name, description, path_globs, stacks FROM scopes
        WHERE organization_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2
          AND (slug = $3 OR slug = ANY($4::text[]) OR id IN (SELECT scope_id FROM slug_aliases WHERE old_slug = $3))
        ORDER BY slug = $3 DESC LIMIT 1`,
      [orgId, projectId, s.slug, s.aliases],
    );
    let scopeId: string;
    if (found[0]) {
      const f = found[0];
      scopeId = f.id;
      merged.scopes++;
      const differs =
        f.name !== s.name ||
        f.description !== s.description ||
        f.path_globs.join('\n') !== s.path_globs.join('\n') ||
        f.stacks.join('\n') !== s.stacks.join('\n');
      if (differs && updateMeta) {
        await c.query(
          'UPDATE scopes SET name = $2, description = $3, path_globs = $4, stacks = $5, updated_at = now() WHERE id = $1',
          [scopeId, s.name, s.description, s.path_globs, s.stacks],
        );
      } else if (differs) metaKept++;
    } else {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO scopes (organization_id, project_id, slug, name, description, path_globs, stacks, position, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          orgId,
          projectId,
          s.slug,
          s.name,
          s.description,
          s.path_globs,
          s.stacks,
          s.position,
          s.created_at,
          s.updated_at,
        ],
      );
      scopeId = rows[0].id;
      counts.scopes++;
    }
    ids.scopes.set(s.key, scopeId);
    kept.scopes.add(scopeId);
    for (const old of new Set(s.aliases)) {
      await c.query(
        `INSERT INTO slug_aliases (scope_id, old_slug)
         SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM scopes WHERE organization_id IS NOT DISTINCT FROM $3
                                            AND project_id IS NOT DISTINCT FROM $4 AND slug = $2)
         ON CONFLICT DO NOTHING`,
        [scopeId, old, orgId, projectId],
      );
    }
    for (const r of s.repositories) {
      const repo = ids.repos.get(r);
      if (repo) {
        await c.query(
          'INSERT INTO scope_repositories (scope_id, repository_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [scopeId, repo],
        );
      }
    }
  }

  // ── documents and sections
  const insertSection = async (
    documentId: string,
    s: ExportSection,
    position: number,
    history: boolean,
  ) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sections (document_id, heading, body, mode, position, version, created_at, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        documentId,
        s.heading,
        s.body,
        s.mode,
        position,
        s.version,
        s.created_at,
        s.updated_at,
        actor(s.updated_by),
      ],
    );
    const sectionId = rows[0].id;
    ids.sections.set(s.key, sectionId);
    counts.sections++;
    await syncLinks(c, sectionId, s.body);
    // Without history, the current text is the only version.
    const versions =
      history && s.versions.length
        ? s.versions
        : [
            {
              version: s.version,
              heading: s.heading,
              body: s.body,
              mode: s.mode,
              actor: s.updated_by,
              note: 'Imported',
              created_at: s.updated_at,
            },
          ];
    for (const v of versions) {
      await c.query(
        `INSERT INTO section_versions (section_id, version, heading, body, mode, actor_id, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [sectionId, v.version, v.heading, v.body, v.mode, actor(v.actor), v.note, v.created_at],
      );
      counts.section_versions++;
    }
  };

  let outdated = 0;
  for (const d of file.documents) {
    const orgId = orgOf(d.organization);
    if (orgId === undefined) continue;
    const projectId = id(ids.projects, d.project);
    const scopeId = id(ids.scopes, d.scope);
    if ((d.project && !projectId) || (d.scope && !scopeId)) continue;
    const { rows: found } = await c.query<{
      id: string;
      kind: string;
      title: string;
      mode: EditMode;
    }>(
      `SELECT id, kind, title, mode FROM documents
        WHERE organization_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2
          AND scope_id IS NOT DISTINCT FROM $3 AND slug = $4`,
      [orgId, projectId, scopeId, d.slug],
    );
    if (!found[0]) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO documents (organization_id, project_id, scope_id, kind, slug, title, mode, position, created_at, updated_at, disabled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          orgId,
          projectId,
          scopeId,
          d.kind,
          d.slug,
          d.title,
          d.mode,
          d.position,
          d.created_at,
          d.updated_at,
          d.disabled_at ?? null,
        ],
      );
      ids.docs.set(d.key, rows[0].id);
      kept.docs.add(rows[0].id);
      counts.documents++;
      for (const s of d.sections) await insertSection(rows[0].id, s, s.position, true);
      continue;
    }

    const docId = found[0].id;
    ids.docs.set(d.key, docId);
    kept.docs.add(docId);
    merged.documents++;
    if (found[0].kind !== d.kind || found[0].title !== d.title || found[0].mode !== d.mode) {
      if (updateMeta) {
        await c.query(
          'UPDATE documents SET kind = $2, title = $3, mode = $4, updated_at = now() WHERE id = $1',
          [docId, d.kind, d.title, d.mode],
        );
      } else metaKept++;
    }
    const place = placeOf(d);
    const targets = (
      await c.query<{
        id: string;
        heading: string;
        body: string;
        mode: EditMode;
        version: number;
        position: number;
      }>(
        'SELECT id, heading, body, mode, version, position FROM sections WHERE document_id = $1 ORDER BY position',
        [docId],
      )
    ).rows;
    let next = Math.max(-1, ...targets.map((t) => t.position)) + 1;
    const used = new Set<string>();
    const inFile = new Map<string, number>();
    for (const s of d.sections)
      inFile.set(headingKey(s.heading), (inFile.get(headingKey(s.heading)) ?? 0) + 1);
    const change = (x: Omit<ImportChange, 'place'>) => report.changes.push({ place, ...x });
    const after = (s: ExportSection) => ({ heading: s.heading, body: s.body, mode: s.mode });

    for (const s of d.sections) {
      let t = targets.find((x) => x.id === s.key && !used.has(x.id));
      if (!t) {
        const candidates = targets.filter(
          (x) => !used.has(x.id) && headingKey(x.heading) === headingKey(s.heading),
        );
        if (
          candidates.length > 1 ||
          (candidates.length === 1 && (inFile.get(headingKey(s.heading)) ?? 0) > 1)
        ) {
          merged.conflicts++;
          change({
            key: s.key,
            target_id: null,
            status: 'conflict',
            action: 'skip',
            before: null,
            after: after(s),
            reason: `More than one section is called "${s.heading}", so it's unclear which one this is. Rename one and import again.`,
          });
          continue;
        }
        t = candidates.at(0);
      }
      if (!t) {
        await insertSection(docId, s, next++, true);
        change({
          key: s.key,
          target_id: null,
          status: 'new',
          action: 'add',
          reason: null,
          before: null,
          after: after(s),
        });
        continue;
      }
      used.add(t.id);
      ids.sections.set(s.key, t.id);
      merged.sections++;
      if (sameText(t, s) && t.mode === s.mode) {
        merged.unchanged++;
        continue;
      }
      const policy = policyOf(s.key);
      const base = {
        key: s.key,
        target_id: t.id,
        status: 'changed' as const,
        before: { heading: t.heading, body: t.body, mode: t.mode },
        after: after(s),
      };
      if (policy === 'keep') {
        merged.kept++;
        change({ ...base, action: 'keep', reason: null });
      } else if (policy === 'propose' && (t.mode === 'locked' || sameText(t, s))) {
        merged.kept++;
        change({
          ...base,
          action: 'skip',
          reason:
            t.mode === 'locked'
              ? 'The section is locked, so it can\'t get a proposal. Choose "The file wins" to change it.'
              : 'Only the edit mode differs, which a proposal can\'t change. Choose "The file wins" to change it.',
        });
      } else if (
        policy === 'propose' &&
        (
          await c.query(
            'SELECT 1 FROM proposals WHERE section_id = $1 AND status IN (\'pending\', \'changes_requested\') AND heading = $2 AND body = $3',
            [t.id, s.heading, s.body],
          )
        ).rowCount
      ) {
        merged.kept++;
        change({
          ...base,
          action: 'skip',
          reason: 'This change is already proposed and waiting for review.',
        });
      } else if (policy === 'propose') {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO proposals (kind, organization_id, project_id, scope_id, document_id, section_id, base_version,
                                  heading, body, rationale, context, created_by)
           VALUES ('edit_section', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [
            orgId,
            projectId,
            scopeId,
            docId,
            t.id,
            t.version,
            s.heading,
            s.body,
            run.label,
            JSON.stringify({
              import: { group: file.source.group.slug, exported_at: file.exported_at },
            }),
            run.actorId,
          ],
        );
        await c.query(
          'INSERT INTO proposal_revisions (proposal_id, revision, heading, body, note, actor_id) VALUES ($1, 1, $2, $3, $4, $5)',
          [rows[0].id, s.heading, s.body, run.label, run.actorId],
        );
        await c.query(
          'INSERT INTO proposal_events (proposal_id, kind, revision, note, actor_id) VALUES ($1, \'proposed\', 1, $2, $3)',
          [rows[0].id, run.label, run.actorId],
        );
        merged.proposed++;
        change({ ...base, action: 'propose', reason: null });
      } else {
        await c.query(
          'UPDATE sections SET heading = $2, body = $3, mode = $4, version = version + 1, updated_at = now(), updated_by = $5 WHERE id = $1',
          [t.id, s.heading, s.body, s.mode, run.actorId],
        );
        await c.query(
          `INSERT INTO section_versions (section_id, version, heading, body, mode, actor_id, note)
           SELECT id, version, heading, body, mode, $2, $3 FROM sections WHERE id = $1`,
          [t.id, run.actorId, run.label],
        );
        await syncLinks(c, t.id, s.body);
        const { rows } = await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM proposals WHERE section_id = $1 AND status IN (\'pending\', \'changes_requested\')',
          [t.id],
        );
        outdated += rows[0].n;
        merged.updated++;
        change({ ...base, action: 'file', reason: null });
      }
    }
    for (const t of targets.filter((x) => !used.has(x.id))) {
      const remove = !!run.opts.remove_missing;
      if (remove) {
        await c.query('DELETE FROM sections WHERE id = $1', [t.id]);
        merged.removed++;
      }
      change({
        key: null,
        target_id: t.id,
        status: 'only_in_target',
        action: remove ? 'remove' : 'keep',
        reason: null,
        before: { heading: t.heading, body: t.body, mode: t.mode },
        after: null,
      });
    }
  }
  if (outdated)
    warn(
      `${outdated} open proposals are on sections the file changed; their reviewers will see them as out of date.`,
    );
  if (metaKept)
    warn(
      `${metaKept} projects, scopes, documents or API specs have other names or settings in the file. They stay as they are here unless "The file wins".`,
    );

  // ── what merged organizations have that the file doesn't
  if (run.opts.remove_missing && mergedOrgs.size) {
    const orgIds = [...mergedOrgs];
    const docs = await c.query(
      'DELETE FROM documents WHERE organization_id = ANY($1::uuid[]) AND NOT (id = ANY($2::uuid[]))',
      [orgIds, [...kept.docs]],
    );
    const scopes = await c.query(
      'DELETE FROM scopes WHERE organization_id = ANY($1::uuid[]) AND NOT (id = ANY($2::uuid[]))',
      [orgIds, [...kept.scopes]],
    );
    const projects = await c.query(
      `UPDATE projects SET archived_at = now() WHERE organization_id = ANY($1::uuid[]) AND archived_at IS NULL
          AND NOT (id = ANY($2::uuid[]))`,
      [orgIds, [...kept.projects]],
    );
    merged.removed += (docs.rowCount ?? 0) + (scopes.rowCount ?? 0) + (projects.rowCount ?? 0);
    if (docs.rowCount || scopes.rowCount || projects.rowCount) {
      warn(
        `Not in the file, so removed: ${docs.rowCount} documents and ${scopes.rowCount} scopes; ${projects.rowCount} projects are archived.`,
      );
    }
  }

  // ── proposals, with their reviews
  let skippedGroup = 0;
  let orphaned = 0;
  for (const p of file.proposals) {
    const orgId = orgOf(p.organization);
    if (orgId === undefined) {
      if (!p.organization) skippedGroup++;
      continue;
    }
    // Merging a file back into where it came from: its proposals are already here.
    if (
      (
        await c.query(
          'SELECT 1 FROM proposals WHERE id::text = $1 AND organization_id IS NOT DISTINCT FROM $2',
          [p.key, orgId],
        )
      ).rowCount
    )
      continue;
    const doc = id(ids.docs, p.document);
    const section = id(ids.sections, p.section);
    if ((p.document && !doc) || (p.section && !section)) {
      orphaned++;
      continue;
    }
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO proposals (kind, status, organization_id, project_id, scope_id, document_id, section_id, result_section_id,
                              base_version, heading, body, rationale, context, revision, created_by, created_at, updated_at,
                              reviewed_by, reviewed_at, review_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
      [
        p.kind,
        p.status,
        orgId,
        id(ids.projects, p.project),
        id(ids.scopes, p.scope),
        doc,
        section,
        id(ids.sections, p.result_section),
        p.base_version,
        p.heading,
        p.body,
        p.rationale,
        JSON.stringify(p.context),
        p.revision,
        actor(p.created_by),
        p.created_at,
        p.updated_at,
        actor(p.reviewed_by),
        p.reviewed_at,
        p.review_note,
      ],
    );
    const proposalId = rows[0].id;
    counts.proposals++;
    for (const r of p.revisions) {
      await c.query(
        'INSERT INTO proposal_revisions (proposal_id, revision, heading, body, note, actor_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [proposalId, r.revision, r.heading, r.body, r.note, actor(r.actor), r.created_at],
      );
    }
    for (const e of p.events) {
      await c.query(
        'INSERT INTO proposal_events (proposal_id, kind, revision, note, actor_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [proposalId, e.kind, e.revision, e.note, actor(e.actor), e.created_at],
      );
    }
    for (const t of p.threads) {
      const { rows: thread } = await c.query<{ id: string }>(
        `INSERT INTO review_threads (proposal_id, revision, line_start, line_end, anchor, resolved_at, resolved_by, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          proposalId,
          t.revision,
          t.line_start,
          t.line_end,
          t.anchor,
          t.resolved_at,
          actor(t.resolved_by),
          actor(t.created_by),
          t.created_at,
        ],
      );
      for (const cm of t.comments) {
        await c.query(
          `INSERT INTO review_comments (thread_id, actor_id, body, suggestion, applied_at, applied_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            thread[0].id,
            actor(cm.actor),
            cm.body,
            cm.suggestion,
            cm.applied_at,
            actor(cm.applied_by),
            cm.created_at,
          ],
        );
      }
    }
  }

  // ── findings
  for (const f of file.findings) {
    const orgId = orgOf(f.organization);
    const projectId = id(ids.projects, f.project);
    if (!orgId || !projectId) continue;
    // Merging a file back into where it came from: its findings are already here.
    if (
      (
        await c.query('SELECT 1 FROM findings WHERE id::text = $1 AND organization_id = $2', [
          f.key,
          orgId,
        ])
      ).rowCount
    )
      continue;
    await c.query(
      `INSERT INTO findings (organization_id, project_id, scope_id, status, file, line_start, line_end, title, problem,
                             proposed_fix, commit_sha, remote, context, remind_after, solved_ref, created_by, created_at,
                             status_by, status_at, status_note, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        orgId,
        projectId,
        id(ids.scopes, f.scope),
        f.status,
        f.file,
        f.line_start,
        f.line_end,
        f.title,
        f.problem,
        f.proposed_fix,
        f.commit_sha,
        f.remote,
        JSON.stringify(f.context),
        f.remind_after,
        f.solved_ref,
        actor(f.created_by),
        f.created_at,
        actor(f.status_by),
        f.status_at,
        f.status_note,
        f.updated_at,
      ],
    );
    counts.findings++;
  }

  const gc = report.group_content;
  if (!run.groupContent && (gc.documents || gc.scopes || gc.proposals)) {
    const parts = [
      gc.documents && `${gc.documents} documents`,
      gc.scopes && `${gc.scopes} scopes`,
      skippedGroup && `${skippedGroup} proposals`,
    ];
    warn(
      `Group-wide content is left out (${parts.filter(Boolean).join(', ')}); this group keeps its own.`,
    );
  }
  if (orphaned)
    warn(`${orphaned} proposals are left out because the content they change isn't imported.`);

  await seedGroupDocs(c, run.actorId);
}
