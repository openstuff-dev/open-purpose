import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, withScope, type Pool } from '../src/db.js';
import { bootstrap } from '../src/service/admin.js';
import { createSession, issueAuthCode } from '../src/service/signin.js';
import { hashToken } from '../src/auth.js';
import { createServer } from 'node:http';
import { BILLING_SWAGGER_YAML, ORDER_API } from '../src/demo-specs.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://openpurpose:openpurpose@localhost:5432/openpurpose_test';
const ADMIN = 'chr_test_admin_token_0123456789';

let pool: Pool;
let app: FastifyInstance;
let base: string;

interface Who { token: string; group?: string; org?: string; agent?: boolean }
const root: Who = { token: ADMIN };

async function api<T = any>(
  method: string,
  path: string,
  body?: unknown,
  who: Who = root,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${who.token}`,
      ...(who.group ? { 'x-openpurpose-group': who.group } : {}),
      ...(who.org ? { 'x-openpurpose-org': who.org } : {}),
      ...(who.agent ? { 'x-openpurpose-agent-view': '1' } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

async function mcp(token: string) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      text: (r.content as { text: string }[]).map((c) => c.text).join('\n'),
      isError: !!r.isError,
    };
  };
  return { client, call };
}

const FRONTEND_PKG = JSON.stringify({ dependencies: { '@angular/core': '^20.0.0' } });
const API_CSPROJ = '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>';
const HTTPS_REMOTE = 'https://acme@dev.azure.com/acme/Platform/_git/customer-portal';
const SSH_REMOTE = 'git@ssh.dev.azure.com:v3/acme/Platform/customer-portal';

async function resetSchema() {
  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();
  // Dropping the schema erases everything, so only ever do it to a test database.
  const { rows } = await owner.query<{ name: string }>('SELECT current_database() AS name');
  const name = rows.at(0)?.name ?? '';
  if (!name.endsWith('_test')) {
    await owner.end();
    throw new Error(`Refusing to wipe "${name}": TEST_DATABASE_URL must name a *_test database`);
  }
  await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await owner.end();
}

beforeAll(async () => {
  await resetSchema();
  const config = { ...loadConfig({}), databaseUrl: DATABASE_URL, webDir: '/nonexistent' };
  await migrate(DATABASE_URL, config.migrationsDir);
  pool = createPool(DATABASE_URL);
  await bootstrap(pool, { groupName: 'Acme Group', orgName: 'Acme Logistics', token: ADMIN });
  process.env.LOG_LEVEL = 'warn';
  app = await buildApp(pool, config);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  // Unset when beforeAll failed early.
  await (app as FastifyInstance | undefined)?.close();
  await (pool as Pool | undefined)?.end();
});

describe('OpenPurpose with groups and organizations', () => {
  const t: Record<string, string> = {}; // tokens
  const o: Record<string, string> = {}; // organization ids
  let projectId: string;
  let frontendScopeId: string;

  it('rejects requests without a valid token', async () => {
    expect((await api('GET', '/me', undefined, { token: 'nope' })).status).toBe(401);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('bootstraps a group, an organization and a server admin', async () => {
    const me = await api('GET', '/me');
    expect(me.data.actor.is_superadmin).toBe(true);
    expect(me.data.group.name).toBe('Acme Group');
    expect(me.data.group.can_admin).toBe(true);
    expect(me.data.organizations.map((x: any) => x.name)).toEqual(['Acme Logistics']);
    o.logistics = me.data.organizations[0].id;
    // One organization: the group stays invisible and has no documents yet.
    expect((await api('GET', '/documents?organization_id=group')).data).toEqual([]);
    const { client, call } = await mcp(ADMIN);
    const ctx = (await call('get_context', {})).text;
    expect(ctx).not.toContain('- Group:');
    expect(ctx).toContain('general rules come first (organization)');
    await client.close();
    expect(
      (await api('GET', `/documents?organization_id=${o.logistics}`)).data.map((d: any) => d.kind),
    ).toEqual(['purpose', 'business_logic', 'guidelines']);
  });

  it('creates a second organization, people and agents per organization', async () => {
    const pay = await api('POST', '/organizations', { name: 'Acme Payments', slug: 'payments' });
    expect(pay.status).toBe(201);
    o.payments = pay.data.id;
    expect(
      (await api('GET', '/documents?organization_id=group')).data.map((d: any) => d.kind),
    ).toEqual(['purpose', 'guidelines']);
    await api('PATCH', `/organizations/${o.logistics}`, { slug: 'logistics' });
    const mk = async (body: object) => (await api('POST', '/members', body)).data.token as string;
    t.jonas = await mk({ name: 'Agent Jonas', kind: 'agent', organization_id: o.logistics });
    t.lars = await mk({ name: 'Agent Lars', kind: 'agent', organization_id: o.payments });
    t.ida = await mk({ name: 'Ida', kind: 'human', organization_id: o.payments, role: 'admin' });
    t.anders = await mk({
      name: 'Anders',
      kind: 'human',
      organization_id: o.logistics,
      role: 'viewer',
    });
    t.groupEditor = await mk({
      name: 'Grete',
      kind: 'human',
      organization_id: null,
      role: 'editor',
    });
    expect((await api('POST', '/members', { name: 'x', kind: 'agent' })).status).toBe(400);
    // Organization admins manage their own organization only.
    expect(
      (
        await api(
          'POST',
          '/members',
          { name: 'Payments bot', kind: 'agent', organization_id: o.payments },
          { token: t.ida },
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await api(
          'POST',
          '/members',
          { name: 'Sneaky', kind: 'agent', organization_id: o.logistics },
          { token: t.ida },
        )
      ).status,
    ).toBe(403);
    expect((await api('POST', '/organizations', { name: 'Nope' }, { token: t.ida })).status).toBe(
      403,
    );
    const members = await api('GET', '/members', undefined, { token: t.ida });
    expect(members.data.map((m: any) => m.name).sort()).toEqual([
      'Agent Lars',
      'Ida',
      'Payments bot',
    ]);
  });

  it('creates a project with scopes at every level', async () => {
    const p = await api('POST', '/projects', {
      organization_id: o.logistics,
      name: 'Customer Portal',
      purpose:
        'Self-service portal. Uses [[billing-service]] for invoices, [[term:Order]] data and charges via [[payments/payment-gateway]].',
      remote_url: HTTPS_REMOTE,
    });
    expect(p.status).toBe(201);
    projectId = p.data.id;
    frontendScopeId = (
      await api('POST', '/scopes', {
        project_id: projectId,
        name: 'Frontend',
        path_globs: ['frontend/**'],
      })
    ).data.id;
    await api('POST', '/scopes', {
      project_id: projectId,
      name: 'Backend',
      path_globs: ['backend/**'],
    });
    const ng = await api('POST', '/scopes', {
      organization_id: o.logistics,
      name: 'Angular apps',
      slug: 'angular',
      stacks: ['angular'],
    });
    expect(ng.data.organization_id).toBe(o.logistics);
    const dotnet = await api('POST', '/scopes', {
      name: '.NET services',
      slug: 'dotnet',
      stacks: ['dotnet'],
    });
    expect(dotnet.data.organization_id).toBeNull();
    const dotnetDoc = await api('POST', '/documents', {
      scope_id: dotnet.data.id,
      kind: 'guidelines',
      title: '.NET conventions',
    });
    expect(dotnetDoc.data.organization_id).toBeNull();
    await api('POST', `/documents/${dotnetDoc.data.id}/sections`, {
      heading: 'Target .NET 10',
      body: 'Nullable on.',
      mode: 'locked',
    });
    // Payments has a project too, linking back.
    const gw = await api(
      'POST',
      '/projects',
      {
        name: 'Payment Gateway',
        slug: 'payment-gateway',
        purpose: 'Charges cards for [[logistics/customer-portal]]. Secret fraud rules live here.',
      },
      { token: t.ida },
    );
    expect(gw.status).toBe(201);
    expect(gw.data.organization_id).toBe(o.payments);
    expect(
      (
        await api(
          'POST',
          '/projects',
          { organization_id: o.logistics, name: 'Nope' },
          { token: t.ida },
        )
      ).status,
    ).toBe(403);
  });

  it('layers group, organization, project and scope context for an agent', async () => {
    const { client, call } = await mcp(t.jonas);
    const fe = await call('get_context', {
      remote_url: SSH_REMOTE,
      path: 'frontend/src/app/editor.ts',
      manifests: [{ path: 'frontend/package.json', content: FRONTEND_PKG }],
    });
    expect(fe.isError).toBe(false);
    expect(fe.text).toContain('- Group: **Acme Group**');
    expect(fe.text).toContain('- Organization: **Acme Logistics**');
    expect(fe.text).toContain('(`logistics/customer-portal`, found via git remote)');
    expect(fe.text).toContain('Acme Logistics › Angular apps (stack "angular")');
    expect(fe.text).toContain('Customer Portal › Frontend (path "frontend/**")');
    const order = ['## Acme Group', '## Acme Logistics', '## Customer Portal'].map((h) =>
      fe.text.indexOf(h),
    );
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
    expect(fe.text).toContain(
      'It will be filed under **Acme Logistics › Customer Portal › Frontend**',
    );

    const be = await call('get_context', {
      remote_url: SSH_REMOTE,
      path: 'backend/Api/Orders.cs',
      manifests: [{ path: 'backend/Api/Api.csproj', content: API_CSPROJ }],
    });
    expect(be.text).toContain('Acme Group › .NET services (stack "dotnet")');
    expect(be.text).toContain('Target .NET 10');
    await client.close();
  });

  it('files a learning under the frontend only', async () => {
    const { client, call } = await mcp(t.jonas);
    const r = await call('propose_learning', {
      heading: 'Every user action must be undoable',
      body: 'Use the CommandStack.',
      rationale: 'Corrected by Jonas.',
      remote_url: HTTPS_REMOTE,
      path: 'frontend/src/app/toolbar.ts',
    });
    expect(r.text).toContain(
      'Learning proposed for **Acme Logistics › Customer Portal › Frontend**',
    );
    const inbox = await api('GET', '/proposals?status=pending');
    const learning = inbox.data.find(
      (p: any) => p.heading === 'Every user action must be undoable',
    );
    expect(learning.scope_id).toBe(frontendScopeId);
    expect(learning.organization_id).toBe(o.logistics);
    // Payments' admin can neither see nor approve Logistics proposals.
    expect(
      (await api('GET', '/proposals?status=pending', undefined, { token: t.ida })).data.some(
        (p: any) => p.id === learning.id,
      ),
    ).toBe(false);
    expect(
      (await api('POST', `/proposals/${learning.id}/approve`, {}, { token: t.ida })).status,
    ).toBe(403);
    expect(
      (await api('GET', `/proposals/${learning.id}`, undefined, { token: t.ida })).status,
    ).toBe(404);
    expect((await api('POST', `/proposals/${learning.id}/approve`, {})).status).toBe(200);
    const detail = await api('GET', `/proposals/${learning.id}`);
    expect(detail.data).toMatchObject({
      status: 'approved',
      created_by_kind: 'agent',
      reviewed_by_name: 'Admin',
      scope_name: 'Frontend',
      project_name: 'Customer Portal',
    });
    expect(detail.data.result_document_id).toBeTruthy();
    expect(detail.data.context.path).toBe('frontend/src/app/toolbar.ts');
    const counts = await api('GET', '/proposals/counts');
    expect(counts.data.approved).toBeGreaterThanOrEqual(1);

    const fe = await call('get_context', { remote_url: SSH_REMOTE, path: 'frontend/x.ts' });
    expect(fe.text).toContain('Every user action must be undoable');
    const be = await call('get_context', { remote_url: SSH_REMOTE, path: 'backend/x.cs' });
    expect(be.text).not.toContain('Every user action must be undoable');
    await client.close();
  });

  it('binds scopes to repositories of a project', async () => {
    const API_REMOTE = 'https://dev.azure.com/acme/Platform/_git/customer-portal-api';
    const apiRepo = (
      await api('POST', `/projects/${projectId}/repositories`, { remote_url: API_REMOTE })
    ).data;
    const dotnetApi = await api('POST', '/scopes', {
      project_id: projectId,
      name: '.NET API',
      repository_ids: [apiRepo.id],
    });
    expect(dotnetApi.status).toBe(201);
    expect(dotnetApi.data.repository_ids).toEqual([apiRepo.id]);
    const doc = await api('POST', '/documents', {
      scope_id: dotnetApi.data.id,
      kind: 'guidelines',
      title: 'API conventions',
    });
    await api('POST', `/documents/${doc.data.id}/sections`, {
      heading: 'Use minimal APIs',
      body: 'No controllers.',
      mode: 'propose',
    });

    expect(
      (
        await api('POST', '/scopes', {
          project_id: projectId,
          name: 'Bad',
          repository_ids: ['00000000-0000-0000-0000-000000000000'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api('POST', '/scopes', {
          organization_id: o.logistics,
          name: 'Org bad',
          repository_ids: [apiRepo.id],
        })
      ).status,
    ).toBe(400);

    const { client, call } = await mcp(t.jonas);
    const inApi = await call('get_context', { remote_url: API_REMOTE, path: 'src/Program.cs' });
    expect(inApi.text).toContain(
      'Customer Portal › .NET API (repository "azure:acme/platform/customer-portal-api")',
    );
    expect(inApi.text).toContain('Use minimal APIs');
    expect(inApi.text).not.toContain('Repository scopes left out');
    // The whole repository is covered, and a learning made in it lands in the bound scope.
    const learning = await call('propose_learning', {
      heading: 'Return problem details',
      body: 'RFC 9457.',
      rationale: 'Corrected.',
      remote_url: API_REMOTE,
      path: 'src/Endpoints/Orders.cs',
    });
    expect(learning.text).toContain('Customer Portal › .NET API');

    const inPortal = await call('get_context', { remote_url: SSH_REMOTE, path: 'src/Program.cs' });
    expect(inPortal.text).not.toContain('Use minimal APIs');
    const noRemote = await call('get_context', {
      project: 'logistics/customer-portal',
      path: 'src/Program.cs',
    });
    expect(noRemote.text).toContain('Repository scopes left out: ".NET API"');
    expect((await call('list_scopes', { project: 'logistics/customer-portal' })).text).toContain(
      'azure:acme/platform/customer-portal-api',
    );

    const unbound = await api('PATCH', `/scopes/${dotnetApi.data.id}`, { repository_ids: [] });
    expect(unbound.data.repository_ids).toEqual([]);
    expect(
      (await call('get_context', { remote_url: API_REMOTE, path: 'src/Program.cs' })).text,
    ).not.toContain('Use minimal APIs');
    await api('DELETE', `/scopes/${dotnetApi.data.id}`);
    await client.close();
  });

  it('lets agents suggest scopes that a person creates by approving', async () => {
    const { client, call } = await mcp(t.jonas);
    const r = await call('create_scope', {
      name: 'Lint package',
      description: 'The shared ESLint config.',
      paths: ['packages/lint/**'],
      stacks: ['ESLint'],
      reason: 'Its rules kept landing at the project level.',
      remote_url: HTTPS_REMOTE,
    });
    expect(r.text).toContain('Scope `lint-package` proposed for **Customer Portal**');
    const p = (await api('GET', '/proposals?status=pending')).data.find(
      (x: any) => x.kind === 'new_scope' && x.heading === 'Lint package',
    );
    expect(p).toMatchObject({
      project_id: projectId,
      body: 'The shared ESLint config.',
      scope_spec: { slug: 'lint-package', path_globs: ['packages/lint/**'], stacks: ['eslint'] },
    });
    expect((await call('get_review', { proposal_id: p.id })).text).toContain(
      '- Paths: packages/lint/**',
    );
    // Nothing exists until a person approves it.
    const before = await call('get_context', { remote_url: HTTPS_REMOTE, path: 'packages/lint/x.js' });
    expect(before.text).not.toContain('Lint package');

    const ok = await api('POST', `/proposals/${p.id}/approve`, { body: 'Shared ESLint config.' });
    expect(ok.status).toBe(200);
    const done = (await api('GET', `/proposals/${p.id}`)).data;
    expect(done).toMatchObject({ status: 'approved', result_scope_slug: 'lint-package' });
    const scope = (await api('GET', `/scopes/${done.result_scope_id}`)).data;
    expect(scope).toMatchObject({
      project_id: projectId,
      name: 'Lint package',
      description: 'Shared ESLint config.',
      path_globs: ['packages/lint/**'],
    });
    const after = await call('get_context', { remote_url: HTTPS_REMOTE, path: 'packages/lint/x.js' });
    expect(after.text).toContain('Customer Portal › Lint package');

    const again = await call('create_scope', {
      name: 'Lint package',
      description: 'Again.',
      reason: 'Forgot.',
      remote_url: HTTPS_REMOTE,
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('already is a scope "lint-package"');
    await client.close();

    // An editor's token creates it right away.
    const admin = await mcp(ADMIN);
    const direct = await admin.call('create_scope', {
      name: 'Scripts',
      description: 'Build scripts.',
      paths: ['scripts/**'],
      reason: 'Own conventions.',
      remote_url: HTTPS_REMOTE,
    });
    expect(direct.text).toContain('Created scope `scripts` in **Customer Portal**');
    await admin.client.close();
    for (const s of (await api('GET', `/scopes?project_id=${projectId}`)).data)
      if (s.slug === 'lint-package' || s.slug === 'scripts') await api('DELETE', `/scopes/${s.id}`);
  });

  it('promotes a learning from one organization to the whole group', async () => {
    const lars = await mcp(t.lars);
    const r = await lars.call('propose_learning', {
      heading: 'Use Result<T> for expected failures',
      body: 'No exceptions for validation.',
      rationale: 'Ida said so.',
      level: 'organization',
    });
    expect(r.text).toContain('Learning proposed for **Acme Payments**');
    await lars.client.close();
    const p = (
      await api('GET', '/proposals?status=pending', undefined, { token: t.ida })
    ).data.find((x: any) => x.heading.startsWith('Use Result'));
    expect(p.can_review).toBe(true);
    // Ida runs Payments but not the group, so she can't promote it.
    const denied = await api(
      'POST',
      `/proposals/${p.id}/approve`,
      { target: { organization_id: null } },
      { token: t.ida },
    );
    expect(denied.status).toBe(403);
    const ok = await api(
      'POST',
      `/proposals/${p.id}/approve`,
      { target: { organization_id: null } },
      { token: t.groupEditor },
    );
    expect(ok.status).toBe(200);
    expect(ok.data.proposal.organization_id).toBeNull();

    const jonas = await mcp(t.jonas);
    const ctx = await jonas.call('get_context', { remote_url: SSH_REMOTE });
    expect(ctx.text).toContain('Use Result<T> for expected failures');
    await jonas.client.close();
  });

  it('keeps organizations private unless read access is granted', async () => {
    const { client, call } = await mcp(t.jonas);
    const denied = await call('get_context', { project: 'payments/payment-gateway' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("don't have access to the Acme Payments organization");
    const hits = await api('GET', '/search?q=fraud', undefined, { token: t.anders });
    expect(hits.data).toEqual([]);
    expect(
      (await api('GET', `/projects?organization_id=${o.payments}`, undefined, { token: t.anders }))
        .status,
    ).toBe(403);

    // The link from Logistics to Payments shows the name only.
    const related = await call('get_related', { project: 'customer-portal' });
    expect(related.text).toContain('Payment Gateway (`payments/payment-gateway`)');
    expect(related.text).toContain("which you can't read");
    expect(related.text).not.toContain('Secret fraud rules');
    const graph = await api('GET', '/graph', undefined, { token: t.anders });
    const gw = graph.data.nodes.find((n: any) => n.label === 'Payment Gateway');
    expect(gw.restricted).toBe(true);
    expect(gw.summary).toBe('');
    // Payments → Logistics links are invisible to Logistics: they live in content Logistics can't
    // read.
    expect(graph.data.edges.some((e: any) => e.source === gw.id)).toBe(false);

    // Grant Payments read access to Logistics.
    expect(
      (
        await api(
          'PUT',
          `/organizations/${o.logistics}/readers/${o.payments}`,
          { allowed: true },
          { token: t.ida },
        )
      ).status,
    ).toBe(403);
    expect(
      (await api('PUT', `/organizations/${o.logistics}/readers/${o.payments}`, { allowed: true }))
        .status,
    ).toBe(200);
    const lars = await mcp(t.lars);
    const ctx = await lars.call('get_context', { project: 'logistics/customer-portal' });
    expect(ctx.isError).toBe(false);
    expect(ctx.text).toContain('Self-service portal');
    // Reading is not writing.
    const sid = /\[s:([0-9a-f]{8}) · propose\]/.exec(
      ctx.text.slice(ctx.text.indexOf('## Customer Portal')),
    )![1];
    const write = await lars.call('update_section', { section_id: sid, body: 'x', reason: 'y' });
    expect(write.isError).toBe(true);
    // ...and Logistics still can't read Payments.
    expect((await call('get_context', { project: 'payments/payment-gateway' })).isError).toBe(true);
    await lars.client.close();
    await client.close();
  });

  it('shows people exactly what an agent reads in agent mode, read-only', async () => {
    const asLogisticsAgent: Who = { token: ADMIN, org: o.logistics, agent: true };
    const me = await api('GET', '/me', undefined, asLogisticsAgent);
    expect(me.status).toBe(200);
    expect(me.data.agent_view.organization_id).toBe(o.logistics);
    expect(me.data.agent_view.readable_organization_ids).toEqual([o.logistics]);
    expect(me.data.agent_view.switchable_organization_ids).toEqual(
      expect.arrayContaining([o.logistics, o.payments]),
    );
    expect(me.data.group.can_edit).toBe(false);
    // The server admin reads Payments, but a Logistics agent doesn't.
    expect(
      (await api('GET', `/projects?organization_id=${o.payments}`, undefined, root)).status,
    ).toBe(200);
    expect(
      (await api('GET', `/projects?organization_id=${o.payments}`, undefined, asLogisticsAgent))
        .status,
    ).toBe(403);
    const list = await api(
      'GET',
      `/projects?organization_id=${o.logistics}`,
      undefined,
      asLogisticsAgent,
    );
    const portal = list.data.find((p: any) => p.slug === 'customer-portal');
    const project = await api('GET', `/projects/${portal.id}`, undefined, asLogisticsAgent);
    expect(project.data.can_edit).toBe(false);
    // Nothing can be changed in agent mode.
    const write = await api(
      'POST',
      '/projects',
      { organization_id: o.logistics, name: 'Nope' },
      asLogisticsAgent,
    );
    expect(write.status).toBe(403);
    expect(write.data.message).toContain('read-only');
    // ...but reading the context agents get (a POST with a body) works, as the agent would get it.
    const ctx = await api(
      'POST',
      '/context',
      { project: 'logistics/customer-portal', path: 'frontend/src/app.ts' },
      asLogisticsAgent,
    );
    expect(ctx.status).toBe(200);
    // The agent console runs the real MCP read tools: the same text a Logistics agent gets.
    const args = { project: 'logistics/customer-portal', path: 'frontend/src/app.ts' };
    const tool = await api('POST', '/agent/tool', { name: 'get_context', args }, asLogisticsAgent);
    expect(tool.status).toBe(200);
    const { client, call } = await mcp(t.jonas);
    expect(tool.data).toEqual({ text: (await call('get_context', args)).text, is_error: false });
    await client.close();
    const hidden = await api(
      'POST',
      '/agent/tool',
      { name: 'get_context', args: { project: 'payments/payment-gateway' } },
      asLogisticsAgent,
    );
    expect(hidden.data.is_error).toBe(true);
    expect(
      (await api('POST', '/agent/tool', { name: 'update_section', args: {} }, asLogisticsAgent))
        .status,
    ).toBe(400);
    expect((await api('POST', '/agent/tool', { name: 'get_context', args }, root)).status).toBe(
      403,
    );
    // Payments was granted read access to Logistics, so its agents read both.
    const asPaymentsAgent = await api('GET', '/me', undefined, {
      token: t.ida,
      org: o.payments,
      agent: true,
    });
    expect(asPaymentsAgent.data.agent_view.readable_organization_ids).toEqual(
      expect.arrayContaining([o.logistics, o.payments]),
    );
    // A Logistics viewer can't look through the eyes of a Payments agent, and agent mode needs an
    // organization.
    const anders = await api('GET', '/me', undefined, {
      token: t.anders,
      org: o.payments,
      agent: true,
    });
    expect(anders.data.agent_view?.organization_id).not.toBe(o.payments);
    expect((await api('GET', '/me', undefined, { token: ADMIN, agent: true })).status).toBe(400);
  });

  it('shortens the most general sections when a context is over its budget', async () => {
    const args = { remote_url: SSH_REMOTE, path: 'frontend/src/app.ts' };
    const { client, call } = await mcp(t.jonas);
    const before = (await api('GET', '/me')).data.group.context_max_tokens;
    expect(before).toBeNull(); // opt-in
    expect((await api('PUT', '/group', { context_max_tokens: 999 })).status).toBe(400);
    expect(
      (await api('PUT', '/group', { context_max_tokens: 5000 }, { token: t.ida })).status,
    ).toBe(403);
    const baseline = (await api('POST', '/context', args)).data.budget;
    expect(baseline).toMatchObject({ max_tokens: null, shortened: 0 });

    const sentences = (n: number, what: string) =>
      Array.from({ length: n }, (_, i) => `Rule ${i} keeps the ${what} honest.`).join(' ');
    const groupDoc = (await api('GET', '/documents?organization_id=group')).data.find(
      (d: any) => d.kind === 'guidelines',
    );
    const general = (
      await api('POST', `/documents/${groupDoc.id}/sections`, {
        heading: 'Very long group rules',
        body: sentences(200, 'ledger'),
      })
    ).data.section;
    const feDoc = (
      await api('POST', '/documents', {
        scope_id: frontendScopeId,
        kind: 'guidelines',
        title: 'Frontend conventions',
      })
    ).data;
    const specific = (
      await api('POST', `/documents/${feDoc.id}/sections`, {
        heading: 'Long frontend rules',
        body: sentences(40, 'form'),
      })
    ).data.section;

    // Room for everything except the long group section.
    const budget = Math.max(1000, Math.ceil((baseline.tokens + 1000) / 100) * 100);
    expect((await api('PUT', '/group', { context_max_tokens: budget })).status).toBe(200);
    const ctx = (await call('get_context', args)).text;
    expect(ctx).toContain('shortened** to fit the context budget');
    expect(ctx).toContain('Rule 0 keeps the ledger honest. … _(');
    expect(ctx).toContain(`read_section s:${general.id.slice(0, 8)}`);
    expect(ctx).not.toContain('Rule 199 keeps the ledger honest.');
    expect(ctx).toContain('Rule 39 keeps the form honest.');
    // The budget plus review feedback, if any.
    expect(Math.ceil(ctx.length / 4)).toBeLessThanOrEqual(budget + 200);
    const rest = JSON.parse(
      (await call('read_section', { section_id: general.id.slice(0, 8) })).text,
    );
    expect(rest.body).toContain('Rule 199 keeps the ledger honest.');
    const rendered = (await api('POST', '/context', args)).data;
    expect(rendered.budget.max_tokens).toBe(budget);
    expect(rendered.budget.shortened).toBeGreaterThan(0);
    const flags = rendered.blocks
      .flatMap((b: any) => b.documents.flatMap((d: any) => d.sections))
      .filter((x: any) => [general.id, specific.id].includes(x.id))
      .map((x: any) => [x.heading, !!x.shortened]);
    expect(Object.fromEntries(flags)).toEqual({
      'Very long group rules': true,
      'Long frontend rules': false,
    });

    // With several organizations the group's budget applies, not the organization's.
    expect(
      (await api('PATCH', `/organizations/${o.logistics}`, { context_max_tokens: 999 })).status,
    ).toBe(400);
    expect(
      (await api('PATCH', `/organizations/${o.logistics}`, { context_max_tokens: null })).data
        .context_max_tokens,
    ).toBeNull();
    expect((await api('POST', '/context', args)).data.budget.max_tokens).toBe(budget);

    await api('PATCH', `/organizations/${o.logistics}`, { context_max_tokens: null });
    await api('PUT', '/group', { context_max_tokens: before });
    await api('DELETE', `/sections/${general.id}`);
    await api('DELETE', `/sections/${specific.id}`);
    await client.close();
  });

  it('ranks search hits near the searcher first, and narrows to the project or organization on request', async () => {
    const add = async (docId: string, heading: string) =>
      (
        await api('POST', `/documents/${docId}/sections`, {
          heading,
          body: 'Every quokka must be counted twice.',
        })
      ).data.section;
    const groupDoc = (await api('GET', '/documents?organization_id=group')).data.find(
      (d: any) => d.kind === 'guidelines',
    );
    const payDoc = (await api('GET', `/documents?organization_id=${o.payments}`)).data.find(
      (d: any) => d.kind === 'guidelines',
    );
    const orgDoc = (await api('GET', `/documents?organization_id=${o.logistics}`)).data.find(
      (d: any) => d.kind === 'guidelines',
    );
    const projDoc = (
      await api('POST', '/documents', {
        scope_id: frontendScopeId,
        kind: 'guidelines',
        title: 'Quokka handling',
      })
    ).data;
    const made = [
      await add(groupDoc.id, 'Group quokkas'),
      await add(payDoc.id, 'Payments quokkas'),
      await add(orgDoc.id, 'Logistics quokkas'),
      await add(projDoc.id, 'Portal quokkas'),
    ];
    const headings = async (query: string) =>
      (await api('GET', `/search?q=quokka${query}`)).data.map((h: any) => h.heading);

    const near = await headings(`&near_project_id=${projectId}`);
    expect(near.slice(0, 2)).toEqual(['Portal quokkas', 'Logistics quokkas']);
    expect([...near].sort()).toEqual([
      'Group quokkas',
      'Logistics quokkas',
      'Payments quokkas',
      'Portal quokkas',
    ]);
    expect((await headings(`&near_organization_id=${o.payments}`))[0]).toBe('Payments quokkas');
    expect(await headings(`&near_project_id=${projectId}&within=project`)).toEqual([
      'Portal quokkas',
    ]);
    expect(await headings(`&near_project_id=${projectId}&within=organization`)).toEqual([
      'Portal quokkas',
      'Logistics quokkas',
    ]);
    const hit = (
      await api('GET', `/search?q=quokka&near_organization_id=${o.payments}&within=organization`)
    ).data;
    expect(hit.map((h: any) => [h.heading, h.organization_id])).toEqual([
      ['Payments quokkas', o.payments],
    ]);
    expect((await api('GET', '/search?q=quokka&within=project')).status).toBe(400);
    expect((await api('GET', '/search?q=quokka&within=anywhere')).status).toBe(400);

    for (const x of made) await api('DELETE', `/sections/${x.id}`);
    await api('DELETE', `/documents/${projDoc.id}`);
  });

  it("uses the organization's budget while the group has one organization", async () => {
    const solo = await api('POST', '/groups', {
      name: 'Solo Shop',
      organization_name: 'Solo',
      admin_name: 'Sol',
    });
    expect(solo.status).toBe(201);
    const sol: Who = { token: solo.data.token };
    const me = (await api('GET', '/me', undefined, sol)).data;
    const org = me.organizations[0];
    expect(org.context_max_tokens).toBeNull();
    const doc = (
      await api('GET', `/documents?organization_id=${org.id}`, undefined, sol)
    ).data.find((d: any) => d.kind === 'guidelines');
    const long = Array.from({ length: 400 }, (_, i) => `Rule ${i} applies everywhere.`).join(' ');
    await api('POST', `/documents/${doc.id}/sections`, { heading: 'Everything', body: long }, sol);
    // The group's (hidden) budget doesn't count; the organization's does.
    await api('PUT', '/group', { context_max_tokens: 1000 }, sol);
    expect((await api('POST', '/context', {}, sol)).data.budget).toMatchObject({
      max_tokens: null,
      shortened: 0,
    });
    await api('PATCH', `/organizations/${org.id}`, { context_max_tokens: 1000 }, sol);
    const ctx = (await api('POST', '/context', {}, sol)).data;
    expect(ctx.budget).toMatchObject({ max_tokens: 1000, shortened: 1 });
    expect(ctx.markdown).toContain('Rule 0 applies everywhere. … _(');
    await api('PATCH', `/organizations/${org.id}`, { context_max_tokens: null }, sol);
    expect((await api('POST', '/context', {}, sol)).data.budget).toMatchObject({
      max_tokens: null,
      shortened: 0,
    });
  });

  it('gives agents the endpoints and DTOs of attached API specs', async () => {
    const portal = (await api('GET', `/projects?organization_id=${o.logistics}`)).data.find(
      (p: any) => p.slug === 'customer-portal',
    );
    const gateway = (await api('GET', `/projects?organization_id=${o.payments}`)).data.find(
      (p: any) => p.slug === 'payment-gateway',
    );
    // Editors attach specs; viewers and agents can't.
    expect(
      (
        await api(
          'POST',
          `/projects/${portal.id}/apis`,
          { content: JSON.stringify(ORDER_API) },
          { token: t.anders },
        )
      ).status,
    ).toBe(403);
    expect(
      (await api('POST', `/projects/${portal.id}/apis`, { content: 'openapi: 3.0.0\ninfo: {}' }))
        .status,
    ).toBe(400);
    const added = await api('POST', `/projects/${portal.id}/apis`, {
      content: JSON.stringify(ORDER_API),
      filename: 'order-api.json',
    });
    expect(added.status).toBe(201);
    expect(added.data).toMatchObject({
      name: 'Order Service API',
      version: '1.4.0',
      endpoint_count: 5,
      schema_count: 9,
      source_format: 'json',
    });
    const billing = await api(
      'POST',
      `/projects/${gateway.id}/apis`,
      { name: 'Billing', content: BILLING_SWAGGER_YAML, filename: 'billing.yaml' },
      { token: t.ida },
    );
    expect(billing.data).toMatchObject({
      name: 'Billing',
      spec_version: 'Swagger 2.0',
      source_format: 'yaml',
    });
    expect((await api('GET', `/projects/${portal.id}`)).data.apis).toHaveLength(1);

    // The agent sees the API in its context and reads it with get_api.
    const jonas = await mcp(t.jonas);
    const ctx = await jonas.call('get_context', { remote_url: SSH_REMOTE });
    expect(ctx.text).toContain('## APIs');
    expect(ctx.text).toContain(
      '- **Order Service API** 1.4.0 (OpenAPI 3.0.3, 5 endpoints, 9 schemas): `get_api project="logistics/customer-portal"`',
    );
    expect(ctx.text).not.toContain('Billing'); // Payments is private to Logistics
    const overview = await jonas.call('get_api', { remote_url: HTTPS_REMOTE });
    expect(overview.text).toContain(
      '- `POST /orders` — Create an order (body: CreateOrderRequest) → 201 OrderDto',
    );
    const endpoint = await jonas.call('get_api', {
      project: 'customer-portal',
      endpoint: 'post /orders',
    });
    expect(endpoint.text).toContain('interface CreateOrderRequest {');
    expect(endpoint.text).toContain('interface Money {');
    const schema = await jonas.call('get_api', {
      project: 'customer-portal',
      schema: 'OrderStatus',
    });
    expect(schema.text).toContain('type OrderStatus = ');
    expect((await jonas.call('get_api', { project: 'payments/payment-gateway' })).isError).toBe(
      true,
    );
    await jonas.client.close();

    // Payments reads Logistics, so its agent sees the portal's API as a related project's.
    const lars = await mcp(t.lars);
    const larsCtx = await lars.call('get_context', { project: 'payment-gateway' });
    expect(larsCtx.text).toContain(
      '- **Billing** 2.1 (Swagger 2.0, 2 endpoints, 2 schemas): `get_api project="payments/payment-gateway" api="Billing"`',
    );
    expect(larsCtx.text).toContain('Customer Portal: **Order Service API**');
    await lars.client.close();

    // The UI preview is the same text the agent gets.
    const preview = await api('GET', `/apis/${added.data.id}/text?endpoint=getOrder`);
    expect(preview.data.text).toContain('## `GET /orders/{orderId}`  (getOrder)');
    const detail = await api('GET', `/apis/${added.data.id}`);
    expect(detail.data.operations[0]).toMatchObject({ key: 'GET /orders', tags: ['Orders'] });
    expect(detail.data.can_edit).toBe(true);

    // From a URL: fetched on add and on refresh; a failed refresh keeps the last good version.
    let served: string | null = BILLING_SWAGGER_YAML;
    const http = createServer((req, res) => {
      if (served === null) {
        res.statusCode = 503;
        res.end('down');
        return;
      }
      res.setHeader('content-type', 'application/yaml');
      res.end(served);
    });
    await new Promise<void>((r) => {
      http.listen(0, '127.0.0.1', () => {
        r();
      });
    });
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/swagger.yaml`;
    const fromUrl = await api('POST', `/projects/${portal.id}/apis`, {
      name: 'Billing mirror',
      url,
    });
    expect(fromUrl.status).toBe(201);
    expect(fromUrl.data).toMatchObject({ source_url: url, endpoint_count: 2, fetch_error: null });
    expect(fromUrl.data.fetched_at).toBeTruthy();
    served = BILLING_SWAGGER_YAML.replace(
      'definitions:',
      `  /invoices/{invoiceNo}/pdf:
    get:
      operationId: getInvoicePdf
      responses:
        "200":
          description: PDF
definitions:`,
    );
    expect((await api('POST', `/apis/${fromUrl.data.id}/refresh`)).data.endpoint_count).toBe(3);
    served = null;
    const failed = await api('POST', `/apis/${fromUrl.data.id}/refresh`);
    expect(failed.status).toBe(200);
    expect(failed.data.fetch_error).toContain('503');
    expect(failed.data.endpoint_count).toBe(3);
    http.close();
    expect(
      (await api('POST', `/projects/${portal.id}/apis`, { url: 'file:///etc/passwd' })).status,
    ).toBe(400);
    // Two APIs on one project: agents pick one by name.
    const jonas2 = await mcp(t.jonas);
    expect((await jonas2.call('get_api', { project: 'customer-portal' })).text).toContain(
      'has 2 APIs',
    );
    expect(
      (
        await jonas2.call('get_api', {
          project: 'customer-portal',
          api: 'billing mirror',
          endpoint: 'getInvoicePdf',
        })
      ).text,
    ).toContain('getInvoicePdf');
    await jonas2.client.close();
    expect((await api('DELETE', `/apis/${fromUrl.data.id}`)).status).toBe(204);
  });

  it('resolves the same slug per organization', async () => {
    await api('POST', '/projects', { organization_id: o.logistics, name: 'API', slug: 'api' });
    await api('POST', '/projects', {
      organization_id: o.payments,
      name: 'API',
      slug: 'api',
      purpose: 'Payments API',
    });
    const lars = await mcp(t.lars);
    expect((await lars.call('get_context', { project: 'api' })).text).toContain('Payments API');
    await lars.client.close();
    // A group admin reads both, so a bare slug is ambiguous for them.
    const r = await api('POST', '/context', { project: 'api' });
    expect(r.status).toBe(400);
    expect(r.data.message).toContain('logistics/api');
  });

  it('enforces locked / propose / open per section, and agents only in their own organization', async () => {
    const orgDocs = await api('GET', `/documents?organization_id=${o.logistics}`);
    const locked = (await api('GET', `/documents/${orgDocs.data[0].id}`)).data.sections[0];
    const proposeSection = (await api('GET', `/documents/${orgDocs.data[1].id}`)).data.sections[0];
    const { client, call } = await mcp(t.jonas);
    expect(
      (await call('update_section', { section_id: locked.id.slice(0, 8), body: 'x', reason: 'x' }))
        .text,
    ).toContain('locked');
    expect(
      (
        await call('update_section', {
          section_id: proposeSection.id,
          body: 'Customer = paying account.',
          reason: 'x',
        })
      ).text,
    ).toContain('Proposed for review');
    await api('PATCH', `/sections/${proposeSection.id}`, { mode: 'open' });
    expect(
      (
        await call('update_section', {
          section_id: proposeSection.id,
          body: 'Customer = paying account.',
          reason: 'x',
        })
      ).text,
    ).toContain('Applied');
    expect(
      (await api('PATCH', `/sections/${proposeSection.id}`, { mode: 'locked' }, { token: t.jonas }))
        .status,
    ).toBe(403);
    // Group-wide content: agents may propose (mode decides), viewers may not.
    const groupGuidelines = (await api('GET', '/documents?organization_id=group')).data.find(
      (d: any) => d.kind === 'guidelines',
    );
    expect(
      (
        await call('add_section', {
          document_id: groupGuidelines.id,
          heading: 'Idea',
          body: 'x',
          reason: 'y',
        })
      ).text,
    ).toContain('Proposed');
    expect(
      (
        await api(
          'POST',
          `/documents/${groupGuidelines.id}/sections`,
          { heading: 'x' },
          { token: t.anders },
        )
      ).status,
    ).toBe(403);
    await client.close();
  });

  it('detects concurrent edits and restores versions', async () => {
    const docs = await api('GET', `/documents?organization_id=${o.logistics}`);
    const s = (await api('GET', `/documents/${docs.data[1].id}`)).data.sections[0];
    const stale = await api('PATCH', `/sections/${s.id}`, {
      body: 'x',
      expected_version: s.version - 1,
    });
    expect(stale.status).toBe(409);
    const r = await api('POST', `/sections/${s.id}/revert`, { version: 1 });
    expect(r.data.body).toContain('Define the terms');
  });

  it('links projects and terms across the group', async () => {
    await api('POST', '/projects', {
      organization_id: o.logistics,
      name: 'Billing Service',
      purpose: 'Charges through [[payments/payment-gateway]].',
    });
    const glossary = await api('POST', '/documents', { kind: 'glossary', title: 'Group glossary' });
    await api('POST', `/documents/${glossary.data.id}/sections`, {
      heading: 'Order',
      body: 'A confirmed purchase.',
    });
    const local = await api('POST', '/documents', {
      organization_id: o.payments,
      kind: 'glossary',
      title: 'Glossary',
    });
    await api('POST', `/documents/${local.data.id}/sections`, {
      heading: 'Order',
      body: 'In Payments: a charge request.',
    });

    const g = await api('GET', '/graph');
    const label = (id: string) => g.data.nodes.find((n: any) => n.id === id)?.label;
    const edges = g.data.edges
      .filter((e: any) => e.kind === 'link')
      .map((e: any) => `${label(e.source)} -> ${label(e.target)}`)
      .sort();
    expect(edges).toEqual([
      'Billing Service -> Payment Gateway',
      'Customer Portal -> Billing Service',
      'Customer Portal -> Order',
      'Customer Portal -> Payment Gateway',
      'Payment Gateway -> Customer Portal',
    ]);
    // [[term:Order]] from Logistics resolves to the group term, not Payments' local one.
    const order = g.data.edges.find(
      (e: any) => label(e.source) === 'Customer Portal' && label(e.target) === 'Order',
    );
    expect(g.data.nodes.find((n: any) => n.id === order.target).organization_id).toBeNull();
    const nav = await api(
      'GET',
      `/links/resolve?target=${encodeURIComponent('term:Order')}&from_organization=${o.payments}`,
    );
    expect(nav.data.heading).toBe('Order');
    expect((await api('GET', `/documents/${nav.data.document_id}`)).data.organization_id).toBe(
      o.payments,
    );
  });

  it('renames slugs throughout, keeping the old ones as aliases', async () => {
    const treasury = (
      await api('POST', '/organizations', { name: 'Acme Treasury', slug: 'treasury' })
    ).data.id;
    const ledger = (
      await api('POST', '/projects', {
        organization_id: treasury,
        name: 'General Ledger',
        slug: 'ledger',
      })
    ).data;
    expect(ledger.slug).toBe('ledger');
    const mk = async (body: object) => (await api('POST', '/members', body)).data.token as string;
    const tove = await mk({
      name: 'Tove',
      kind: 'human',
      organization_id: treasury,
      role: 'editor',
    });
    const bot = await mk({ name: 'Treasury bot', kind: 'agent', organization_id: treasury });
    const section = async (level: object, title: string, body: string) => {
      const doc = (await api('POST', '/documents', { ...level, kind: 'reference', title })).data;
      return (await api('POST', `/documents/${doc.id}/sections`, { heading: title, body })).data
        .section;
    };
    const own = await section(
      { organization_id: treasury },
      'Notes',
      'Post to [[ledger]], see [[General Ledger|the books]] and `[[ledger]]`.',
    );
    const shared = await section(
      {},
      'Group notes',
      'Treasury keeps [[treasury/ledger#Auth|its ledger]].',
    );

    // The preview says what changes and what can't, and changes nothing.
    const preview = await api(
      'POST',
      `/projects/${ledger.id}/rename`,
      { slug: 'books', dry_run: true },
      { token: tove },
    );
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({
      from: 'ledger',
      to: 'books',
      applied: false,
      alias_of: null,
    });
    expect(preview.data.rewrite.map((r: any) => [r.heading, r.links])).toEqual([['Notes', 1]]);
    expect(preview.data.cannot_edit.map((r: any) => r.heading)).toEqual(['Group notes']);
    expect((await api('GET', `/projects/${ledger.id}`)).data.slug).toBe('ledger');

    const done = await api(
      'POST',
      `/projects/${ledger.id}/rename`,
      { slug: 'books' },
      { token: tove },
    );
    expect(done.data.applied).toBe(true);
    expect((await api('GET', `/sections/${own.id}`)).data.body).toBe(
      'Post to [[books]], see [[General Ledger|the books]] and `[[ledger]]`.',
    );
    expect((await api('GET', `/sections/${own.id}/versions`)).data[0].note).toBe(
      'Renamed ledger to books',
    );
    expect((await api('GET', `/sections/${shared.id}`)).data.body).toContain(
      '[[treasury/ledger#Auth|its ledger]]',
    );
    expect(
      (await api('GET', `/projects/${ledger.id}`)).data.aliases.map((x: any) => x.old_slug),
    ).toEqual(['ledger']);

    // The old slug still works for links, people and agents, and agents are told to update it.
    const g = await api('GET', '/graph');
    expect(
      g.data.edges.some((e: any) => e.source === 'group' && e.target === `project:${ledger.id}`),
    ).toBe(true);
    expect((await api('GET', '/projects/treasury%2Fledger')).data.id).toBe(ledger.id);
    const { client, call } = await mcp(bot);
    const ctx = await call('get_context', { project: 'treasury/ledger' });
    expect(ctx.text).toContain(
      '`treasury/ledger` is an old slug of this project.** Use `treasury/books`',
    );

    // Renaming the organization rewrites org/… links.
    await api('POST', `/organizations/${treasury}/rename`, { slug: 'vault' });
    expect((await api('GET', `/sections/${shared.id}`)).data.body).toBe(
      'Treasury keeps [[vault/ledger#Auth|its ledger]].',
    );
    expect((await call('get_context', { project: 'treasury/books' })).isError).toBe(false);

    // Reusing an old slug is refused until the caller says to take it over.
    const reuse = await api('POST', '/projects', { organization_id: treasury, name: 'Ledger' });
    expect(reuse.status).toBe(409);
    expect(reuse.data.alias_of).toMatchObject({ id: ledger.id, slug: 'books' });
    const taken = await api('POST', '/projects', {
      organization_id: treasury,
      name: 'Ledger',
      take_alias: true,
    });
    expect(taken.status).toBe(201);
    expect((await api('GET', '/projects/vault%2Fledger')).data.id).toBe(taken.data.id);
    expect((await api('GET', `/projects/${ledger.id}`)).data.aliases).toEqual([]);

    // Scopes: a PATCH keeps an alias too, and get_context accepts the old slug.
    const scope = (await api('POST', '/scopes', { project_id: ledger.id, name: 'UI', slug: 'ui' }))
      .data;
    await api('PATCH', `/scopes/${scope.id}`, { slug: 'frontend' }, { token: tove });
    const scoped = await call('get_context', { project: 'vault/books', scopes: ['ui'] });
    expect(scoped.text).toContain('requested explicitly by its old slug "ui"; use "frontend"');
    const alias = (await api('GET', `/scopes/${scope.id}`)).data.aliases[0];
    expect((await api('DELETE', `/aliases/${alias.id}`, undefined, { token: tove })).status).toBe(
      204,
    );
    expect(
      (await call('get_context', { project: 'vault/books', scopes: ['ui'] })).text,
    ).not.toContain('old slug "ui"');
    await client.close();
  });

  it('isolates groups from each other with row-level security', async () => {
    const g2 = await api('POST', '/groups', {
      name: 'Other Corp',
      organization_name: 'Other',
      admin_name: 'Olga',
    });
    expect(g2.status).toBe(201);
    const olga: Who = { token: g2.data.token };
    expect((await api('POST', '/groups', { name: 'x', organization_name: 'y' }, olga)).status).toBe(
      403,
    );
    // The same repository can exist in another group.
    const p2 = await api(
      'POST',
      '/projects',
      { name: 'Customer Portal', remote_url: HTTPS_REMOTE },
      olga,
    );
    expect(p2.status).toBe(201);
    expect((await api('GET', `/projects/${projectId}`, undefined, olga)).status).toBe(404);
    expect((await api('GET', '/projects', undefined, olga)).data.map((p: any) => p.id)).toEqual([
      p2.data.id,
    ]);
    expect((await api('GET', '/search?q=undoable', undefined, olga)).data).toEqual([]);
    expect((await api('GET', '/me', undefined, { ...olga, group: 'acme-group' })).status).toBe(403);
    // The server admin can switch between groups.
    expect(
      (await api('GET', '/projects', undefined, { token: ADMIN, group: g2.data.group.slug })).data
        .length,
    ).toBe(1);

    // Straight at the database: a transaction scoped to one group cannot see the other's rows,
    // and a connection with no group sees nothing.
    const count = (groupId: string | null) =>
      withScope(
        pool,
        { groupId },
        async (c) =>
          (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM projects')).rows[0].n,
      );
    expect(await count(g2.data.group.id)).toBe(1);
    expect(await count(null)).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM sections')).rows[0].n).toBe(0);
    // Writing into another group is refused too.
    await expect(
      withScope(pool, { groupId: g2.data.group.id }, (c) =>
        c
          .query('UPDATE projects SET name = \'hijacked\' WHERE id = $1 RETURNING id', [projectId])
          .then((r) => r.rowCount),
      ),
    ).resolves.toBe(0);
  });

  it('points out the old mapping when a repository is registered under a new remote', async () => {
    const { client, call } = await mcp(t.jonas);
    const moved = await call('register_repository', {
      project: 'customer-portal',
      remote_url: 'https://github.com/acme-moved/customer-portal.git',
    });
    expect(moved.isError).toBe(false);
    expect(moved.text).toContain('also mapped to `azure:acme/platform/customer-portal`');
    const other = await call('register_repository', {
      project: 'customer-portal',
      remote_url: 'https://github.com/acme/portal-docs.git',
    });
    expect(other.text).not.toContain('also mapped');
    await client.close();
    const repos = (await api('GET', `/projects/${projectId}`)).data.repositories;
    for (const r of repos.filter((r: any) => r.remote_key.startsWith('github.com/')))
      await api('DELETE', `/repositories/${r.id}`);
  });

  it('counts agent reads and writes per organization and section', async () => {
    const activity = async (period = '7d') =>
      (await api('GET', `/organizations/${o.logistics}/activity?period=${period}`)).data;
    const before = await activity();
    expect(before.days).toHaveLength(7);
    expect(before.reads.daily).toHaveLength(7);

    // Other organizations' agents don't count toward Logistics.
    const lars = await mcp(t.lars);
    await lars.call('get_context', { project: 'payments/payment-gateway' });
    await lars.client.close();
    const { client, call } = await mcp(t.jonas);
    const args = { remote_url: SSH_REMOTE, path: 'frontend/src/app.ts' };
    const ctx = await call('get_context', args);
    await call('get_context', args);
    const sid = /\[s:([0-9a-f]{8}) · (?:open|propose)\]/.exec(ctx.text)![1];
    const read = JSON.parse((await call('read_section', { section_id: sid })).text);
    const docBefore = (await api('GET', `/documents/${read.document_id}`)).data.sections.find(
      (s: any) => s.id === read.id,
    ).activity;
    await call('read_section', { section_id: sid });
    expect(
      (
        await call('update_section', {
          section_id: sid,
          body: `${read.body}\n\nOne more line.`,
          reason: 'Test',
        })
      ).isError,
    ).toBe(false);
    await client.close();
    // Agent mode and people browsing don't count.
    await api(
      'POST',
      '/agent/tool',
      { name: 'get_context', args },
      { token: ADMIN, org: o.logistics, agent: true },
    );
    await api('GET', `/documents/${read.document_id}`);

    const after = await activity();
    expect(after.reads.count).toBe(before.reads.count + 4);
    expect(after.writes.count).toBe(before.writes.count + 1);
    expect(after.reads.daily.at(-1)).toBeGreaterThanOrEqual(4);
    expect(after.reads.previous).toBe(0);
    expect(after.most_read_projects[0]).toMatchObject({ slug: 'customer-portal' });
    expect(after.most_read_documents.length).toBeGreaterThan(0);
    expect(after.most_written_documents.map((d: any) => d.id)).toContain(read.document_id);
    expect(after.top_writers[0]).toMatchObject({ name: 'Agent Jonas' });
    const all = await activity('all');
    expect(all.reads.previous).toBeNull();
    expect(all.days).toHaveLength(53 * 7);
    expect((await api('GET', `/organizations/${o.logistics}/activity?period=year`)).status).toBe(
      400,
    );
    expect(
      (await api('GET', `/organizations/${o.logistics}/activity`, undefined, { token: t.ida }))
        .status,
    ).toBe(200);

    const section = (await api('GET', `/documents/${read.document_id}`)).data.sections.find(
      (s: any) => s.id === read.id,
    ).activity;
    expect(section.reads).toBe(docBefore.reads + 1);
    expect(section.week).toBe(docBefore.week + 1);
    expect(section.last_read_at).not.toBeNull();
    expect(section.daily).toHaveLength(28);

    // Row-level security keeps the log inside the group.
    const other = (await pool.query('SELECT id FROM groups WHERE slug <> \'acme-group\' LIMIT 1'))
      .rows[0].id;
    for (const table of ['agent_requests', 'section_reads']) {
      const count = (groupId: string | null) =>
        withScope(
          pool,
          { groupId },
          async (c) =>
            (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
        );
      expect(await count(other)).toBe(0);
      expect(await count(null)).toBe(0);
    }
  });

  it('warns about documents agents stopped requesting, and hides disabled ones from agents', async () => {
    const doc = (
      await api('POST', '/documents', {
        organization_id: o.logistics,
        kind: 'reference',
        title: 'Pallet runbook',
      })
    ).data;
    await api('POST', `/documents/${doc.id}/sections`, {
      heading: 'Stacking pallets',
      body: 'Never stack zxqvpallet crates above two.',
      mode: 'open',
    });
    const fresh = (
      await api('POST', '/documents', {
        organization_id: o.logistics,
        kind: 'reference',
        title: 'New runbook',
      })
    ).data;
    const listed = async () => (await api('GET', `/documents?organization_id=${o.logistics}`)).data;
    expect((await listed()).find((d: any) => d.id === doc.id).staleness).toBeNull();

    // Pretend the document, and tracking, started 40 days ago, and nobody has read it since.
    await withScope(pool, { groupId: null, bypass: true }, async (c) => {
      await c.query('UPDATE documents SET created_at = now() - interval \'40 days\' WHERE id = $1', [
        doc.id,
      ]);
      await c.query(
        `UPDATE agent_requests SET created_at = now() - interval '40 days'
                      WHERE id = (SELECT min(id) FROM agent_requests WHERE organization_id = $1)`,
        [o.logistics],
      );
    });
    expect((await api('GET', `/documents/${doc.id}`)).data.staleness).toBe('month');
    expect((await listed()).find((d: any) => d.id === fresh.id).staleness).toBeNull();
    const stale = async (period: string) =>
      (
        await api('GET', `/organizations/${o.logistics}/activity?period=${period}`)
      ).data.stale_documents.map((d: any) => d.id);
    expect(await stale('30d')).toContain(doc.id);
    expect(await stale('7d')).toContain(doc.id);
    expect(await stale('30d')).not.toContain(fresh.id);

    const { client, call } = await mcp(t.jonas);
    const args = { remote_url: SSH_REMOTE, path: 'frontend/src/app.ts' };
    expect((await call('get_context', args)).text).toContain('Stacking pallets');

    // Disabled: people still see it, agents don't.
    expect(
      (await api('PATCH', `/documents/${doc.id}`, { disabled: true }, { token: t.anders })).status,
    ).toBe(403);
    expect(
      (await api('PATCH', `/documents/${doc.id}`, { disabled: true })).data.disabled_at,
    ).not.toBeNull();
    const disabled = (await api('GET', `/documents/${doc.id}`)).data;
    expect(disabled).toMatchObject({ staleness: null });
    expect(disabled.disabled_at).not.toBeNull();
    expect((await call('get_context', args)).text).not.toContain('Stacking pallets');
    const sid = disabled.sections[0].id.slice(0, 8);
    const blocked = await call('read_section', { section_id: sid });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('disabled');
    expect(
      (await call('update_section', { section_id: sid, body: 'x', reason: 'x' })).isError,
    ).toBe(true);
    expect((await call('search', { query: 'zxqvpallet' })).text).toBe('[]');
    expect((await api('GET', '/search?q=zxqvpallet')).data.length).toBe(1);
    expect(
      (
        await api('GET', `/documents?organization_id=${o.logistics}`, undefined, {
          token: ADMIN,
          org: o.logistics,
          agent: true,
        })
      ).data.map((d: any) => d.id),
    ).not.toContain(doc.id);
    expect(await stale('30d')).not.toContain(doc.id);
    const exported = (await api('GET', `/export?organization_id=${o.logistics}`)).data;
    expect(
      exported.documents.find((d: any) => d.title === 'Pallet runbook').disabled_at,
    ).not.toBeNull();

    // Enabled again, agents get it back.
    await api('PATCH', `/documents/${doc.id}`, { disabled: false });
    expect((await call('get_context', args)).text).toContain('Stacking pallets');
    await client.close();
    await api('DELETE', `/documents/${doc.id}`);
    await api('DELETE', `/documents/${fresh.id}`);
  });

  it('runs a pull-request style review between a person and an agent', async () => {
    const jonas = await mcp(t.jonas);
    await jonas.call('propose_learning', {
      heading: "Dates are shown in the user's time zone",
      body: 'Format every date with `formatLocal()`.\nNever show UTC to customers.\nStore dates in UTC.',
      rationale: 'User saw UTC times in the booking list.',
      remote_url: HTTPS_REMOTE,
      path: 'frontend/src/app/booking/list.ts',
    });
    const p = (await api('GET', '/proposals?status=pending')).data.find((x: any) =>
      x.heading.startsWith('Dates are shown'),
    );
    expect(p.revision).toBe(1);
    expect(p.awaiting).toBe('review');

    // A reviewer comments on line 2 with a suggestion, and starts a general thread.
    const line = await api('POST', `/proposals/${p.id}/comments`, {
      body: 'Customers in Norway see this too; be explicit.',
      line_start: 2,
      line_end: 2,
      suggestion: 'Never show UTC to customers, wherever they are.',
    });
    expect(line.status).toBe(201);
    expect(line.data.anchor).toBe('Never show UTC to customers.');
    const general = await api('POST', `/proposals/${p.id}/comments`, {
      body: 'Which helper formats durations?',
    });
    expect(general.data.line_start).toBeNull();
    expect(
      (await api('POST', `/proposals/${p.id}/comments`, { body: 'x', line_start: 9, line_end: 9 }))
        .data.message,
    ).toContain('between 1 and 3');
    // Viewers can't comment; agents of another organization can't either.
    expect(
      (await api('POST', `/proposals/${p.id}/comments`, { body: 'x' }, { token: t.anders })).status,
    ).toBe(403);
    const changes = await api('POST', `/proposals/${p.id}/request-changes`, {
      note: 'Please answer the question.',
    });
    expect(changes.data.status).toBe('changes_requested');
    expect((await api('GET', `/proposals/${p.id}`)).data.awaiting).toBe('author');

    // The agent learns about it from get_context, reads the review and answers.
    const ctx = await jonas.call('get_context', { remote_url: HTTPS_REMOTE });
    expect(ctx.text).toContain('## Review feedback waiting on you');
    expect(ctx.text).toContain(p.id);
    const reviewText = (await jonas.call('get_review', { proposal_id: p.id })).text;
    expect(reviewText).toContain('  2 | Never show UTC to customers.');
    expect(reviewText).toContain(
      'Last verdict: changes requested by Admin: "Please answer the question."',
    );
    const suggestionId = /apply_suggestion comment_id=([0-9a-f-]{36})/.exec(reviewText)![1];
    const reply = await jonas.call('reply_to_review', {
      proposal_id: p.id,
      thread_id: general.data.id,
      body: '`formatDuration()` in the same file.',
      resolve: true,
    });
    expect(reply.text).toContain('resolved');
    expect((await jonas.call('apply_suggestion', { comment_id: suggestionId })).text).toContain(
      'revision 2',
    );
    const rev = await jonas.call('revise_proposal', {
      proposal_id: p.id,
      note: 'Mention durations',
      body: 'Format every date with `formatLocal()` and durations with `formatDuration()`.\nNever show UTC to customers, wherever they are.\nStore dates in UTC.',
    });
    expect(rev.text).toContain('revision 3');
    expect(rev.text).toContain('pending');
    const mine = JSON.parse((await jonas.call('list_my_proposals', {})).text);
    expect(mine.find((x: any) => x.id === p.id).next_move).toBe('reviewers');
    expect((await jonas.call('get_context', { remote_url: HTTPS_REMOTE })).text).not.toContain(
      'waiting on you',
    );

    // The reviewer sees the whole history.
    const r = (await api('GET', `/proposals/${p.id}/review`)).data;
    expect(r.revisions.map((x: any) => x.revision)).toEqual([1, 2, 3]);
    expect(r.events.map((e: any) => e.kind)).toEqual([
      'proposed',
      'changes_requested',
      'revised',
      'revised',
    ]);
    expect(r.threads.every((th: any) => th.resolved_at)).toBe(true);
    const lineThread = r.threads.find((th: any) => th.line_start !== null);
    expect(lineThread.comments[0].applied_at).toBeTruthy();
    expect(lineThread.line_start).toBe(2);
    expect(lineThread.outdated).toBe(true); // its original line now reads differently

    // A stale suggestion can't be applied blindly.
    const stale = await api('POST', `/proposals/${p.id}/comments`, {
      body: 'b',
      line_start: 3,
      line_end: 3,
      suggestion: 'Store dates in UTC, always.',
    });
    await jonas.call('revise_proposal', {
      proposal_id: p.id,
      note: 'shorter',
      body: 'Use `formatLocal()` and `formatDuration()`.\nNever show UTC.\nUTC in storage.',
    });
    const applyStale = await api('POST', `/comments/${stale.data.comments[0].id}/apply`);
    expect(applyStale.status).toBe(409);

    // Approving from the inbox still works and closes the loop.
    const ok = await api('POST', `/proposals/${p.id}/approve`, {});
    expect(ok.status).toBe(200);
    const done = (await api('GET', `/proposals/${p.id}/review`)).data;
    expect(done.events.at(-1).kind).toBe('approved');
    expect(done.can_revise).toBe(false);
    expect(
      (await api('POST', `/proposals/${p.id}/revisions`, { body: 'late' }, { token: t.jonas }))
        .status,
    ).toBe(409);
    await jonas.client.close();
  });

  it('lets people manage their own name and tokens', async () => {
    const who = { token: t.anders };
    expect((await api('PATCH', '/me', { name: 'Anders H.' }, who)).status).toBe(200);
    expect((await api('GET', '/me', undefined, who)).data.actor.name).toBe('Anders H.');
    const created = await api('POST', '/me/tokens', { label: 'laptop' }, who);
    expect(created.status).toBe(201);
    const second = { token: created.data.token };
    const list = await api('GET', '/me/tokens', undefined, second);
    expect(list.data.map((x: any) => x.label)).toEqual(['default', 'laptop']);
    // Someone else's token can't be revoked through /me.
    const others = await api('GET', '/me/tokens');
    expect((await api('DELETE', `/me/tokens/${others.data[0].id}`, undefined, who)).status).toBe(
      404,
    );
    expect((await api('DELETE', `/me/tokens/${list.data[1].id}`, undefined, who)).status).toBe(204);
    expect((await api('GET', '/me', undefined, second)).status).toBe(401);
    expect((await api('POST', '/me/tokens', {}, { token: t.lars })).status).toBe(403);
  });

  it('files findings agents report, lets people sort them and agents solve them', async () => {
    const jonas = await mcp(t.jonas);
    const report = (args: Record<string, unknown>) =>
      jonas.call('report_finding', {
        remote_url: SSH_REMOTE,
        problem: 'The total is summed before discounts apply.',
        proposed_fix: 'Apply discounts in CartTotal first.',
        commit_sha: '0123456789abcdef',
        ...args,
      });
    const first = await report({
      file: './frontend/src/app/cart.ts',
      line_start: 40,
      line_end: 52,
      title: 'Cart total ignores discounts',
    });
    expect(first.text).toContain('filed under **Acme Logistics › Customer Portal › Frontend**');
    const firstId = /Finding `([0-9a-f]{8})`/.exec(first.text)![1];

    // Looks like the same problem: nothing is filed until the agent says it checked.
    const similar = await report({
      file: 'frontend/src/app/cart.ts',
      title: 'Cart total ignores discount codes',
    });
    expect(similar.text).toContain('Not filed yet');
    expect(similar.text).toContain(firstId);
    const second = await report({
      file: 'frontend/src/app/cart.ts',
      title: 'Cart total ignores discount codes',
      even_if_similar: true,
    });
    expect(second.text).toContain('filed under');
    const backend = await report({
      file: 'backend/Api/Orders.cs',
      title: 'Order export times out for large months',
    });
    expect(backend.text).toContain('Customer Portal › Backend');
    // Agents only write to their own organization.
    const lars = await mcp(t.lars);
    expect(
      (
        await lars.call('report_finding', {
          remote_url: SSH_REMOTE,
          file: 'x.ts',
          title: 'Nope',
          problem: '',
          proposed_fix: '',
        })
      ).isError,
    ).toBe(true);
    await lars.client.close();

    const list = (await api('GET', `/findings?project_id=${projectId}`)).data;
    expect(list.map((f: any) => f.status)).toEqual(['new', 'new', 'new']);
    const cart = list.find((f: any) => f.id.startsWith(firstId));
    expect(cart).toMatchObject({
      file: 'frontend/src/app/cart.ts',
      line_start: 40,
      line_end: 52,
      scope_name: 'Frontend',
      created_by_kind: 'agent',
      where: 'Acme Logistics › Customer Portal › Frontend',
      commit_sha: '0123456789abcdef',
      can_triage: true,
    });
    const codes = list.find((f: any) => f.title === 'Cart total ignores discount codes');
    expect((await api('GET', '/me')).data.new_findings).toBe(3);
    // Payments may read Logistics, so Ida sees them, but only Logistics' editors sort them.
    expect(
      (await api('GET', `/findings/${cart.id}`, undefined, { token: t.ida })).data.can_triage,
    ).toBe(false);
    expect(
      (await api('PUT', `/findings/${cart.id}/status`, { status: 'dismissed' }, { token: t.ida }))
        .status,
    ).toBe(403);

    // New findings stay out of the context until a person has looked at them.
    const ctx = () =>
      jonas.call('get_context', { remote_url: SSH_REMOTE, path: 'frontend/src/app/checkout.ts' });
    expect((await ctx()).text).not.toContain('Known findings here');

    // Only people with edit rights sort findings; agents can't, and viewers can't.
    expect(
      (await api('PUT', `/findings/${cart.id}/status`, { status: 'todo' }, { token: t.jonas }))
        .status,
    ).toBe(403);
    expect(
      (await api('PUT', `/findings/${cart.id}/status`, { status: 'todo' }, { token: t.anders }))
        .status,
    ).toBe(403);
    expect((await api('PUT', `/findings/${cart.id}/status`, { status: 'todo' })).data.status).toBe(
      'todo',
    );
    const later = await api('PUT', `/findings/${codes.id}/status`, {
      status: 'ask_later',
      remind_after: '2999-01-01',
      note: 'Depends on the pricing rework',
    });
    expect(later.data).toMatchObject({
      status: 'ask_later',
      remind_after: '2999-01-01',
      status_by_name: 'Admin',
    });
    expect((await api('GET', '/me')).data.new_findings).toBe(1);

    let text = (await ctx()).text;
    expect(text).toContain('## Known findings here');
    expect(text).toContain(
      `\`${firstId}\` **Cart total ignores discounts** in \`frontend/src/app/cart.ts:40-52\``,
    );
    // Ask me later waits for its day; findings elsewhere in the project stay out.
    expect(text).not.toContain('ignores discount codes');
    expect(text).not.toContain('Order export');
    await api('PUT', `/findings/${codes.id}/status`, { status: 'ask_later' });
    text = (await ctx()).text;
    expect(text).toContain('Ask the user about these');
    expect(text).toContain('ignores discount codes');
    expect(
      (await jonas.call('get_context', { remote_url: SSH_REMOTE, path: 'backend/Api/Orders.cs' }))
        .text,
    ).not.toContain('Cart total');

    const todo = await jonas.call('list_findings', { remote_url: SSH_REMOTE });
    expect(todo.text).toContain('1 "to do" finding');
    expect(todo.text).toContain('Apply discounts in CartTotal first.');
    expect(todo.text).toContain('reported at commit `0123456789ab`');
    expect(
      (
        await jonas.call('list_findings', {
          remote_url: SSH_REMOTE,
          status: 'open',
          path: 'backend',
        })
      ).text,
    ).toContain('Order export');
    // A file path means its folder, as in get_context.
    expect(
      (
        await jonas.call('list_findings', {
          remote_url: SSH_REMOTE,
          status: 'open',
          path: 'frontend/src/app/checkout.ts',
        })
      ).text,
    ).toContain('ignores discount codes');

    // An agent marks one solved, with the commit; it then drops out of the default list.
    expect(
      (
        await jonas.call('resolve_finding', {
          id: firstId,
          solved_ref: 'abc1234',
          note: 'Discounts first',
        })
      ).text,
    ).toContain('is solved');
    expect(
      (await jonas.call('resolve_finding', { id: firstId, solved_ref: 'abc1234', note: 'Again' }))
        .isError,
    ).toBe(true);
    expect(
      (await api('GET', `/findings?project_id=${projectId}`)).data.map((f: any) => f.title),
    ).not.toContain('Cart total ignores discounts');
    const solved = (await api('GET', `/findings?project_id=${projectId}&status=solved`)).data;
    expect(solved[0]).toMatchObject({
      title: 'Cart total ignores discounts',
      solved_ref: 'abc1234',
      status_note: 'Discounts first',
      status_by_name: 'Agent Jonas',
    });
    expect((await ctx()).text).not.toContain('Cart total ignores discounts');

    // The reporter corrects an open finding; a new file means a new scope. Solved ones stay as they
    // are.
    const backendId = /Finding `([0-9a-f]{8})`/.exec(backend.text)![1];
    const fixed = await jonas.call('update_finding', {
      id: backendId,
      commit_sha: 'fedcba9876543210',
      title: 'Order export times out for large months and years',
      file: 'frontend/src/app/export.ts',
      line_start: 12,
      remote_url: SSH_REMOTE,
    });
    expect(fixed.text).toContain('is updated');
    expect(fixed.text).toContain('reported at commit `fedcba987654`');
    const moved = (await api('GET', `/findings?project_id=${projectId}`)).data.find((f: any) =>
      f.id.startsWith(backendId),
    );
    expect(moved).toMatchObject({
      title: 'Order export times out for large months and years',
      file: 'frontend/src/app/export.ts',
      line_start: 12,
      line_end: 12,
      scope_name: 'Frontend',
      problem: 'The total is summed before discounts apply.',
      status: 'new',
    });
    expect((await jonas.call('update_finding', { id: firstId, title: 'Too late' })).isError).toBe(
      true,
    );
    expect((await jonas.call('update_finding', { id: backendId, title: ' ' })).isError).toBe(true);
    const otherAgent = await mcp(t.lars);
    expect(
      (await otherAgent.call('update_finding', { id: backendId, title: 'Not mine' })).text,
    ).toContain('Only whoever reported');
    await otherAgent.client.close();
    expect((await api('GET', `/findings/counts?project_id=${projectId}`)).data).toEqual({
      new: 1,
      todo: 0,
      ask_later: 1,
      dismissed: 0,
      solved: 1,
    });
    // Row-level security: another group's transaction sees none of them, even without a WHERE
    // clause.
    const count = (scope: { groupId: string | null; bypass?: boolean }) =>
      withScope(
        pool,
        scope,
        async (c) =>
          (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM findings')).rows[0].n,
      );
    expect(await count({ groupId: '00000000-0000-0000-0000-000000000001' })).toBe(0);
    expect(await count({ groupId: null, bypass: true })).toBe(3);
    await jonas.client.close();
  });

  it('keeps viewers read-only and revokes tokens', async () => {
    expect((await api('GET', '/projects', undefined, { token: t.anders })).status).toBe(200);
    expect(
      (
        await api(
          'POST',
          '/projects',
          { name: 'Nope', organization_id: o.logistics },
          { token: t.anders },
        )
      ).status,
    ).toBe(403);
    const members = await api('GET', '/members');
    const jonas = members.data.find((m: any) => m.name === 'Agent Jonas');
    expect((await api('DELETE', `/tokens/${jonas.tokens[0].id}`)).status).toBe(204);
    expect((await api('GET', '/me', undefined, { token: t.jonas })).status).toBe(401);
  });

  let copyOrg = '';

  it('exports an organization and imports it again as a new one', async () => {
    // Only admins of the organization or the group may export it.
    expect(
      (await api('GET', `/export?organization_id=${o.logistics}`, undefined, { token: t.ida }))
        .status,
    ).toBe(403);
    expect((await api('GET', '/export', undefined, { token: t.ida })).status).toBe(403);
    expect(
      (await api('GET', `/export?organization_id=${o.logistics}`, undefined, { token: t.anders }))
        .status,
    ).toBe(403);
    expect(
      (await api('GET', `/export?organization_id=${o.payments}`, undefined, { token: t.ida }))
        .status,
    ).toBe(200);

    const exported = await api('GET', `/export?organization_id=${o.logistics}&people=1`);
    expect(exported.status).toBe(200);
    const file = exported.data;
    expect(JSON.stringify(file)).not.toMatch(/chr_|token_hash/);
    expect(file.organizations.map((x: any) => x.slug)).toEqual(['logistics']);
    expect(file.documents.every((d: any) => d.organization === o.logistics)).toBe(true);
    expect(file.proposals.length).toBeGreaterThan(0);
    expect(file.api_specs.length).toBeGreaterThan(0);
    expect(file.findings.map((f: any) => f.status).sort()).toEqual(['ask_later', 'new', 'solved']);
    expect(file.people.map((p: any) => p.name)).toContain('Anders H.');
    const sections = file.documents.flatMap((d: any) => d.sections).length;

    const orgCount = async () => (await api('GET', '/organizations')).data.length;
    const before = await orgCount();
    // The slug is taken here: the preview says so, suggests another and changes nothing.
    const preview = await api('POST', '/import/preview', { file });
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ ok: false, applied: false });
    expect(preview.data.organizations[0]).toMatchObject({
      slug: 'logistics',
      suggested_slug: 'logistics-2',
      id: null,
    });
    expect(preview.data.counts.sections).toBe(sections);
    expect(preview.data.warnings.join('\n')).toContain('already registered in this group');
    expect(await orgCount()).toBe(before);
    expect((await api('POST', '/import', { file })).status).toBe(409);
    expect((await api('POST', '/import', { file: { ...file, version: 2 } })).status).toBe(400);
    const broken = {
      ...file,
      projects: [{ ...file.projects[0], organization: 'nope' }, ...file.projects.slice(1)],
    };
    expect((await api('POST', '/import', { file: broken })).status).toBe(400);
    const asNew = (slug: string) => ({ [file.organizations[0].key]: { action: 'new', slug } });
    expect(
      (await api('POST', '/import', { file, organizations: asNew('copy') }, { token: t.ida }))
        .status,
    ).toBe(403);
    expect(await orgCount()).toBe(before);

    const imported = await api('POST', '/import', { file, organizations: asNew('logistics-copy') });
    expect(imported.status).toBe(201);
    expect(imported.data).toMatchObject({ ok: true, applied: true });
    expect(imported.data.counts.findings).toBe(3);
    const copy = imported.data.organizations[0].id;
    copyOrg = copy;
    expect(await orgCount()).toBe(before + 1);
    // Everyone in the file is already in this group, so they are matched by name and get no new
    // roles.
    expect(imported.data.counts.people).toBe(0);
    expect(imported.data.merged.people).toBe(file.people.length);

    // Exported again, the copy holds the same content. Repositories stay with the original (one per
    // group).
    const again = (await api('GET', `/export?organization_id=${copy}&people=1`)).data;
    expect(again.organizations[0].slug).toBe('logistics-copy');
    // People who are only members (not authors) stay out: matched people get no roles from a file.
    expect(comparable({ ...again, people: [] })).toEqual(comparable({ ...file, people: [] }));
    expect(again.people.map((p: any) => p.name)).toEqual(
      file.people.filter((p: any) => p.name !== 'Anders H.').map((p: any) => p.name),
    );
    const links = (orgId: string) =>
      withScope(
        pool,
        { groupId: null, bypass: true },
        async (c) =>
          (
            await c.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM section_links l JOIN sections s ON s.id = l.section_id
           JOIN documents d ON d.id = s.document_id WHERE d.organization_id = $1`,
              [orgId],
            )
          ).rows[0].n,
      );
    expect(await links(copy)).toBeGreaterThan(0);
    expect(await links(copy)).toBe(await links(o.logistics));
  });

  it('imports into another group without touching this one', async () => {
    const file = (await api('GET', `/export?organization_id=${o.logistics}`)).data;
    const acme = (await api('GET', '/organizations')).data.length;
    const other: Who = { token: ADMIN, group: 'other-corp' };
    const res = await api('POST', '/import', { file }, other);
    expect(res.status).toBe(201);
    expect(res.data.organizations[0].slug).toBe('logistics');
    // Other Corp has its own copy of the portal's repository already.
    expect(res.data.warnings.join('\n')).toContain('already registered in this group');
    expect((await api('GET', '/organizations')).data.length).toBe(acme);
    expect(
      (await api('GET', '/organizations', undefined, other)).data.map((x: any) => x.slug).sort(),
    ).toEqual(['logistics', 'other']);
  });

  it('merges a file into an organization, section by section', async () => {
    const who: Who = { token: ADMIN, org: copyOrg };
    const doc = (
      await api(
        'POST',
        '/documents',
        { organization_id: copyOrg, kind: 'guidelines', title: 'Merge rules', mode: 'propose' },
        who,
      )
    ).data;
    for (const heading of ['Alpha', 'Beta', 'Gamma', 'Dup']) {
      expect(
        (
          await api(
            'POST',
            `/documents/${doc.id}/sections`,
            { heading, body: `${heading} as it is here.` },
            who,
          )
        ).status,
      ).toBe(201);
    }
    const file = (await api('GET', `/export?organization_id=${copyOrg}`)).data;
    const d = file.documents.find((x: any) => x.key === doc.id);
    const [alpha, beta] = d.sections;
    alpha.body = 'Alpha from the file.';
    beta.body = 'Beta from the file, see [[term:Customer]].';
    beta.key = 'not-from-here'; // Matched by its heading instead.
    d.sections = [
      alpha,
      beta,
      { ...alpha, key: 'delta', heading: 'Delta', body: 'Only in the file.' },
      { ...alpha, key: 'dup-1', heading: 'Dup', body: 'One' },
      { ...alpha, key: 'dup-2', heading: 'Dup', body: 'Two' },
    ];
    const into = { [file.organizations[0].key]: { action: 'merge', into: copyOrg } };

    // Only admins of the organization may merge into it.
    expect(
      (await api('POST', '/import/preview', { file, organizations: into }, { token: t.ida }))
        .status,
    ).toBe(403);
    const options = {
      file,
      organizations: into,
      section_changes: { [alpha.key]: 'file' },
      remove_missing: true,
    };
    const preview = await api('POST', '/import/preview', options);
    expect(preview.status).toBe(200);
    const byHeading = (r: any) =>
      Object.fromEntries(
        r.changes
          .filter((c: any) => c.place.endsWith('Merge rules'))
          .map((c: any) => [`${(c.after ?? c.before).heading}:${c.status}`, c.action]),
      );
    expect(byHeading(preview.data)).toEqual({
      'Alpha:changed': 'file',
      'Beta:changed': 'propose',
      'Delta:new': 'add',
      'Dup:conflict': 'skip',
      'Gamma:only_in_target': 'remove',
      'Dup:only_in_target': 'remove',
    });
    expect(preview.data.merged.conflicts).toBe(2);
    expect(preview.data.counts.proposals).toBe(0); // The file's own proposals are already here.
    const sectionsNow = async () =>
      (await api('GET', `/documents/${doc.id}`, undefined, who)).data.sections;
    expect((await sectionsNow()).map((x: any) => x.heading)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Dup',
    ]);

    const done = await api('POST', '/import', options);
    expect(done.status).toBe(201);
    const after = await sectionsNow();
    expect(after.map((x: any) => x.heading)).toEqual(['Alpha', 'Beta', 'Delta']);
    expect(after[0]).toMatchObject({ body: 'Alpha from the file.', version: 2 });
    expect(after[1]).toMatchObject({ body: 'Beta as it is here.', version: 1 });
    const pending = (await api('GET', `/proposals?status=pending&organization_id=${copyOrg}`)).data;
    const proposal = (Array.isArray(pending) ? pending : pending.items).find(
      (x: any) => x.section_id === after[1].id,
    );
    expect(proposal).toMatchObject({
      kind: 'edit_section',
      body: 'Beta from the file, see [[term:Customer]].',
      base_version: 1,
    });

    // Importing the same file again doesn't propose the same change twice. The two "Dup" sections
    // no longer clash.
    const again = await api('POST', '/import/preview', { file, organizations: into });
    expect(again.data.counts).toMatchObject({ documents: 0, sections: 2, proposals: 0 });
    expect(again.data.merged.proposed).toBe(0);
    expect(byHeading(again.data)['Beta:changed']).toBe('skip');
  });

  it('lets an organization admin merge an export back into their own organization', async () => {
    const ida: Who = { token: t.ida };
    const file = (await api('GET', `/export?organization_id=${o.payments}`, undefined, ida)).data;
    const into = { [file.organizations[0].key]: { action: 'merge', into: o.payments } };
    expect(
      (await api('POST', '/import', { file, organizations: into, group_content: true }, ida))
        .status,
    ).toBe(403);
    const res = await api('POST', '/import', { file, organizations: into }, ida);
    expect(res.status).toBe(201);
    const sections = file.documents.flatMap((d: any) => d.sections).length;
    expect(res.data.counts).toMatchObject({ projects: 0, documents: 0, sections: 0, proposals: 0 });
    expect(res.data.merged).toMatchObject({
      sections,
      unchanged: sections,
      proposed: 0,
      updated: 0,
    });
  });

  it('restores a whole group as a new group', async () => {
    const file = (await api('GET', '/export?people=1')).data;
    expect(file.source.kind).toBe('group');
    expect((await api('POST', '/groups/import/preview', { file }, { token: t.ida })).status).toBe(
      403,
    );
    const preview = await api('POST', '/groups/import/preview', { file });
    expect(preview.data).toMatchObject({
      ok: false,
      applied: false,
      group: { slug: 'acme-group', suggested_slug: 'acme-group-2', id: null },
    });
    expect((await api('GET', '/groups')).data.map((g: any) => g.slug)).not.toContain(
      'acme-group-2',
    );
    expect((await api('POST', '/groups/import', { file })).status).toBe(409);

    const res = await api('POST', '/groups/import', {
      file,
      slug: 'acme-restored',
      name: 'Acme restored',
    });
    expect(res.status).toBe(201);
    expect(res.data.warnings.join('\n')).not.toContain('Group-wide content is left out');
    const restored: Who = { token: ADMIN, group: 'acme-restored' };
    const again = (await api('GET', '/export?people=1', undefined, restored)).data;
    expect(again.source.group).toEqual({
      slug: 'acme-restored',
      name: 'Acme restored',
      context_max_tokens: null,
    });
    expect(comparable(again)).toEqual(comparable(file));
    // People are there, disabled and without tokens, with their roles.
    const members = (await api('GET', '/members', undefined, restored)).data;
    const anders = members.find((m: any) => m.name === 'Anders H.');
    expect(anders).toMatchObject({ tokens: [] });
    expect(anders.disabled_at).toBeTruthy();
    expect(anders.memberships.map((m: any) => m.role)).toEqual(['viewer']);
  });

  it('exports a folder of Markdown files and imports it from the zip', async () => {
    const res = await fetch(`${base}/api/export?organization_id=${o.payments}&format=zip`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(
      /payments-\d{4}-\d{2}-\d{2}\.openpurpose\.zip/,
    );
    const zip = Buffer.from(await res.arrayBuffer());
    const { readZip, writeZip } = await import('../src/domain/zip.js');
    const files = readZip(zip, () => true, 10 * 1024 * 1024);
    const names = files.map((f) => f.name);
    expect(names.slice(0, 2)).toEqual(['README.md', 'manifest.json']);
    expect(names).toContain('payments/purpose.md');
    expect(files.find((f) => f.name === 'payments/purpose.md')!.data.toString()).toMatch(
      /^# Organization purpose\n\n## /,
    );

    const other: Who = { token: ADMIN, group: 'other-corp' };
    const preview = await api('POST', '/import/preview', { zip: zip.toString('base64') }, other);
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ ok: true, applied: false });
    expect(preview.data.warnings.join('\n')).not.toContain(
      'Markdown files in the zip were changed',
    );

    // Edited Markdown isn't imported, and the preview says so.
    const edited = writeZip(
      files.map((f) =>
        f.name === 'payments/purpose.md' ? { ...f, data: Buffer.from('# Changed\n') } : f,
      ),
    );
    const warned = await api('POST', '/import/preview', { zip: edited.toString('base64') }, other);
    expect(warned.data.warnings[0]).toContain('Markdown files in the zip were changed');
    expect(
      (await api('POST', '/import/preview', { zip: Buffer.from('nope').toString('base64') }, other))
        .status,
    ).toBe(400);
  });

  it('exports from the command line', async () => {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(
      'npx',
      [
        'tsx',
        'src/export-cli.ts',
        '--group',
        'acme-group',
        '--organization',
        'payments',
        '--no-history',
      ],
      {
        env: { ...process.env, DATABASE_URL },
        encoding: 'utf8',
      },
    );
    const file = JSON.parse(out);
    expect(file.source).toMatchObject({ kind: 'organization', group: { slug: 'acme-group' } });
    expect(file.organizations.map((x: any) => x.slug)).toEqual(['payments']);
    expect(file.people).toEqual([]);
    expect(
      file.documents.flatMap((d: any) => d.sections).every((s: any) => s.versions.length === 0),
    ).toBe(true);
  });

  it('lets admins choose how much review each agent gets', async () => {
    const created = await api('POST', '/members', {
      name: 'Agent Mona',
      kind: 'agent',
      organization_id: o.logistics,
    });
    const mona = created.data.actor.id as string;
    const member = async () =>
      (await api('GET', '/members')).data.find((m: any) => m.id === mona);
    expect((await member()).permissions).toMatchObject({
      review: 'edit_modes',
      accept_findings: false,
      set_by_name: null,
    });
    // Only admins of the agent's organization set them, and only agents have them.
    expect(
      (await api('PATCH', `/members/${mona}`, { review: 'auto_approve' }, { token: t.anders }))
        .status,
    ).toBe(403);
    expect((await api('PATCH', `/members/${mona}`, { review: 'everything' })).status).toBe(400);
    const me = (await api('GET', '/me')).data.actor.id;
    expect((await api('PATCH', `/members/${me}`, { accept_findings: true })).status).toBe(400);

    const orgDocs = await api('GET', `/documents?organization_id=${o.logistics}`);
    const doc = orgDocs.data[1];
    const locked = (await api('GET', `/documents/${orgDocs.data[0].id}`)).data.sections[0];
    const open = (
      await api('POST', `/documents/${doc.id}/sections`, {
        heading: 'Shipment',
        body: 'A parcel.',
        mode: 'open',
      })
    ).data.section;
    const { client, call } = await mcp(created.data.token);
    const edit = (body: string) =>
      call('update_section', { section_id: open.id, body, reason: 'Clearer' });

    // Always propose: even open sections wait for a person.
    await api('PATCH', `/members/${mona}`, { review: 'always_propose' });
    expect((await edit('A parcel on its way.')).text).toContain('Proposed for review');

    // Approve automatically: proposals in its organization apply at once and say so.
    expect((await api('PATCH', `/members/${mona}`, { review: 'auto_approve' })).status).toBe(200);
    expect((await member()).permissions).toMatchObject({
      review: 'auto_approve',
      set_by_name: expect.any(String),
    });
    await api('PATCH', `/sections/${open.id}`, { mode: 'propose' });
    const applied = await edit('A parcel, tracked.');
    expect(applied.text).toContain('Approved automatically');
    const proposalRef = /proposal ([0-9a-f]{8})/.exec(applied.text)![1];
    const approved = (await api('GET', '/proposals?status=approved')).data.find((p: any) =>
      p.id.startsWith(proposalRef),
    );
    expect(approved).toMatchObject({ auto_approved: true, status: 'approved' });
    expect(approved.review_note).toContain('lets Agent Mona skip review');
    const versions = (await api('GET', `/sections/${open.id}/versions`)).data;
    expect(versions[0]).toMatchObject({ body: 'A parcel, tracked.' });
    expect(versions[0].note).toContain('Approved automatically');

    const learning = await call('propose_learning', {
      heading: 'Parcels carry a tracking id',
      body: 'Always show it.',
      rationale: 'Corrected by Mona.',
      remote_url: HTTPS_REMOTE,
      path: 'frontend/src/app/parcel.ts',
    });
    expect(learning.text).toContain('Learning approved automatically');
    // Locked stays locked, and group-wide content still waits for a group editor.
    expect(
      (await call('update_section', { section_id: locked.id, body: 'x', reason: 'x' })).text,
    ).toContain('locked');
    const groupGuidelines = (await api('GET', '/documents?organization_id=group')).data.find(
      (d: any) => d.kind === 'guidelines',
    );
    expect(
      (
        await call('add_section', {
          document_id: groupGuidelines.id,
          heading: 'Mona idea',
          body: 'x',
          reason: 'y',
        })
      ).text,
    ).toContain('Proposed for review');

    // Accept findings: filed as to do instead of new.
    await api('PATCH', `/members/${mona}`, { accept_findings: true });
    const finding = await call('report_finding', {
      remote_url: SSH_REMOTE,
      file: 'frontend/src/app/parcel-label.ts',
      title: 'Parcel labels print upside down on Zebra printers',
      problem: 'Rotation is applied twice.',
      proposed_fix: 'Rotate once, in LabelPrinter.',
    });
    expect(finding.text).toContain('filed as to do');

    await api('PATCH', `/members/${mona}`, { review: 'edit_modes', accept_findings: false });
    await client.close();
  });
});

/**
 * An export without what differs between copies: ids, slugs and repositories (a remote belongs to
 * one project per group).
 */
function comparable(file: any): unknown {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const walk = (v: any): any => {
    if (Array.isArray(v))
      return v.map(walk).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => k !== 'repositories')
          .map(([k, x]) => [k, walk(x)]),
      );
    }
    return typeof v === 'string' && uuid.test(v) ? '<id>' : v;
  };
  const { exported_at: _, source: __, organizations, people, ...rest } = file;
  return walk({
    ...rest,
    organizations: organizations.map(({ slug: ___, aliases: ____, ...o }: any) => o),
    people: people.map(({ memberships: _____, ...p }: any) => p),
  });
}

describe('browser sessions', () => {
  let adminId = '';
  const days = 30;

  beforeAll(async () => {
    adminId = (await api('GET', '/me')).data.actor.id;
  });

  it('serves the sign-in config without a token', async () => {
    const res = await fetch(`${base}/api/auth/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signup: 'off', methods: [], site_url: null });
  });

  it('swaps a one-time code for a session, once', async () => {
    const code = await issueAuthCode(pool, adminId);
    const first = await api('POST', '/auth/exchange', { code }, { token: '' });
    expect(first.status).toBe(200);
    expect((await api('GET', '/me', undefined, { token: first.data.token })).data.actor.id).toBe(
      adminId,
    );
    expect((await api('POST', '/auth/exchange', { code }, { token: '' })).status).toBe(401);
  });

  it('refuses a code after 60 seconds', async () => {
    const code = await issueAuthCode(pool, adminId);
    await pool.query("UPDATE auth_codes SET expires_at = now() - interval '1 second'");
    expect((await api('POST', '/auth/exchange', { code }, { token: '' })).status).toBe(401);
  });

  it('refuses an expired session', async () => {
    const token = await createSession(pool, adminId, days);
    expect((await api('GET', '/me', undefined, { token })).status).toBe(200);
    await pool.query(
      "UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
      [hashToken(token)],
    );
    expect((await api('GET', '/me', undefined, { token })).status).toBe(401);
  });

  it('signs out by revoking the session only', async () => {
    const token = await createSession(pool, adminId, days);
    expect((await api('POST', '/auth/sign-out', undefined, { token })).status).toBe(204);
    expect((await api('GET', '/me', undefined, { token })).status).toBe(401);
    // Signing out with an API token leaves the token working.
    expect((await api('POST', '/auth/sign-out')).status).toBe(204);
    expect((await api('GET', '/me')).status).toBe(200);
  });

  it('leaves sessions out of token lists', async () => {
    await createSession(pool, adminId, days);
    const mine = await api('GET', '/me/tokens');
    expect(mine.data.length).toBeGreaterThan(0);
    expect(mine.data.every((x: any) => x.label !== 'browser session')).toBe(true);
    const members = await api('GET', '/members');
    const me = members.data.find((m: any) => m.id === adminId);
    expect(me.tokens.every((x: any) => x.label !== 'browser session')).toBe(true);
  });

  it('checks the sign-in settings at startup', () => {
    expect(loadConfig({}).auth).toMatchObject({ provider: '', signup: 'off', sessionDays: 30 });
    expect(() => loadConfig({ OPENPURPOSE_SIGNUP: 'maybe' })).toThrow(/OPENPURPOSE_SIGNUP/);
    expect(() => loadConfig({ OPENPURPOSE_AUTH_PROVIDER: 'supabase' })).toThrow(
      /OPENPURPOSE_PUBLIC_URL/,
    );
    expect(
      loadConfig({
        OPENPURPOSE_AUTH_PROVIDER: 'supabase',
        OPENPURPOSE_PUBLIC_URL: 'https://purpose.example.com',
        OPENPURPOSE_SIGNUP: 'approval',
      }).auth,
    ).toMatchObject({ provider: 'supabase', signup: 'approval' });
  });
});

describe('upgrade from v1', () => {
  it('moves a v1 database into one group and organization', async () => {
    await resetSchema();
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openpurpose-v1-'));
    const migrations = loadConfig({}).migrationsDir;
    await fs.copyFile(path.join(migrations, '001_init.sql'), path.join(dir, '001_init.sql'));
    await migrate(DATABASE_URL, dir);

    const c = new pg.Client({ connectionString: DATABASE_URL });
    await c.connect();
    await c.query(`
      INSERT INTO settings VALUES ('org_name', '"Old Corp"');
      INSERT INTO actors (id, name, kind, role) VALUES
        ('00000000-0000-0000-0000-00000000000a', 'Admin', 'human', 'admin'),
        ('00000000-0000-0000-0000-00000000000b', 'Bot', 'agent', 'agent');
      INSERT INTO projects (id, slug, name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'portal', 'Portal');
      INSERT INTO repositories (project_id, remote_key, remote_url) VALUES ('00000000-0000-0000-0000-0000000000a1', 'azure:x/y/portal', 'u');
      INSERT INTO documents (id, kind, slug, title) VALUES ('00000000-0000-0000-0000-0000000000d1', 'guidelines', 'guidelines', 'Old guidelines');
      INSERT INTO sections (document_id, heading, body, mode) VALUES ('00000000-0000-0000-0000-0000000000d1', 'Rule', 'See [[portal]]', 'locked');`);
    await c.end();

    await migrate(DATABASE_URL, migrations);
    const p = createPool(DATABASE_URL);
    await bootstrap(p, { groupName: 'unused', orgName: 'unused', token: undefined });
    const check = await withScope(p, { groupId: null, bypass: true }, async (q) => ({
      group: (await q.query('SELECT name, slug FROM groups')).rows,
      org: (await q.query('SELECT name FROM organizations')).rows,
      project: (await q.query('SELECT organization_id IS NOT NULL AS ok FROM projects')).rows[0].ok,
      oldDoc: (
        await q.query(
          'SELECT organization_id IS NOT NULL AS ok FROM documents WHERE title = \'Old guidelines\'',
        )
      ).rows[0].ok,
      groupDocs: (
        await q.query('SELECT count(*)::int AS n FROM documents WHERE organization_id IS NULL')
      ).rows[0].n,
      roles: (
        await q.query(`SELECT a.name, a.is_superadmin, m.role, m.organization_id IS NULL AS group_level
                               FROM memberships m JOIN actors a ON a.id = m.actor_id ORDER BY a.name`)
      ).rows,
    }));
    await p.end();
    expect(check.group).toEqual([{ name: 'Old Corp', slug: 'default' }]);
    expect(check.org).toEqual([{ name: 'Old Corp' }]);
    expect(check.project).toBe(true);
    expect(check.oldDoc).toBe(true);
    expect(check.groupDocs).toBe(0);
    expect(check.roles).toEqual([
      { name: 'Admin', is_superadmin: true, role: 'admin', group_level: true },
      { name: 'Bot', is_superadmin: false, role: 'agent', group_level: false },
    ]);
  });
});
