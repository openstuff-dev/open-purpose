import { describe, expect, it } from 'vitest';
import { Access, type Actor, type Membership, type OrgRef } from '../src/auth.js';
import type { Queryable } from '../src/db.js';
import {
  GROUP_NODE, backlinks, buildGraph, focusGraph, orgNode, projectNode, relatedTo, resolveLink, termNode, trimRefs,
  type Graph, type GraphEdge, type GraphNode, type LinkRef,
} from '../src/service/graph.js';

// ───────────────────────────── fixtures ─────────────────────────────
//
// One group, three organizations:
//   platform  – the viewer is an editor here
//   payments  – readable through a read grant from platform
//   secret    – not readable at all
// Unit tests run without Postgres: a fake Queryable answers the three queries graph.ts makes.

const ORG_A = 'org-platform';
const ORG_B = 'org-payments';
const ORG_C = 'org-secret';

const orgs: OrgRef[] = [
  { id: ORG_A, slug: 'platform', name: 'Platform', archived_at: null },
  { id: ORG_B, slug: 'payments', name: 'Payments', archived_at: null },
  { id: ORG_C, slug: 'secret', name: 'Secret', archived_at: null },
];

const actor: Actor = { id: 'actor-1', name: 'Anders', kind: 'human', is_superadmin: false };
const memberships: Membership[] = [{ group_id: 'g1', organization_id: ORG_A, role: 'editor' }];
const grants = new Map([[ORG_A, new Set([ORG_B])]]);
const access = new Access(actor, { id: 'g1', slug: 'acme', name: 'Acme Group' }, orgs, memberships, grants, ORG_A);

interface ProjectFixture { id: string; organization_id: string; slug: string; name: string; summary: string; purpose: string | null; archived?: boolean }
interface TermFixture { id: string; heading: string; body: string; organization_id: string | null; project_id: string | null; document_id: string }
interface LinkFixture {
  section_id: string; heading: string; target_kind: 'project' | 'term' | 'any'; target: string;
  document_title: string; doc_kind: string; organization_id: string | null; project_id: string | null;
}

const projects: ProjectFixture[] = [
  { id: 'p-portal', organization_id: ORG_A, slug: 'portal-frontend', name: 'Portal Frontend', summary: 'Customer portal', purpose: null },
  { id: 'p-auth-a', organization_id: ORG_A, slug: 'auth-service', name: 'Auth Service', summary: '', purpose: '## Why\n\n**Signs** people in.\nMore text.' },
  { id: 'p-gateway', organization_id: ORG_B, slug: 'payment-gateway', name: 'Payment Gateway', summary: 'Takes money', purpose: null },
  { id: 'p-billing-b', organization_id: ORG_B, slug: 'billing', name: 'Billing', summary: 'Invoices', purpose: null },
  { id: 'p-shared-a', organization_id: ORG_A, slug: 'shared', name: 'Shared', summary: 'A copy', purpose: null },
  { id: 'p-shared-b', organization_id: ORG_B, slug: 'shared', name: 'Shared', summary: 'B copy', purpose: null },
  { id: 'p-ledger', organization_id: ORG_C, slug: 'ledger', name: 'Ledger', summary: 'Top secret summary', purpose: null },
  { id: 'p-auth-c', organization_id: ORG_C, slug: 'auth-service', name: 'Auth Service', summary: 'Secret auth', purpose: null },
  { id: 'p-billing-c', organization_id: ORG_C, slug: 'billing', name: 'Billing', summary: 'Secret billing', purpose: null },
  { id: 'p-old', organization_id: ORG_A, slug: 'old-thing', name: 'Old Thing', summary: 'Archived', purpose: null, archived: true },
];

const terms: TermFixture[] = [
  { id: 't-tenant-group', heading: 'Tenant', body: 'A customer of the group.', organization_id: null, project_id: null, document_id: 'd-gloss-group' },
  { id: 't-tenant-a', heading: 'Tenant', body: 'In Platform, a tenant is [[tenant]] plus a region.', organization_id: ORG_A, project_id: null, document_id: 'd-gloss-a' },
  { id: 't-tenant-portal', heading: 'Tenant', body: 'In the portal, a logged-in company.', organization_id: ORG_A, project_id: 'p-portal', document_id: 'd-gloss-portal' },
  { id: 't-secret', heading: 'Settlement', body: 'Classified.', organization_id: ORG_C, project_id: null, document_id: 'd-gloss-c' },
];

const link = (section_id: string, target: string, from: { org?: string | null; project?: string | null; kind?: string; target_kind?: LinkFixture['target_kind'] } = {}): LinkFixture => ({
  section_id, heading: `Heading ${section_id}`, target_kind: from.target_kind ?? 'any', target,
  document_title: `Doc ${section_id}`, doc_kind: from.kind ?? 'overview',
  organization_id: from.org ?? null, project_id: from.project ?? null,
});

function fakeDb(links: LinkFixture[], data = { projects, terms }): Queryable {
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM section_links')) {
      // Mirrors the WHERE clause: group-wide content, or content in a readable organization.
      const readable = params[0] as string[];
      return { rows: links.filter((l) => l.organization_id === null || readable.includes(l.organization_id)) };
    }
    if (sql.includes('FROM projects p')) {
      const includeArchived = params[0] as boolean;
      return { rows: data.projects.filter((p) => includeArchived || !p.archived).map(({ archived: _a, ...row }) => row) };
    }
    if (sql.includes("d.kind = 'glossary'")) return { rows: data.terms };
    throw new Error(`unexpected query: ${sql}`);
  };
  return { query } as unknown as Queryable;
}

const edge = (g: Graph, source: string, target: string, kind: GraphEdge['kind'] = 'link') =>
  g.edges.find((e) => e.source === source && e.target === target && e.kind === kind);
const node = (g: Graph, id: string) => g.nodes.find((n) => n.id === id);

// Small hand-built graphs for the pure helpers.
const n = (id: string): GraphNode => ({
  id, type: 'project', label: id, slug: id, summary: '', organization_id: null, organization_slug: null, project_id: id, restricted: false,
});
const ref = (i: number): LinkRef => ({ section_id: `s${i}`, heading: `h${i}`, document_title: 'doc', location: 'loc' });
const e = (source: string, target: string, refs: LinkRef[] = [ref(0)]): GraphEdge => ({
  id: `link|${source}|${target}`, source, target, kind: 'link', count: refs.length, refs,
});
const graphOf = (ids: string[], edges: GraphEdge[]): Graph => ({ nodes: ids.map(n), edges, organizations: [] });
const ids = (g: Graph) => g.nodes.map((x) => x.id).sort();

// ───────────────────────────── focusGraph ─────────────────────────────

describe('focusGraph', () => {
  // a → b → c → d, plus e → b, and an unconnected f
  const chain = graphOf(['a', 'b', 'c', 'd', 'e', 'f'], [e('a', 'b'), e('b', 'c'), e('c', 'd'), e('e', 'b')]);

  it('keeps direct neighbours in both directions at depth 1', () => {
    const g = focusGraph(chain, 'b');
    expect(ids(g)).toEqual(['a', 'b', 'c', 'e']);
    expect(g.edges.map((x) => x.id).sort()).toEqual(['link|a|b', 'link|b|c', 'link|e|b']);
  });

  it('defaults to depth 1', () => {
    expect(ids(focusGraph(chain, 'a'))).toEqual(['a', 'b']);
  });

  it('widens one hop per depth level', () => {
    expect(ids(focusGraph(chain, 'a', 2))).toEqual(['a', 'b', 'c', 'e']);
    expect(ids(focusGraph(chain, 'a', 3))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('never includes nodes that are not connected to the focus', () => {
    expect(ids(focusGraph(chain, 'a', 50))).not.toContain('f');
  });

  it('keeps only the focus at depth 0', () => {
    const g = focusGraph(chain, 'b', 0);
    expect(ids(g)).toEqual(['b']);
    expect(g.edges).toEqual([]);
  });

  it('terminates on cycles and keeps every edge inside the cycle', () => {
    const cycle = graphOf(['x', 'y', 'z'], [e('x', 'y'), e('y', 'z'), e('z', 'x'), e('y', 'x')]);
    const g = focusGraph(cycle, 'x', 1000);
    expect(ids(g)).toEqual(['x', 'y', 'z']);
    expect(g.edges).toHaveLength(4);
  });

  it('drops edges whose other end is outside the focus area', () => {
    const g = focusGraph(chain, 'd', 1);
    expect(ids(g)).toEqual(['c', 'd']);
    expect(g.edges.map((x) => x.id)).toEqual(['link|c|d']);
  });

  it('returns an empty graph for a focus that is not in it', () => {
    const g = focusGraph(chain, 'nope', 3);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it('keeps organizations and does not mutate the input', () => {
    const input = { ...chain, organizations: [{ id: 'o', slug: 'o', name: 'O', readable: true }] };
    const before = JSON.stringify(input);
    const g = focusGraph(input, 'b');
    expect(g.organizations).toEqual(input.organizations);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ───────────────────────────── trimRefs ─────────────────────────────

describe('trimRefs', () => {
  const many = Array.from({ length: 8 }, (_, i) => ref(i));
  const g = graphOf(['a', 'b', 'c'], [e('a', 'b', many), e('b', 'c', [ref(0), ref(1)])]);

  it('caps refs at 5 by default and keeps the first ones', () => {
    const t = trimRefs(g);
    expect(t.edges[0].refs.map((r) => r.section_id)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(t.edges[1].refs).toHaveLength(2);
  });

  it('honours a custom limit and leaves count as the full total', () => {
    const t = trimRefs(g, 1);
    expect(t.edges.map((x) => x.refs.length)).toEqual([1, 1]);
    expect(t.edges[0].count).toBe(8);
  });

  it('does not mutate the input', () => {
    trimRefs(g, 1);
    expect(g.edges[0].refs).toHaveLength(8);
  });
});

// ───────────────────────────── buildGraph ─────────────────────────────

describe('buildGraph: link resolution', () => {
  it('prefers a project in the linking organization over a same-named one elsewhere', async () => {
    const g = await buildGraph(fakeDb([link('s1', 'auth-service', { org: ORG_A, project: 'p-portal' })]), access);
    expect(edge(g, projectNode('p-portal'), projectNode('p-auth-a'))).toBeDefined();
    expect(edge(g, projectNode('p-portal'), projectNode('p-auth-c'))).toBeUndefined();
  });

  it('prefers the linking organization even when the other copy is readable too', async () => {
    // "shared" exists in platform and payments, both readable: only the linking org decides.
    const g = await buildGraph(fakeDb([
      link('s1', 'shared', { org: ORG_A, project: 'p-portal' }),
      link('s2', 'shared', { org: ORG_B, project: 'p-gateway' }),
    ]), access);
    expect(edge(g, projectNode('p-portal'), projectNode('p-shared-a'))).toBeDefined();
    expect(edge(g, projectNode('p-gateway'), projectNode('p-shared-b'))).toBeDefined();
  });

  it('matches projects by name as well as slug', async () => {
    const g = await buildGraph(fakeDb([link('s1', 'portal frontend', { org: ORG_A, project: 'p-auth-a' })]), access);
    expect(edge(g, projectNode('p-auth-a'), projectNode('p-portal'))).toBeDefined();
  });

  it('picks the only readable match when the name exists in several organizations', async () => {
    // "billing" exists in payments (readable) and secret (not readable).
    const g = await buildGraph(fakeDb([link('s1', 'billing')]), access);
    expect(edge(g, GROUP_NODE, projectNode('p-billing-b'))).toBeDefined();
    expect(node(g, projectNode('p-billing-c'))).toBeUndefined();
  });

  it('leaves an ambiguous link unresolved, and shows it as missing only when asked', async () => {
    // "shared" exists in two readable organizations, linked from group-wide content.
    const links = [link('s1', 'shared')];
    const plain = await buildGraph(fakeDb(links), access);
    expect(plain.edges.filter((x) => x.kind === 'link')).toEqual([]);

    const withMissing = await buildGraph(fakeDb(links), access, { includeMissing: true });
    const missing = node(withMissing, 'missing:any:shared');
    expect(missing).toMatchObject({ type: 'missing', label: 'shared', restricted: false });
    expect(edge(withMissing, GROUP_NODE, 'missing:any:shared')).toBeDefined();
  });

  it('adds one missing node per target, however many sections link to it', async () => {
    const g = await buildGraph(fakeDb([
      link('s1', 'nowhere', { org: ORG_A, project: 'p-portal' }),
      link('s2', 'nowhere', { org: ORG_A, project: 'p-auth-a' }),
    ]), access, { includeMissing: true });
    expect(g.nodes.filter((x) => x.type === 'missing')).toHaveLength(1);
    expect(g.edges.filter((x) => x.target === 'missing:any:nowhere')).toHaveLength(2);
  });

  it('resolves org-qualified targets like "payments/payment-gateway"', async () => {
    const g = await buildGraph(fakeDb([link('s1', 'payments/payment-gateway', { org: ORG_A, project: 'p-portal' })]), access);
    expect(edge(g, projectNode('p-portal'), projectNode('p-gateway'))).toBeDefined();
  });

  it('respects the target kind: a term: link never resolves to a project', async () => {
    const g = await buildGraph(fakeDb([link('s1', 'auth-service', { org: ORG_A, project: 'p-portal', target_kind: 'term' })]), access);
    expect(g.edges.filter((x) => x.kind === 'link')).toEqual([]);
  });
});

describe('buildGraph: glossary terms', () => {
  it('resolves a term to the most local definition: project, then organization, then group', async () => {
    const g = await buildGraph(fakeDb([
      link('s-portal', 'tenant', { org: ORG_A, project: 'p-portal' }),
      link('s-auth', 'tenant', { org: ORG_A, project: 'p-auth-a' }),
      link('s-pay', 'tenant', { org: ORG_B, project: 'p-gateway' }),
    ]), access);
    expect(edge(g, projectNode('p-portal'), termNode('t-tenant-portal'))).toBeDefined();
    expect(edge(g, projectNode('p-auth-a'), termNode('t-tenant-a'))).toBeDefined();
    expect(edge(g, projectNode('p-gateway'), termNode('t-tenant-group'))).toBeDefined();
  });

  it('links a term that mentions its own name to the broader definition, not to itself', async () => {
    const g = await buildGraph(fakeDb([link('t-tenant-a', 'tenant', { org: ORG_A, kind: 'glossary' })]), access);
    expect(edge(g, termNode('t-tenant-a'), termNode('t-tenant-group'))).toBeDefined();
    expect(g.edges.some((x) => x.source === x.target)).toBe(false);
  });

  it('adds "defines" edges from the owner of each readable term', async () => {
    const g = await buildGraph(fakeDb([]), access);
    expect(edge(g, projectNode('p-portal'), termNode('t-tenant-portal'), 'defines')).toBeDefined();
    expect(edge(g, orgNode(ORG_A), termNode('t-tenant-a'), 'defines')).toBeDefined();
    expect(edge(g, GROUP_NODE, termNode('t-tenant-group'), 'defines')).toBeDefined();
  });
});

describe('buildGraph: edges', () => {
  it('ignores links from a project to itself', async () => {
    const g = await buildGraph(fakeDb([link('s1', 'portal-frontend', { org: ORG_A, project: 'p-portal' })]), access);
    expect(g.edges.filter((x) => x.kind === 'link')).toEqual([]);
  });

  it('counts each linking section once and merges sections into one edge', async () => {
    const g = await buildGraph(fakeDb([
      link('s1', 'auth-service', { org: ORG_A, project: 'p-portal' }),
      link('s1', 'auth service', { org: ORG_A, project: 'p-portal' }), // same section, written differently
      link('s2', 'auth-service', { org: ORG_A, project: 'p-portal' }),
    ]), access);
    const x = edge(g, projectNode('p-portal'), projectNode('p-auth-a'))!;
    expect(x.count).toBe(2);
    expect(x.refs.map((r) => r.section_id)).toEqual(['s1', 's2']);
    expect(x.refs[0]).toMatchObject({ heading: 'Heading s1', document_title: 'Doc s1', location: 'Portal Frontend' });
  });

  it('uses the organization or group as the source of org-level and group-level documents', async () => {
    const g = await buildGraph(fakeDb([
      link('s1', 'auth-service', { org: ORG_A }),
      link('s2', 'payment-gateway'),
    ]), access);
    expect(edge(g, orgNode(ORG_A), projectNode('p-auth-a'))?.refs[0].location).toBe('Platform');
    expect(edge(g, GROUP_NODE, projectNode('p-gateway'))?.refs[0].location).toBe('Acme Group');
  });
});

describe('buildGraph: privacy and pruning', () => {
  it('shows a linked project in an unreadable organization by name only', async () => {
    const g = await buildGraph(fakeDb([link('s1', 'ledger', { org: ORG_A, project: 'p-portal' })]), access);
    expect(node(g, projectNode('p-ledger'))).toMatchObject({ label: 'Ledger', restricted: true, summary: '' });
    expect(edge(g, projectNode('p-portal'), projectNode('p-ledger'))).toBeDefined();
  });

  it('drops restricted projects and terms nothing readable links to', async () => {
    const g = await buildGraph(fakeDb([]), access);
    expect(node(g, projectNode('p-auth-c'))).toBeUndefined();
    expect(node(g, termNode('t-secret'))).toBeUndefined();
    expect(g.edges.some((x) => x.target === termNode('t-secret'))).toBe(false);
  });

  it('never uses links written inside an unreadable organization', async () => {
    const g = await buildGraph(fakeDb([link('s-secret', 'portal-frontend', { org: ORG_C, project: 'p-ledger' })]), access);
    expect(g.edges.filter((x) => x.kind === 'link')).toEqual([]);
    expect(node(g, projectNode('p-ledger'))).toBeUndefined();
  });

  it('keeps readable projects and terms even without links, and drops unused org and group nodes', async () => {
    const g = await buildGraph(fakeDb([]), access, {});
    expect(node(g, projectNode('p-gateway'))).toBeDefined();
    expect(node(g, orgNode(ORG_B))).toBeUndefined(); // payments defines no terms
    expect(node(g, orgNode(ORG_A))).toBeDefined(); // platform defines one
  });

  it('reports readability for every organization', async () => {
    const g = await buildGraph(fakeDb([]), access);
    expect(g.organizations.map((o) => [o.slug, o.readable])).toEqual([['platform', true], ['payments', true], ['secret', false]]);
  });
});

describe('buildGraph: summaries and archived projects', () => {
  it('uses the summary, else the first line of the purpose without markdown', async () => {
    const g = await buildGraph(fakeDb([]), access);
    expect(node(g, projectNode('p-portal'))?.summary).toBe('Customer portal');
    expect(node(g, projectNode('p-auth-a'))?.summary).toBe('Why');
  });

  it('truncates long summaries to 160 characters', async () => {
    const long = { ...projects[0], id: 'p-long', slug: 'long', name: 'Long', summary: '', purpose: 'x'.repeat(300) };
    const g = await buildGraph(fakeDb([], { projects: [long], terms: [] }), access);
    const s = node(g, projectNode('p-long'))!.summary;
    expect(s).toHaveLength(160);
    expect(s.endsWith('…')).toBe(true);
  });

  it('leaves archived projects out unless asked', async () => {
    expect(node(await buildGraph(fakeDb([]), access), projectNode('p-old'))).toBeUndefined();
    expect(node(await buildGraph(fakeDb([]), access, { includeArchived: true }), projectNode('p-old'))).toBeDefined();
  });
});

// ───────────────────────────── relatedTo / backlinks ─────────────────────────────

describe('relatedTo and backlinks', () => {
  const links = [
    link('s1', 'auth-service', { org: ORG_A, project: 'p-portal' }),
    link('s2', 'auth-service', { org: ORG_A, project: 'p-portal' }),
    link('s3', 'tenant', { org: ORG_A, project: 'p-portal' }),
    link('s4', 'portal-frontend', { org: ORG_B, project: 'p-gateway' }),
    link('s5', 'portal-frontend', { org: ORG_A }), // org-level document: not a "related project"
  ];

  it('lists what a project uses and what uses it, uses first, most-referenced first', async () => {
    const r = await relatedTo(fakeDb(links), access, 'p-portal');
    expect(r.map((x) => [x.direction, x.node.id])).toEqual([
      ['used_by', projectNode('p-gateway')],
      ['uses', projectNode('p-auth-a')],
      ['uses', termNode('t-tenant-portal')],
    ]);
    expect(r.find((x) => x.node.id === projectNode('p-auth-a'))?.refs).toHaveLength(2);
  });

  it('does not count "defines" edges as relations', async () => {
    const r = await relatedTo(fakeDb([]), access, 'p-portal');
    expect(r).toEqual([]);
  });

  it('returns every source linking to a node, including org-level documents', async () => {
    const b = await backlinks(fakeDb(links), access, projectNode('p-portal'));
    expect(b.map((x) => x.source.id).sort()).toEqual([orgNode(ORG_A), projectNode('p-gateway')].sort());
  });
});

// ───────────────────────────── resolveLink ─────────────────────────────

describe('resolveLink', () => {
  const db = fakeDb([]);

  it('resolves a project with its organization slug', async () => {
    expect(await resolveLink(db, access, 'Payment Gateway')).toEqual({
      type: 'project', id: 'p-gateway', slug: 'payment-gateway', name: 'Payment Gateway', organization_slug: 'payments', restricted: false,
    });
  });

  it('uses the linking project to pick the local definition', async () => {
    const r = await resolveLink(db, access, 'Tenant', { projectId: 'p-portal' });
    expect(r).toMatchObject({ type: 'term', section_id: 't-tenant-portal', document_id: 'd-gloss-portal' });
  });

  it('derives the organization from the project when none is given', async () => {
    expect(await resolveLink(db, access, 'auth-service', { projectId: 'p-portal' })).toMatchObject({ id: 'p-auth-a' });
  });

  it('honours project: and term: prefixes and ignores #anchors', async () => {
    expect(await resolveLink(db, access, 'term: Tenant#usage')).toMatchObject({ type: 'term', section_id: 't-tenant-group' });
    expect(await resolveLink(db, access, 'project:Tenant')).toEqual({ type: 'missing', target: 'tenant' });
  });

  it('includes archived projects so old links still navigate', async () => {
    expect(await resolveLink(db, access, 'old-thing')).toMatchObject({ type: 'project', id: 'p-old' });
  });

  it('marks targets in unreadable organizations as restricted', async () => {
    expect(await resolveLink(db, access, 'ledger')).toMatchObject({ type: 'project', id: 'p-ledger', restricted: true });
    expect(await resolveLink(db, access, 'Settlement')).toMatchObject({ type: 'term', section_id: 't-secret', restricted: true });
  });

  it('returns the normalized target when nothing matches', async () => {
    expect(await resolveLink(db, access, '  No   Such  Thing ')).toEqual({ type: 'missing', target: 'no such thing' });
  });
});
