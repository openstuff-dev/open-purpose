import type { Access } from '../auth.js';
import type { Db, Queryable } from '../db.js';
import { tx } from '../db.js';
import { AppError, badRequest, mapPgError, notFound } from '../errors.js';
import { normalizeTarget, rewriteLinks, type WikiLink } from '../domain/links.js';
import type { SlugRename, SlugRenameRef } from '@openpurpose/contracts';
import {
  aliasOwner,
  claimSlug,
  listAliases,
  recordRename,
  type Namespace,
  type SlugKind,
} from './aliases.js';
import { applySectionChange, getScope, loadSection } from './content.js';
import { linkResolver } from './graph.js';
import { getProject } from './projects.js';
import { OPEN_STATUSES } from './types.js';

/**
 * Renaming the slug of an organization, project or scope. The slug is how people
 * and agents refer to it: [[links]], .openpurpose.json, get_context's scopes. A
 * rename rewrites the links the renamer can edit, and keeps the old slug as an
 * alias so everything else keeps working.
 */
export type { SlugRename } from '@openpurpose/contracts';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface Target {
  kind: SlugKind;
  id: string;
  name: string;
  from: string;
  /** Every slug it answers to now: the current one and its aliases. */
  slugs: string[];
  ns: Namespace;
}

async function loadTarget(db: Queryable, a: Access, kind: SlugKind, id: string): Promise<Target> {
  const aliases = async (entityId: string) =>
    (await listAliases(db, kind, entityId)).map((x) => x.old_slug);
  if (kind === 'project') {
    const p = await getProject(db, a, id);
    a.requireEdit(p.organization_id);
    return {
      kind,
      id: p.id,
      name: p.name,
      from: p.slug,
      slugs: [p.slug, ...(await aliases(p.id))],
      ns: { organization_id: p.organization_id },
    };
  }
  if (kind === 'scope') {
    const s = await getScope(db, a, id);
    a.requireEdit(s.organization_id);
    return {
      kind,
      id: s.id,
      name: s.name,
      from: s.slug,
      slugs: [s.slug],
      ns: { organization_id: s.organization_id, project_id: s.project_id },
    };
  }
  a.requireAdmin(null);
  const o = a.org(id);
  if (!o) throw notFound('Organization');
  return { kind, id: o.id, name: o.name, from: o.slug, slugs: [o.slug, ...o.aliases], ns: {} };
}

/** The current holder of a slug in the namespace, other than the target itself. */
async function slugHolder(db: Queryable, t: Target, slug: string): Promise<string | null> {
  const { rows } = await db.query<{ name: string }>(
    {
      organization: 'SELECT name FROM organizations WHERE slug = $1 AND id <> $2',
      project: 'SELECT name FROM projects WHERE slug = $1 AND id <> $2 AND organization_id = $3',
      scope: `SELECT name FROM scopes WHERE slug = $1 AND id <> $2
              AND organization_id IS NOT DISTINCT FROM $3 AND project_id IS NOT DISTINCT FROM $4`,
    }[t.kind],
    t.kind === 'organization'
      ? [slug, t.id]
      : t.kind === 'project'
        ? [slug, t.id, t.ns.organization_id]
        : [slug, t.id, t.ns.organization_id ?? null, t.ns.project_id ?? null],
  );
  return rows[0]?.name ?? null;
}

/** Where a link is written, for resolving it the way the graph does. */
interface At {
  org: string | null;
  project: string | null;
  section?: string;
}
type Rewriter = (link: WikiLink, written: string, at: At) => string | null;

/** New targets for links that name the target by one of its slugs. Scopes are never linked. */
async function rewriterFor(
  db: Queryable,
  a: Access,
  t: Target,
  to: string,
): Promise<Rewriter | null> {
  if (t.kind === 'scope') return null;
  if (t.kind === 'organization') {
    return (link, written) => {
      const slash = written.indexOf('/');
      if (slash <= 0 || !t.slugs.includes(link.target.slice(0, link.target.indexOf('/'))))
        return null;
      // A current slug of another organization wins over our alias.
      if (a.orgBySlug(link.target.slice(0, link.target.indexOf('/')))?.id !== t.id) return null;
      return `${to}/${written.slice(slash + 1)}`;
    };
  }
  const resolve = await linkResolver(db, a);
  const orgId = t.ns.organization_id ?? null;
  const orgSlug = a.org(orgId)?.slug;
  const name = normalizeTarget(t.name);
  return (link, written, at) => {
    if (link.kind === 'term') return null;
    const slash = link.target.indexOf('/');
    const slug = slash > 0 ? link.target.slice(slash + 1) : link.target;
    // A link by name ([[Customer Portal]]) keeps working after the rename.
    if (!t.slugs.includes(slug) || slug === name) return null;
    const hit = resolve(link.kind, link.target, at.org, at.project, at.section);
    if (hit?.type !== 'project' || hit.row.id !== t.id) return null;
    if (slash > 0) return `${written.slice(0, written.indexOf('/'))}/${to}`;
    // From another organization, a bare slug could now find a different project.
    return at.org === orgId ? to : `${orgSlug}/${to}`;
  };
}

interface Found {
  ref: SlugRenameRef;
  at: At;
  editable: boolean;
}

async function findLinks(db: Queryable, a: Access, t: Target, rw: Rewriter): Promise<Found[]> {
  const project = t.kind === 'project';
  const { rows } = await db.query<{
    id: string;
    heading: string;
    body: string;
    document_id: string;
    document_title: string;
    organization_id: string | null;
    project_id: string | null;
    location: string | null;
  }>(
    `SELECT DISTINCT s.id, s.heading, s.body, d.id AS document_id, d.title AS document_title,
            d.organization_id, d.project_id, COALESCE(p.name, o.name) AS location
       FROM section_links l JOIN sections s ON s.id = l.section_id JOIN documents d ON d.id = s.document_id
       LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN organizations o ON o.id = d.organization_id
      WHERE (d.organization_id IS NULL OR d.organization_id = ANY($1::uuid[]))
        AND (l.target = ANY($2::text[]) OR l.target LIKE ANY($3::text[]))`,
    [
      a.readableOrgIds(),
      project ? t.slugs : [],
      t.slugs.map((s) => (project ? `%/${s}` : `${s}/%`)),
    ],
  );
  const out: Found[] = [];
  for (const r of rows) {
    const at: At = { org: r.organization_id, project: r.project_id, section: r.id };
    let links = 0;
    rewriteLinks(r.body, (l, w) => {
      const next = rw(l, w, at);
      if (next) links++;
      return next;
    });
    if (!links) continue;
    out.push({
      at,
      editable: a.canEdit(r.organization_id),
      ref: {
        section_id: r.id,
        heading: r.heading,
        document_id: r.document_id,
        document_title: r.document_title,
        location: r.location ?? a.group.name,
        links,
      },
    });
  }
  return out;
}

async function countOpenProposals(db: Queryable, a: Access, rw: Rewriter): Promise<number> {
  const { rows } = await db.query<{
    body: string;
    organization_id: string | null;
    project_id: string | null;
  }>(
    `SELECT body, organization_id, project_id FROM proposals
      WHERE status = ANY($1::proposal_status[]) AND (organization_id IS NULL OR organization_id = ANY($2::uuid[])) AND body LIKE '%[[%'`,
    [OPEN_STATUSES, a.readableOrgIds()],
  );
  return rows.filter((r) => {
    let hit = false as boolean;
    rewriteLinks(r.body, (l, w) => {
      if (rw(l, w, { org: r.organization_id, project: r.project_id })) hit = true;
      return null;
    });
    return hit;
  }).length;
}

async function countRepositories(db: Queryable, t: Target): Promise<number> {
  if (t.kind === 'scope') return 0;
  const { rows } = await db.query<{ n: number }>(
    t.kind === 'project'
      ? 'SELECT count(*)::int AS n FROM repositories WHERE project_id = $1'
      : 'SELECT count(*)::int AS n FROM repositories r JOIN projects p ON p.id = r.project_id WHERE p.organization_id = $1',
    [t.id],
  );
  return rows[0].n;
}

export interface RenameInput {
  slug: string;
  /** Update [[links]] the renamer can edit. Default true. */
  rewrite_links?: boolean;
  /** Take the slug even though it is another one's old slug (see claimSlug). */
  take_alias?: boolean;
  /** Only report what the rename would touch. */
  dry_run?: boolean;
}

export async function renameSlug(
  db: Db,
  a: Access,
  kind: SlugKind,
  id: string,
  input: RenameInput,
): Promise<SlugRename> {
  const to = input.slug.trim().toLowerCase();
  if (!SLUG_RE.test(to)) {
    throw badRequest(
      'Use lower-case letters, digits and hyphens, starting with a letter or digit (63 characters at most).',
    );
  }
  const t = await loadTarget(db, a, kind, id);
  if (to === t.from) throw badRequest(`The slug is already "${to}"`);
  const holder = await slugHolder(db, t, to);
  if (holder) throw new AppError('conflict', `"${to}" is already the slug of ${holder}`);

  const owner = await aliasOwner(db, kind, t.ns, to, t.id);
  const rw = await rewriterFor(db, a, t, to);
  const found = rw ? await findLinks(db, a, t, rw) : [];
  const rewriteLinksToo = input.rewrite_links ?? true;
  const result: SlugRename = {
    kind,
    from: t.from,
    to,
    applied: false,
    alias_of: owner && { id: owner.id, name: owner.name, slug: owner.slug },
    rewrite: found.filter((f) => f.editable).map((f) => f.ref),
    cannot_edit: found.filter((f) => !f.editable).map((f) => f.ref),
    repositories: await countRepositories(db, t),
    open_proposals: rw ? await countOpenProposals(db, a, rw) : 0,
  };
  if (input.dry_run) return result;

  const table = { organization: 'organizations', project: 'projects', scope: 'scopes' }[kind];
  try {
    await tx(db, async (c) => {
      await claimSlug(c, kind, t.ns, to, t.id, input.take_alias);
      await c.query(
        `UPDATE ${table} SET slug = $2${kind === 'organization' ? '' : ', updated_at = now()'} WHERE id = $1`,
        [t.id, to],
      );
      await recordRename(c, kind, t.id, t.from, to, a.actor.id);
      if (!rewriteLinksToo || !rw) return;
      for (const f of found.filter((x) => x.editable)) {
        const s = await loadSection(c, f.ref.section_id, { forUpdate: true });
        const body = rewriteLinks(s.body, (l, w) => rw(l, w, f.at));
        await applySectionChange(c, s, { body }, a.actor.id, `Renamed ${t.from} to ${to}`);
      }
    });
  } catch (err) {
    throw mapPgError(err);
  }
  return {
    ...result,
    applied: true,
    alias_of: input.take_alias ? result.alias_of : null,
    rewrite: rewriteLinksToo ? result.rewrite : [],
  };
}
