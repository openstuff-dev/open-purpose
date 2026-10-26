import type { Access } from '../auth.js';
import type { Queryable } from '../db.js';
import { slugify } from '../domain/remote.js';
import { normalizeTarget } from '../domain/links.js';
import type { Graph, GraphEdge, GraphNode, LinkRef, LinkResolution } from '@openpurpose/contracts';

/**
 * The link graph behind the map. Nodes: the group, its organizations, projects
 * and glossary terms. Edges: [[wikilinks]] between them, resolved at read time
 * so a link written before its target existed starts working once it does.
 *
 * Privacy: links are only taken from content the viewer can read. A link that
 * points into an organization the viewer can't read shows the target's name
 * only (restricted), never its content.
 */
export type { Graph, GraphEdge, GraphNode, LinkRef, LinkResolution, NodeType } from '@openpurpose/contracts';

export const GROUP_NODE = 'group';
export const orgNode = (id: string) => `org:${id}`;
export const projectNode = (id: string) => `project:${id}`;
export const termNode = (sectionId: string) => `term:${sectionId}`;

interface ProjectRow { id: string; organization_id: string; slug: string; name: string; summary: string; purpose: string | null; aliases: string[] }
interface TermRow { id: string; heading: string; body: string; organization_id: string | null; project_id: string | null; document_id: string }
interface LinkRow {
  section_id: string; heading: string; target_kind: 'project' | 'term' | 'any'; target: string;
  document_title: string; doc_kind: string; organization_id: string | null; project_id: string | null;
}

function firstLine(text: string, max = 160): string {
  const line = text.replace(/[_*`#>]/g, '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** Everything needed to resolve links in one group. */
class LinkIndex {
  private projectsByOrg = new Map<string, Map<string, ProjectRow>>();
  private termsByKey = new Map<string, TermRow[]>();

  constructor(
    private a: Access,
    readonly projects: ProjectRow[],
    readonly terms: TermRow[],
  ) {
    for (const p of projects) {
      if (!this.projectsByOrg.has(p.organization_id)) this.projectsByOrg.set(p.organization_id, new Map());
      const m = this.projectsByOrg.get(p.organization_id)!;
      m.set(p.slug, p);
      m.set(normalizeTarget(p.name), p);
    }
    // Old slugs, after every current slug and name so those win.
    for (const p of projects) {
      const m = this.projectsByOrg.get(p.organization_id)!;
      for (const old of p.aliases) if (!m.has(old)) m.set(old, p);
    }
    for (const t of terms) {
      const key = normalizeTarget(t.heading);
      this.termsByKey.set(key, [...(this.termsByKey.get(key) ?? []), t]);
    }
  }

  private projectIn(orgId: string, target: string): ProjectRow | undefined {
    const m = this.projectsByOrg.get(orgId);
    return m?.get(target) ?? m?.get(slugify(target));
  }

  /** Same organization first, then a unique match among readable organizations, then any organization. */
  private findProject(target: string, fromOrg: string | null): ProjectRow | undefined {
    if (fromOrg) {
      const own = this.projectIn(fromOrg, target);
      if (own) return own;
    }
    const hits = this.a.orgs.map((o) => this.projectIn(o.id, target)).filter((p): p is ProjectRow => !!p);
    const readable = hits.filter((p) => this.a.canRead(p.organization_id));
    if (readable.length === 1) return readable[0];
    if (readable.length === 0 && hits.length === 1) return hits[0];
    return undefined;
  }

  /** Same project's glossary, then the organization's, then the group's, then a unique match elsewhere. */
  private findTerm(target: string, fromOrg: string | null, fromProject: string | null, onlyOrg?: string, exclude?: string): TermRow | undefined {
    let c = (this.termsByKey.get(target) ?? []).filter((t) => t.id !== exclude);
    if (onlyOrg) c = c.filter((t) => t.organization_id === onlyOrg);
    return c.find((t) => fromProject && t.project_id === fromProject)
      ?? c.find((t) => fromOrg && t.organization_id === fromOrg && !t.project_id)
      ?? c.find((t) => t.organization_id === null)
      ?? (c.length === 1 ? c[0] : undefined);
  }

  /** `exclude`: the linking section itself, so a term that mentions its own name links to the broader definition. */
  resolve(kind: LinkRow['target_kind'], target: string, fromOrg: string | null, fromProject: string | null, exclude?: string):
    { type: 'project'; row: ProjectRow } | { type: 'term'; row: TermRow } | null {
    // "github/actions-runner" or "term:github/Pull request"
    const slash = target.indexOf('/');
    if (slash > 0) {
      const org = this.a.orgBySlug(target.slice(0, slash));
      if (org) {
        const rest = target.slice(slash + 1);
        if (kind !== 'term') {
          const p = this.projectIn(org.id, rest);
          if (p) return { type: 'project', row: p };
        }
        if (kind !== 'project') {
          const t = this.findTerm(rest, org.id, null, org.id, exclude);
          if (t) return { type: 'term', row: t };
        }
      }
    }
    if (kind !== 'term') {
      const p = this.findProject(target, fromOrg);
      if (p) return { type: 'project', row: p };
    }
    if (kind !== 'project') {
      const t = this.findTerm(target, fromOrg, fromProject, undefined, exclude);
      if (t) return { type: 'term', row: t };
    }
    return null;
  }
}

async function loadIndex(db: Queryable, a: Access, includeArchived: boolean): Promise<LinkIndex> {
  const { rows: projects } = await db.query<ProjectRow>(
      `SELECT p.id, p.organization_id, p.slug, p.name, p.summary,
              (SELECT s.body FROM documents d JOIN sections s ON s.document_id = d.id
                WHERE d.project_id = p.id AND d.scope_id IS NULL AND d.kind = 'purpose'
                ORDER BY d.position, s.position LIMIT 1) AS purpose,
              ARRAY(SELECT x.old_slug FROM slug_aliases x WHERE x.project_id = p.id) AS aliases
         FROM projects p WHERE $1 OR p.archived_at IS NULL`,
      [includeArchived],
  );
  const { rows: terms } = await db.query<TermRow>(
      `SELECT s.id, s.heading, s.body, d.organization_id, d.project_id, d.id AS document_id
         FROM sections s JOIN documents d ON d.id = s.document_id WHERE d.kind = 'glossary'`,
  );
  return new LinkIndex(a, projects, terms);
}

/** Resolve [[link]] targets with the same rules as the graph (archived projects included). */
export async function linkResolver(db: Queryable, a: Access): Promise<LinkIndex['resolve']> {
  const index = await loadIndex(db, a, true);
  return index.resolve.bind(index);
}

export async function buildGraph(
  db: Queryable, a: Access, opts: { includeMissing?: boolean; includeArchived?: boolean } = {},
): Promise<Graph> {
  const index = await loadIndex(db, a, opts.includeArchived ?? false);
  const { rows: links } = await db.query<LinkRow>(
    `SELECT l.section_id, s.heading, l.target_kind, l.target, d.title AS document_title, d.kind AS doc_kind,
            d.organization_id, d.project_id
       FROM section_links l JOIN sections s ON s.id = l.section_id JOIN documents d ON d.id = s.document_id
      WHERE d.organization_id IS NULL OR d.organization_id = ANY($1::uuid[])`,
    [a.readableOrgIds()],
  );

  const nodes = new Map<string, GraphNode>();
  const orgSlug = (id: string | null) => a.org(id)?.slug ?? null;
  nodes.set(GROUP_NODE, {
    id: GROUP_NODE, type: 'group', label: a.group.name, slug: null, summary: '',
    organization_id: null, organization_slug: null, project_id: null, restricted: false,
  });
  for (const o of a.orgs) {
    nodes.set(orgNode(o.id), {
      id: orgNode(o.id), type: 'organization', label: o.name, slug: o.slug, summary: '',
      organization_id: o.id, organization_slug: o.slug, project_id: null, restricted: !a.canRead(o.id),
    });
  }
  for (const p of index.projects) {
    const restricted = !a.canRead(p.organization_id);
    nodes.set(projectNode(p.id), {
      id: projectNode(p.id), type: 'project', label: p.name, slug: p.slug,
      summary: restricted ? '' : p.summary || firstLine(p.purpose ?? ''),
      organization_id: p.organization_id, organization_slug: orgSlug(p.organization_id), project_id: p.id, restricted,
    });
  }
  for (const t of index.terms) {
    const restricted = !a.canRead(t.organization_id);
    nodes.set(termNode(t.id), {
      id: termNode(t.id), type: 'term', label: t.heading, slug: null,
      summary: restricted ? '' : firstLine(t.body),
      organization_id: t.organization_id, organization_slug: orgSlug(t.organization_id), project_id: t.project_id, restricted,
    });
  }

  const edges = new Map<string, GraphEdge>();
  const addEdge = (source: string, target: string, kind: GraphEdge['kind'], ref?: LinkRef) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    const id = `${kind}|${source}|${target}`;
    const e = edges.get(id) ?? { id, source, target, kind, count: 0, refs: [] };
    if (ref) {
      if (!e.refs.some((r) => r.section_id === ref.section_id)) {
        e.refs.push(ref);
        e.count++;
      }
    } else {
      e.count = Math.max(e.count, 1);
    }
    edges.set(id, e);
  };

  // Who defines each term. Terms in unreadable organizations only appear when something readable links to them.
  for (const t of index.terms) {
    if (!a.canRead(t.organization_id)) continue;
    const owner = t.project_id ? projectNode(t.project_id) : t.organization_id ? orgNode(t.organization_id) : GROUP_NODE;
    addEdge(owner, termNode(t.id), 'defines');
  }

  for (const l of links) {
    const source = l.doc_kind === 'glossary' ? termNode(l.section_id)
      : l.project_id ? projectNode(l.project_id)
      : l.organization_id ? orgNode(l.organization_id) : GROUP_NODE;
    const location = l.project_id ? nodes.get(projectNode(l.project_id))?.label ?? ''
      : l.organization_id ? a.org(l.organization_id)?.name ?? '' : a.group.name;
    const ref: LinkRef = { section_id: l.section_id, heading: l.heading, document_title: l.document_title, location };
    const hit = index.resolve(l.target_kind, l.target, l.organization_id, l.project_id, l.section_id);
    let target: string | null = hit ? (hit.type === 'project' ? projectNode(hit.row.id) : termNode(hit.row.id)) : null;
    if (!target) {
      if (!opts.includeMissing) continue;
      target = `missing:${l.target_kind}:${l.target}`;
      if (!nodes.has(target)) {
        nodes.set(target, {
          id: target, type: 'missing', label: l.target, slug: null, summary: 'Linked, but not created yet',
          organization_id: null, organization_slug: null, project_id: null, restricted: false,
        });
      }
    }
    addEdge(source, target, 'link', ref);
  }

  // Drop nodes nobody can see a reason for: restricted things nothing readable links to, and empty org/group nodes.
  const used = new Set<string>();
  for (const e of edges.values()) {
    used.add(e.source);
    used.add(e.target);
  }
  const keep = [...nodes.values()].filter((n) => {
    if (n.type === 'project' && !n.restricted) return true;
    if (n.type === 'term' && !n.restricted) return true;
    return used.has(n.id);
  });
  return {
    nodes: keep,
    edges: [...edges.values()],
    organizations: a.orgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name, readable: a.canRead(o.id) })),
  };
}

/** Keep only nodes within `depth` hops (either direction) of `focus`. */
export function focusGraph(graph: Graph, focus: string, depth = 1): Graph {
  const adjacent = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (!adjacent.has(e.source)) adjacent.set(e.source, new Set());
    if (!adjacent.has(e.target)) adjacent.set(e.target, new Set());
    adjacent.get(e.source)!.add(e.target);
    adjacent.get(e.target)!.add(e.source);
  }
  const keep = new Set([focus]);
  let frontier = [focus];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of adjacent.get(n) ?? []) {
        if (!keep.has(m)) {
          keep.add(m);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

export function trimRefs(graph: Graph, max = 5): Graph {
  return { ...graph, edges: graph.edges.map((e) => ({ ...e, refs: e.refs.slice(0, max) })) };
}

export interface Related {
  node: GraphNode;
  /** "uses": this project links to it. "used_by": it links to this project. */
  direction: 'uses' | 'used_by';
  refs: LinkRef[];
}

/** Projects and terms connected to a project by links, in both directions. */
export async function relatedTo(db: Queryable, a: Access, projectId: string): Promise<Related[]> {
  const graph = await buildGraph(db, a);
  const self = projectNode(projectId);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Related[] = [];
  for (const e of graph.edges) {
    if (e.kind !== 'link') continue;
    const other = e.source === self ? byId.get(e.target) : e.target === self ? byId.get(e.source) : undefined;
    if (!other || other.type === 'group' || other.type === 'organization') continue;
    out.push({ node: other, direction: e.source === self ? 'uses' : 'used_by', refs: e.refs });
  }
  return out.sort((x, y) => x.direction.localeCompare(y.direction) || y.refs.length - x.refs.length);
}

/** Every readable section that links to a node (project or term). */
export async function backlinks(db: Queryable, a: Access, nodeId: string): Promise<Array<{ source: GraphNode; refs: LinkRef[] }>> {
  const graph = await buildGraph(db, a);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges
    .filter((e) => e.kind === 'link' && e.target === nodeId && byId.has(e.source))
    .map((e) => ({ source: byId.get(e.source)!, refs: e.refs }));
}

/** Resolve one [[link]] for navigation in the UI, with the same rules as the graph. */
export async function resolveLink(
  db: Queryable, a: Access, raw: string, from: { organizationId?: string | null; projectId?: string | null } = {},
): Promise<LinkResolution> {
  const index = await loadIndex(db, a, true);
  const prefixed = /^(project|term)\s*:\s*(.+)$/i.exec(raw.split('#')[0].trim());
  const kind = (prefixed ? prefixed[1].toLowerCase() : 'any') as LinkRow['target_kind'];
  const target = normalizeTarget(prefixed ? prefixed[2] : raw.split('#')[0]);
  let fromOrg = from.organizationId ?? null;
  if (!fromOrg && from.projectId) fromOrg = index.projects.find((p) => p.id === from.projectId)?.organization_id ?? null;
  const hit = index.resolve(kind, target, fromOrg, from.projectId ?? null);
  if (!hit) return { type: 'missing', target };
  if (hit.type === 'project') {
    return { type: 'project', id: hit.row.id, slug: hit.row.slug, name: hit.row.name,
      organization_slug: a.org(hit.row.organization_id)?.slug ?? null, restricted: !a.canRead(hit.row.organization_id) };
  }
  return { type: 'term', section_id: hit.row.id, document_id: hit.row.document_id, heading: hit.row.heading,
    restricted: !a.canRead(hit.row.organization_id) };
}
