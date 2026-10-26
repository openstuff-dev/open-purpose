import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, withScope, type Pool } from '../src/db.js';
import { bootstrap } from '../src/service/admin.js';
import { createServer } from 'node:http';
import { BILLING_SWAGGER_YAML, ORDER_API } from '../src/demo-specs.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://openpurpose:openpurpose@localhost:5432/openpurpose_test';
const ADMIN = 'chr_test_admin_token_0123456789';

let pool: Pool;
let app: FastifyInstance;
let base: string;

type Who = { token: string; group?: string; org?: string; agent?: boolean };
const root: Who = { token: ADMIN };

async function api<T = any>(method: string, path: string, body?: unknown, who: Who = root): Promise<{ status: number; data: T }> {
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
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as Array<{ text: string }>).map((c) => c.text).join('\n'), isError: !!r.isError };
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
  await app?.close();
  await pool?.end();
});

describe('OpenPurpose with groups and organizations', () => {
  const t: Record<string, string> = {}; // tokens
  const o: Record<string, string> = {}; // organization ids
  let projectId: string;
  let frontendScopeId: string;

  it('rejects requests without a valid token', async () => {
    expect((await api('GET', '/me', undefined, { token: 'nope' })).status).toBe(401);
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
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
    expect((await api(`GET`, `/documents?organization_id=${o.logistics}`)).data.map((d: any) => d.kind)).toEqual(['purpose', 'business_logic', 'guidelines']);
  });

  it('creates a second organization, people and agents per organization', async () => {
    const pay = await api('POST', '/organizations', { name: 'Acme Payments', slug: 'payments' });
    expect(pay.status).toBe(201);
    o.payments = pay.data.id;
    expect((await api('GET', '/documents?organization_id=group')).data.map((d: any) => d.kind)).toEqual(['purpose', 'guidelines']);
    await api('PATCH', `/organizations/${o.logistics}`, { slug: 'logistics' });
    const mk = async (body: object) => (await api('POST', '/members', body)).data.token as string;
    t.jonas = await mk({ name: 'Agent Jonas', kind: 'agent', organization_id: o.logistics });
    t.lars = await mk({ name: 'Agent Lars', kind: 'agent', organization_id: o.payments });
    t.ida = await mk({ name: 'Ida', kind: 'human', organization_id: o.payments, role: 'admin' });
    t.anders = await mk({ name: 'Anders', kind: 'human', organization_id: o.logistics, role: 'viewer' });
    t.groupEditor = await mk({ name: 'Grete', kind: 'human', organization_id: null, role: 'editor' });
    expect((await api('POST', '/members', { name: 'x', kind: 'agent' })).status).toBe(400);
    // Organization admins manage their own organization only.
    expect((await api('POST', '/members', { name: 'Payments bot', kind: 'agent', organization_id: o.payments }, { token: t.ida })).status).toBe(201);
    expect((await api('POST', '/members', { name: 'Sneaky', kind: 'agent', organization_id: o.logistics }, { token: t.ida })).status).toBe(403);
    expect((await api('POST', '/organizations', { name: 'Nope' }, { token: t.ida })).status).toBe(403);
    const members = await api('GET', '/members', undefined, { token: t.ida });
    expect(members.data.map((m: any) => m.name).sort()).toEqual(['Agent Lars', 'Ida', 'Payments bot']);
  });

  it('creates a project with scopes at every level', async () => {
    const p = await api('POST', '/projects', {
      organization_id: o.logistics, name: 'Customer Portal',
      purpose: 'Self-service portal. Uses [[billing-service]] for invoices, [[term:Order]] data and charges via [[payments/payment-gateway]].',
      remote_url: HTTPS_REMOTE,
    });
    expect(p.status).toBe(201);
    projectId = p.data.id;
    frontendScopeId = (await api('POST', '/scopes', { project_id: projectId, name: 'Frontend', path_globs: ['frontend/**'] })).data.id;
    await api('POST', '/scopes', { project_id: projectId, name: 'Backend', path_globs: ['backend/**'] });
    const ng = await api('POST', '/scopes', { organization_id: o.logistics, name: 'Angular apps', slug: 'angular', stacks: ['angular'] });
    expect(ng.data.organization_id).toBe(o.logistics);
    const dotnet = await api('POST', '/scopes', { name: '.NET services', slug: 'dotnet', stacks: ['dotnet'] });
    expect(dotnet.data.organization_id).toBeNull();
    const dotnetDoc = await api('POST', '/documents', { scope_id: dotnet.data.id, kind: 'guidelines', title: '.NET conventions' });
    expect(dotnetDoc.data.organization_id).toBeNull();
    await api('POST', `/documents/${dotnetDoc.data.id}/sections`, { heading: 'Target .NET 10', body: 'Nullable on.', mode: 'locked' });
    // Payments has a project too, linking back.
    const gw = await api('POST', '/projects', { name: 'Payment Gateway', slug: 'payment-gateway', purpose: 'Charges cards for [[logistics/customer-portal]]. Secret fraud rules live here.' }, { token: t.ida });
    expect(gw.status).toBe(201);
    expect(gw.data.organization_id).toBe(o.payments);
    expect((await api('POST', '/projects', { organization_id: o.logistics, name: 'Nope' }, { token: t.ida })).status).toBe(403);
  });

  it('layers group, organization, project and scope context for an agent', async () => {
    const { client, call } = await mcp(t.jonas);
    const fe = await call('get_context', {
      remote_url: SSH_REMOTE, path: 'frontend/src/app/editor.ts',
      manifests: [{ path: 'frontend/package.json', content: FRONTEND_PKG }],
    });
    expect(fe.isError).toBe(false);
    expect(fe.text).toContain('- Group: **Acme Group**');
    expect(fe.text).toContain('- Organization: **Acme Logistics**');
    expect(fe.text).toContain('(`logistics/customer-portal`, found via git remote)');
    expect(fe.text).toContain('Acme Logistics › Angular apps (stack "angular")');
    expect(fe.text).toContain('Customer Portal › Frontend (path "frontend/**")');
    const order = ['## Acme Group', '## Acme Logistics', '## Customer Portal'].map((h) => fe.text.indexOf(h));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
    expect(fe.text).toContain('It will be filed under **Acme Logistics › Customer Portal › Frontend**');

    const be = await call('get_context', {
      remote_url: SSH_REMOTE, path: 'backend/Api/Orders.cs', manifests: [{ path: 'backend/Api/Api.csproj', content: API_CSPROJ }],
    });
    expect(be.text).toContain('Acme Group › .NET services (stack "dotnet")');
    expect(be.text).toContain('Target .NET 10');
    await client.close();
  });

  it('files a learning under the frontend only', async () => {
    const { client, call } = await mcp(t.jonas);
    const r = await call('propose_learning', {
      heading: 'Every user action must be undoable', body: 'Use the CommandStack.', rationale: 'Corrected by Jonas.',
      remote_url: HTTPS_REMOTE, path: 'frontend/src/app/toolbar.ts',
    });
    expect(r.text).toContain('Learning proposed for **Acme Logistics › Customer Portal › Frontend**');
    const inbox = await api('GET', '/proposals?status=pending');
    const learning = inbox.data.find((p: any) => p.heading === 'Every user action must be undoable');
    expect(learning.scope_id).toBe(frontendScopeId);
    expect(learning.organization_id).toBe(o.logistics);
    // Payments' admin can neither see nor approve Logistics proposals.
    expect((await api('GET', '/proposals?status=pending', undefined, { token: t.ida })).data.some((p: any) => p.id === learning.id)).toBe(false);
    expect((await api('POST', `/proposals/${learning.id}/approve`, {}, { token: t.ida })).status).toBe(403);
    expect((await api('GET', `/proposals/${learning.id}`, undefined, { token: t.ida })).status).toBe(404);
    expect((await api('POST', `/proposals/${learning.id}/approve`, {})).status).toBe(200);
    const detail = await api('GET', `/proposals/${learning.id}`);
    expect(detail.data).toMatchObject({ status: 'approved', created_by_kind: 'agent', reviewed_by_name: 'Admin', scope_name: 'Frontend', project_name: 'Customer Portal' });
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
    const apiRepo = (await api('POST', `/projects/${projectId}/repositories`, { remote_url: API_REMOTE })).data;
    const dotnetApi = await api('POST', '/scopes', { project_id: projectId, name: '.NET API', repository_ids: [apiRepo.id] });
    expect(dotnetApi.status).toBe(201);
    expect(dotnetApi.data.repository_ids).toEqual([apiRepo.id]);
    const doc = await api('POST', '/documents', { scope_id: dotnetApi.data.id, kind: 'guidelines', title: 'API conventions' });
    await api('POST', `/documents/${doc.data.id}/sections`, { heading: 'Use minimal APIs', body: 'No controllers.', mode: 'propose' });

    expect((await api('POST', '/scopes', { project_id: projectId, name: 'Bad', repository_ids: ['00000000-0000-0000-0000-000000000000'] })).status).toBe(400);
    expect((await api('POST', '/scopes', { organization_id: o.logistics, name: 'Org bad', repository_ids: [apiRepo.id] })).status).toBe(400);

    const { client, call } = await mcp(t.jonas);
    const inApi = await call('get_context', { remote_url: API_REMOTE, path: 'src/Program.cs' });
    expect(inApi.text).toContain('Customer Portal › .NET API (repository "azure:acme/platform/customer-portal-api")');
    expect(inApi.text).toContain('Use minimal APIs');
    expect(inApi.text).not.toContain('Repository scopes left out');
    // The whole repository is covered, and a learning made in it lands in the bound scope.
    const learning = await call('propose_learning', {
      heading: 'Return problem details', body: 'RFC 9457.', rationale: 'Corrected.', remote_url: API_REMOTE, path: 'src/Endpoints/Orders.cs',
    });
    expect(learning.text).toContain('Customer Portal › .NET API');

    const inPortal = await call('get_context', { remote_url: SSH_REMOTE, path: 'src/Program.cs' });
    expect(inPortal.text).not.toContain('Use minimal APIs');
    const noRemote = await call('get_context', { project: 'logistics/customer-portal', path: 'src/Program.cs' });
    expect(noRemote.text).toContain('Repository scopes left out: ".NET API"');
    expect((await call('list_scopes', { project: 'logistics/customer-portal' })).text).toContain('azure:acme/platform/customer-portal-api');

    const unbound = await api('PATCH', `/scopes/${dotnetApi.data.id}`, { repository_ids: [] });
    expect(unbound.data.repository_ids).toEqual([]);
    expect((await call('get_context', { remote_url: API_REMOTE, path: 'src/Program.cs' })).text).not.toContain('Use minimal APIs');
    await api('DELETE', `/scopes/${dotnetApi.data.id}`);
    await client.close();
  });

  it('promotes a learning from one organization to the whole group', async () => {
    const lars = await mcp(t.lars);
    const r = await lars.call('propose_learning', {
      heading: 'Use Result<T> for expected failures', body: 'No exceptions for validation.', rationale: 'Ida said so.', level: 'organization',
    });
    expect(r.text).toContain('Learning proposed for **Acme Payments**');
    await lars.client.close();
    const p = (await api('GET', '/proposals?status=pending', undefined, { token: t.ida })).data.find((x: any) => x.heading.startsWith('Use Result'));
    expect(p.can_review).toBe(true);
    // Ida runs Payments but not the group, so she can't promote it.
    const denied = await api('POST', `/proposals/${p.id}/approve`, { target: { organization_id: null } }, { token: t.ida });
    expect(denied.status).toBe(403);
    const ok = await api('POST', `/proposals/${p.id}/approve`, { target: { organization_id: null } }, { token: t.groupEditor });
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
    expect((await api('GET', `/projects?organization_id=${o.payments}`, undefined, { token: t.anders })).status).toBe(403);

    // The link from Logistics to Payments shows the name only.
    const related = await call('get_related', { project: 'customer-portal' });
    expect(related.text).toContain('Payment Gateway (`payments/payment-gateway`)');
    expect(related.text).toContain("which you can't read");
    expect(related.text).not.toContain('Secret fraud rules');
    const graph = await api('GET', '/graph', undefined, { token: t.anders });
    const gw = graph.data.nodes.find((n: any) => n.label === 'Payment Gateway');
    expect(gw.restricted).toBe(true);
    expect(gw.summary).toBe('');
    // Payments → Logistics links are invisible to Logistics: they live in content Logistics can't read.
    expect(graph.data.edges.some((e: any) => e.source === gw.id)).toBe(false);

    // Grant Payments read access to Logistics.
    expect((await api('PUT', `/organizations/${o.logistics}/readers/${o.payments}`, { allowed: true }, { token: t.ida })).status).toBe(403);
    expect((await api('PUT', `/organizations/${o.logistics}/readers/${o.payments}`, { allowed: true })).status).toBe(200);
    const lars = await mcp(t.lars);
    const ctx = await lars.call('get_context', { project: 'logistics/customer-portal' });
    expect(ctx.isError).toBe(false);
    expect(ctx.text).toContain('Self-service portal');
    // Reading is not writing.
    const sid = /\[s:([0-9a-f]{8}) · propose\]/.exec(ctx.text.slice(ctx.text.indexOf('## Customer Portal')))![1];
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
    expect(me.data.agent_view.switchable_organization_ids).toEqual(expect.arrayContaining([o.logistics, o.payments]));
    expect(me.data.group.can_edit).toBe(false);
    // The server admin reads Payments, but a Logistics agent doesn't.
    expect((await api('GET', `/projects?organization_id=${o.payments}`, undefined, root)).status).toBe(200);
    expect((await api('GET', `/projects?organization_id=${o.payments}`, undefined, asLogisticsAgent)).status).toBe(403);
    const list = await api('GET', `/projects?organization_id=${o.logistics}`, undefined, asLogisticsAgent);
    const portal = list.data.find((p: any) => p.slug === 'customer-portal');
    const project = await api('GET', `/projects/${portal.id}`, undefined, asLogisticsAgent);
    expect(project.data.can_edit).toBe(false);
    // Nothing can be changed in agent mode.
    const write = await api('POST', '/projects', { organization_id: o.logistics, name: 'Nope' }, asLogisticsAgent);
    expect(write.status).toBe(403);
    expect(write.data.message).toContain('read-only');
    // ...but reading the context agents get (a POST with a body) works, as the agent would get it.
    const ctx = await api('POST', '/context', { project: 'logistics/customer-portal', path: 'frontend/src/app.ts' }, asLogisticsAgent);
    expect(ctx.status).toBe(200);
    // The agent console runs the real MCP read tools: the same text a Logistics agent gets.
    const args = { project: 'logistics/customer-portal', path: 'frontend/src/app.ts' };
    const tool = await api('POST', '/agent/tool', { name: 'get_context', args }, asLogisticsAgent);
    expect(tool.status).toBe(200);
    const { client, call } = await mcp(t.jonas);
    expect(tool.data).toEqual({ text: (await call('get_context', args)).text, is_error: false });
    await client.close();
    const hidden = await api('POST', '/agent/tool', { name: 'get_context', args: { project: 'payments/payment-gateway' } }, asLogisticsAgent);
    expect(hidden.data.is_error).toBe(true);
    expect((await api('POST', '/agent/tool', { name: 'update_section', args: {} }, asLogisticsAgent)).status).toBe(400);
    expect((await api('POST', '/agent/tool', { name: 'get_context', args }, root)).status).toBe(403);
    // Payments was granted read access to Logistics, so its agents read both.
    const asPaymentsAgent = await api('GET', '/me', undefined, { token: t.ida, org: o.payments, agent: true });
    expect(asPaymentsAgent.data.agent_view.readable_organization_ids).toEqual(expect.arrayContaining([o.logistics, o.payments]));
    // A Logistics viewer can't look through the eyes of a Payments agent, and agent mode needs an organization.
    const anders = await api('GET', '/me', undefined, { token: t.anders, org: o.payments, agent: true });
    expect(anders.data.agent_view?.organization_id).not.toBe(o.payments);
    expect((await api('GET', '/me', undefined, { token: ADMIN, agent: true })).status).toBe(400);
  });

  it('gives agents the endpoints and DTOs of attached API specs', async () => {
    const portal = (await api('GET', `/projects?organization_id=${o.logistics}`)).data.find((p: any) => p.slug === 'customer-portal');
    const gateway = (await api('GET', `/projects?organization_id=${o.payments}`)).data.find((p: any) => p.slug === 'payment-gateway');
    // Editors attach specs; viewers and agents can't.
    expect((await api('POST', `/projects/${portal.id}/apis`, { content: JSON.stringify(ORDER_API) }, { token: t.anders })).status).toBe(403);
    expect((await api('POST', `/projects/${portal.id}/apis`, { content: 'openapi: 3.0.0\ninfo: {}' })).status).toBe(400);
    const added = await api('POST', `/projects/${portal.id}/apis`, { content: JSON.stringify(ORDER_API), filename: 'order-api.json' });
    expect(added.status).toBe(201);
    expect(added.data).toMatchObject({ name: 'Order Service API', version: '1.4.0', endpoint_count: 5, schema_count: 9, source_format: 'json' });
    const billing = await api('POST', `/projects/${gateway.id}/apis`, { name: 'Billing', content: BILLING_SWAGGER_YAML, filename: 'billing.yaml' }, { token: t.ida });
    expect(billing.data).toMatchObject({ name: 'Billing', spec_version: 'Swagger 2.0', source_format: 'yaml' });
    expect((await api('GET', `/projects/${portal.id}`)).data.apis).toHaveLength(1);

    // The agent sees the API in its context and reads it with get_api.
    const jonas = await mcp(t.jonas);
    const ctx = await jonas.call('get_context', { remote_url: SSH_REMOTE });
    expect(ctx.text).toContain('## APIs');
    expect(ctx.text).toContain('- **Order Service API** 1.4.0 (OpenAPI 3.0.3, 5 endpoints, 9 schemas): `get_api project="logistics/customer-portal"`');
    expect(ctx.text).not.toContain('Billing'); // Payments is private to Logistics
    const overview = await jonas.call('get_api', { remote_url: HTTPS_REMOTE });
    expect(overview.text).toContain('- `POST /orders` — Create an order (body: CreateOrderRequest) → 201 OrderDto');
    const endpoint = await jonas.call('get_api', { project: 'customer-portal', endpoint: 'post /orders' });
    expect(endpoint.text).toContain('interface CreateOrderRequest {');
    expect(endpoint.text).toContain('interface Money {');
    const schema = await jonas.call('get_api', { project: 'customer-portal', schema: 'OrderStatus' });
    expect(schema.text).toContain('type OrderStatus = ');
    expect((await jonas.call('get_api', { project: 'payments/payment-gateway' })).isError).toBe(true);
    await jonas.client.close();

    // Payments reads Logistics, so its agent sees the portal's API as a related project's.
    const lars = await mcp(t.lars);
    const larsCtx = await lars.call('get_context', { project: 'payment-gateway' });
    expect(larsCtx.text).toContain('- **Billing** 2.1 (Swagger 2.0, 2 endpoints, 2 schemas): `get_api project="payments/payment-gateway" api="Billing"`');
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
      if (served === null) { res.statusCode = 503; res.end('down'); return; }
      res.setHeader('content-type', 'application/yaml');
      res.end(served);
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/swagger.yaml`;
    const fromUrl = await api('POST', `/projects/${portal.id}/apis`, { name: 'Billing mirror', url });
    expect(fromUrl.status).toBe(201);
    expect(fromUrl.data).toMatchObject({ source_url: url, endpoint_count: 2, fetch_error: null });
    expect(fromUrl.data.fetched_at).toBeTruthy();
    served = BILLING_SWAGGER_YAML.replace('definitions:', `  /invoices/{invoiceNo}/pdf:
    get:
      operationId: getInvoicePdf
      responses:
        "200":
          description: PDF
definitions:`);
    expect((await api('POST', `/apis/${fromUrl.data.id}/refresh`)).data.endpoint_count).toBe(3);
    served = null;
    const failed = await api('POST', `/apis/${fromUrl.data.id}/refresh`);
    expect(failed.status).toBe(200);
    expect(failed.data.fetch_error).toContain('503');
    expect(failed.data.endpoint_count).toBe(3);
    http.close();
    expect((await api('POST', `/projects/${portal.id}/apis`, { url: 'file:///etc/passwd' })).status).toBe(400);
    // Two APIs on one project: agents pick one by name.
    const jonas2 = await mcp(t.jonas);
    expect((await jonas2.call('get_api', { project: 'customer-portal' })).text).toContain('has 2 APIs');
    expect((await jonas2.call('get_api', { project: 'customer-portal', api: 'billing mirror', endpoint: 'getInvoicePdf' })).text).toContain('getInvoicePdf');
    await jonas2.client.close();
    expect((await api('DELETE', `/apis/${fromUrl.data.id}`)).status).toBe(204);
  });

  it('resolves the same slug per organization', async () => {
    await api('POST', '/projects', { organization_id: o.logistics, name: 'API', slug: 'api' });
    await api('POST', '/projects', { organization_id: o.payments, name: 'API', slug: 'api', purpose: 'Payments API' });
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
    expect((await call('update_section', { section_id: locked.id.slice(0, 8), body: 'x', reason: 'x' })).text).toContain('locked');
    expect((await call('update_section', { section_id: proposeSection.id, body: 'Customer = paying account.', reason: 'x' })).text).toContain('Proposed for review');
    await api('PATCH', `/sections/${proposeSection.id}`, { mode: 'open' });
    expect((await call('update_section', { section_id: proposeSection.id, body: 'Customer = paying account.', reason: 'x' })).text).toContain('Applied');
    expect((await api('PATCH', `/sections/${proposeSection.id}`, { mode: 'locked' }, { token: t.jonas })).status).toBe(403);
    // Group-wide content: agents may propose (mode decides), viewers may not.
    const groupGuidelines = (await api('GET', '/documents?organization_id=group')).data.find((d: any) => d.kind === 'guidelines');
    expect((await call('add_section', { document_id: groupGuidelines.id, heading: 'Idea', body: 'x', reason: 'y' })).text).toContain('Proposed');
    expect((await api('POST', `/documents/${groupGuidelines.id}/sections`, { heading: 'x' }, { token: t.anders })).status).toBe(403);
    await client.close();
  });

  it('detects concurrent edits and restores versions', async () => {
    const docs = await api('GET', `/documents?organization_id=${o.logistics}`);
    const s = (await api('GET', `/documents/${docs.data[1].id}`)).data.sections[0];
    const stale = await api('PATCH', `/sections/${s.id}`, { body: 'x', expected_version: s.version - 1 });
    expect(stale.status).toBe(409);
    const r = await api('POST', `/sections/${s.id}/revert`, { version: 1 });
    expect(r.data.body).toContain('Define the terms');
  });

  it('links projects and terms across the group', async () => {
    await api('POST', '/projects', { organization_id: o.logistics, name: 'Billing Service', purpose: 'Charges through [[payments/payment-gateway]].' });
    const glossary = await api('POST', '/documents', { kind: 'glossary', title: 'Group glossary' });
    await api('POST', `/documents/${glossary.data.id}/sections`, { heading: 'Order', body: 'A confirmed purchase.' });
    const local = await api('POST', '/documents', { organization_id: o.payments, kind: 'glossary', title: 'Glossary' });
    await api('POST', `/documents/${local.data.id}/sections`, { heading: 'Order', body: 'In Payments: a charge request.' });

    const g = await api('GET', '/graph');
    const label = (id: string) => g.data.nodes.find((n: any) => n.id === id)?.label;
    const edges = g.data.edges.filter((e: any) => e.kind === 'link').map((e: any) => `${label(e.source)} -> ${label(e.target)}`).sort();
    expect(edges).toEqual([
      'Billing Service -> Payment Gateway',
      'Customer Portal -> Billing Service',
      'Customer Portal -> Order',
      'Customer Portal -> Payment Gateway',
      'Payment Gateway -> Customer Portal',
    ]);
    // [[term:Order]] from Logistics resolves to the group term, not Payments' local one.
    const order = g.data.edges.find((e: any) => label(e.source) === 'Customer Portal' && label(e.target) === 'Order');
    expect(g.data.nodes.find((n: any) => n.id === order.target).organization_id).toBeNull();
    const nav = await api('GET', `/links/resolve?target=${encodeURIComponent('term:Order')}&from_organization=${o.payments}`);
    expect(nav.data.heading).toBe('Order');
    expect((await api('GET', `/documents/${nav.data.document_id}`)).data.organization_id).toBe(o.payments);
  });

  it('renames slugs throughout, keeping the old ones as aliases', async () => {
    const treasury = (await api('POST', '/organizations', { name: 'Acme Treasury', slug: 'treasury' })).data.id;
    const ledger = (await api('POST', '/projects', { organization_id: treasury, name: 'General Ledger', slug: 'ledger' })).data;
    expect(ledger.slug).toBe('ledger');
    const mk = async (body: object) => (await api('POST', '/members', body)).data.token as string;
    const tove = await mk({ name: 'Tove', kind: 'human', organization_id: treasury, role: 'editor' });
    const bot = await mk({ name: 'Treasury bot', kind: 'agent', organization_id: treasury });
    const section = async (level: object, title: string, body: string) => {
      const doc = (await api('POST', '/documents', { ...level, kind: 'reference', title })).data;
      return (await api('POST', `/documents/${doc.id}/sections`, { heading: title, body })).data.section;
    };
    const own = await section({ organization_id: treasury }, 'Notes', 'Post to [[ledger]], see [[General Ledger|the books]] and `[[ledger]]`.');
    const shared = await section({}, 'Group notes', 'Treasury keeps [[treasury/ledger#Auth|its ledger]].');

    // The preview says what changes and what can't, and changes nothing.
    const preview = await api('POST', `/projects/${ledger.id}/rename`, { slug: 'books', dry_run: true }, { token: tove });
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ from: 'ledger', to: 'books', applied: false, alias_of: null });
    expect(preview.data.rewrite.map((r: any) => [r.heading, r.links])).toEqual([['Notes', 1]]);
    expect(preview.data.cannot_edit.map((r: any) => r.heading)).toEqual(['Group notes']);
    expect((await api('GET', `/projects/${ledger.id}`)).data.slug).toBe('ledger');

    const done = await api('POST', `/projects/${ledger.id}/rename`, { slug: 'books' }, { token: tove });
    expect(done.data.applied).toBe(true);
    expect((await api('GET', `/sections/${own.id}`)).data.body).toBe('Post to [[books]], see [[General Ledger|the books]] and `[[ledger]]`.');
    expect((await api('GET', `/sections/${own.id}/versions`)).data[0].note).toBe('Renamed ledger to books');
    expect((await api('GET', `/sections/${shared.id}`)).data.body).toContain('[[treasury/ledger#Auth|its ledger]]');
    expect((await api('GET', `/projects/${ledger.id}`)).data.aliases.map((x: any) => x.old_slug)).toEqual(['ledger']);

    // The old slug still works for links, people and agents, and agents are told to update it.
    const g = await api('GET', '/graph');
    expect(g.data.edges.some((e: any) => e.source === 'group' && e.target === `project:${ledger.id}`)).toBe(true);
    expect((await api('GET', '/projects/treasury%2Fledger')).data.id).toBe(ledger.id);
    const { client, call } = await mcp(bot);
    const ctx = await call('get_context', { project: 'treasury/ledger' });
    expect(ctx.text).toContain('`treasury/ledger` is an old slug of this project.** Use `treasury/books`');

    // Renaming the organization rewrites org/… links.
    await api('POST', `/organizations/${treasury}/rename`, { slug: 'vault' });
    expect((await api('GET', `/sections/${shared.id}`)).data.body).toBe('Treasury keeps [[vault/ledger#Auth|its ledger]].');
    expect((await call('get_context', { project: 'treasury/books' })).isError).toBe(false);

    // Reusing an old slug is refused until the caller says to take it over.
    const reuse = await api('POST', '/projects', { organization_id: treasury, name: 'Ledger' });
    expect(reuse.status).toBe(409);
    expect(reuse.data.alias_of).toMatchObject({ id: ledger.id, slug: 'books' });
    const taken = await api('POST', '/projects', { organization_id: treasury, name: 'Ledger', take_alias: true });
    expect(taken.status).toBe(201);
    expect((await api('GET', '/projects/vault%2Fledger')).data.id).toBe(taken.data.id);
    expect((await api('GET', `/projects/${ledger.id}`)).data.aliases).toEqual([]);

    // Scopes: a PATCH keeps an alias too, and get_context accepts the old slug.
    const scope = (await api('POST', '/scopes', { project_id: ledger.id, name: 'UI', slug: 'ui' })).data;
    await api('PATCH', `/scopes/${scope.id}`, { slug: 'frontend' }, { token: tove });
    const scoped = await call('get_context', { project: 'vault/books', scopes: ['ui'] });
    expect(scoped.text).toContain('requested explicitly by its old slug "ui"; use "frontend"');
    const alias = (await api('GET', `/scopes/${scope.id}`)).data.aliases[0];
    expect((await api('DELETE', `/aliases/${alias.id}`, undefined, { token: tove })).status).toBe(204);
    expect((await call('get_context', { project: 'vault/books', scopes: ['ui'] })).text).not.toContain('old slug "ui"');
    await client.close();
  });

  it('isolates groups from each other with row-level security', async () => {
    const g2 = await api('POST', '/groups', { name: 'Other Corp', organization_name: 'Other', admin_name: 'Olga' });
    expect(g2.status).toBe(201);
    const olga: Who = { token: g2.data.token };
    expect((await api('POST', '/groups', { name: 'x', organization_name: 'y' }, olga)).status).toBe(403);
    // The same repository can exist in another group.
    const p2 = await api('POST', '/projects', { name: 'Customer Portal', remote_url: HTTPS_REMOTE }, olga);
    expect(p2.status).toBe(201);
    expect((await api('GET', `/projects/${projectId}`, undefined, olga)).status).toBe(404);
    expect((await api('GET', '/projects', undefined, olga)).data.map((p: any) => p.id)).toEqual([p2.data.id]);
    expect((await api('GET', '/search?q=undoable', undefined, olga)).data).toEqual([]);
    expect((await api('GET', '/me', undefined, { ...olga, group: 'acme-group' })).status).toBe(403);
    // The server admin can switch between groups.
    expect((await api('GET', '/projects', undefined, { token: ADMIN, group: g2.data.group.slug })).data.length).toBe(1);

    // Straight at the database: a transaction scoped to one group cannot see the other's rows,
    // and a connection with no group sees nothing.
    const count = (groupId: string | null) => withScope(pool, { groupId }, async (c) =>
      (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM projects')).rows[0].n);
    expect(await count(g2.data.group.id)).toBe(1);
    expect(await count(null)).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM sections')).rows[0].n).toBe(0);
    // Writing into another group is refused too.
    await expect(withScope(pool, { groupId: g2.data.group.id }, (c) =>
      c.query(`UPDATE projects SET name = 'hijacked' WHERE id = $1 RETURNING id`, [projectId]).then((r) => r.rowCount))).resolves.toBe(0);
  });

  it('runs a pull-request style review between a person and an agent', async () => {
    const jonas = await mcp(t.jonas);
    await jonas.call('propose_learning', {
      heading: 'Dates are shown in the user\'s time zone',
      body: 'Format every date with `formatLocal()`.\nNever show UTC to customers.\nStore dates in UTC.',
      rationale: 'User saw UTC times in the booking list.',
      remote_url: HTTPS_REMOTE, path: 'frontend/src/app/booking/list.ts',
    });
    const p = (await api('GET', '/proposals?status=pending')).data.find((x: any) => x.heading.startsWith('Dates are shown'));
    expect(p.revision).toBe(1);
    expect(p.awaiting).toBe('review');

    // A reviewer comments on line 2 with a suggestion, and starts a general thread.
    const line = await api('POST', `/proposals/${p.id}/comments`, {
      body: 'Customers in Norway see this too; be explicit.', line_start: 2, line_end: 2,
      suggestion: 'Never show UTC to customers, wherever they are.',
    });
    expect(line.status).toBe(201);
    expect(line.data.anchor).toBe('Never show UTC to customers.');
    const general = await api('POST', `/proposals/${p.id}/comments`, { body: 'Which helper formats durations?' });
    expect(general.data.line_start).toBeNull();
    expect((await api('POST', `/proposals/${p.id}/comments`, { body: 'x', line_start: 9, line_end: 9 })).data.message).toContain('between 1 and 3');
    // Viewers can't comment; agents of another organization can't either.
    expect((await api('POST', `/proposals/${p.id}/comments`, { body: 'x' }, { token: t.anders })).status).toBe(403);
    const changes = await api('POST', `/proposals/${p.id}/request-changes`, { note: 'Please answer the question.' });
    expect(changes.data.status).toBe('changes_requested');
    expect((await api('GET', `/proposals/${p.id}`)).data.awaiting).toBe('author');

    // The agent learns about it from get_context, reads the review and answers.
    const ctx = await jonas.call('get_context', { remote_url: HTTPS_REMOTE });
    expect(ctx.text).toContain('## Review feedback waiting on you');
    expect(ctx.text).toContain(p.id);
    const reviewText = (await jonas.call('get_review', { proposal_id: p.id })).text;
    expect(reviewText).toContain('  2 | Never show UTC to customers.');
    expect(reviewText).toContain('Last verdict: changes requested by Admin: "Please answer the question."');
    const suggestionId = /apply_suggestion comment_id=([0-9a-f-]{36})/.exec(reviewText)![1];
    const reply = await jonas.call('reply_to_review', { proposal_id: p.id, thread_id: general.data.id, body: '`formatDuration()` in the same file.', resolve: true });
    expect(reply.text).toContain('resolved');
    expect((await jonas.call('apply_suggestion', { comment_id: suggestionId })).text).toContain('revision 2');
    const rev = await jonas.call('revise_proposal', {
      proposal_id: p.id, note: 'Mention durations',
      body: 'Format every date with `formatLocal()` and durations with `formatDuration()`.\nNever show UTC to customers, wherever they are.\nStore dates in UTC.',
    });
    expect(rev.text).toContain('revision 3');
    expect(rev.text).toContain('pending');
    const mine = JSON.parse((await jonas.call('list_my_proposals', {})).text);
    expect(mine.find((x: any) => x.id === p.id).next_move).toBe('reviewers');
    expect((await jonas.call('get_context', { remote_url: HTTPS_REMOTE })).text).not.toContain('waiting on you');

    // The reviewer sees the whole history.
    const r = (await api('GET', `/proposals/${p.id}/review`)).data;
    expect(r.revisions.map((x: any) => x.revision)).toEqual([1, 2, 3]);
    expect(r.events.map((e: any) => e.kind)).toEqual(['proposed', 'changes_requested', 'revised', 'revised']);
    expect(r.threads.every((th: any) => th.resolved_at)).toBe(true);
    const lineThread = r.threads.find((th: any) => th.line_start !== null);
    expect(lineThread.comments[0].applied_at).toBeTruthy();
    expect(lineThread.line_start).toBe(2);
    expect(lineThread.outdated).toBe(true); // its original line now reads differently

    // A stale suggestion can't be applied blindly.
    const stale = await api('POST', `/proposals/${p.id}/comments`, { body: 'b', line_start: 3, line_end: 3, suggestion: 'Store dates in UTC, always.' });
    await jonas.call('revise_proposal', { proposal_id: p.id, note: 'shorter', body: 'Use `formatLocal()` and `formatDuration()`.\nNever show UTC.\nUTC in storage.' });
    const applyStale = await api('POST', `/comments/${stale.data.comments[0].id}/apply`);
    expect(applyStale.status).toBe(409);

    // Approving from the inbox still works and closes the loop.
    const ok = await api('POST', `/proposals/${p.id}/approve`, {});
    expect(ok.status).toBe(200);
    const done = (await api('GET', `/proposals/${p.id}/review`)).data;
    expect(done.events.at(-1).kind).toBe('approved');
    expect(done.can_revise).toBe(false);
    expect((await api('POST', `/proposals/${p.id}/revisions`, { body: 'late' }, { token: t.jonas })).status).toBe(409);
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
    expect((await api('DELETE', `/me/tokens/${others.data[0].id}`, undefined, who)).status).toBe(404);
    expect((await api('DELETE', `/me/tokens/${list.data[1].id}`, undefined, who)).status).toBe(204);
    expect((await api('GET', '/me', undefined, second)).status).toBe(401);
    expect((await api('POST', '/me/tokens', {}, { token: t.lars })).status).toBe(403);
  });

  it('keeps viewers read-only and revokes tokens', async () => {
    expect((await api('GET', '/projects', undefined, { token: t.anders })).status).toBe(200);
    expect((await api('POST', '/projects', { name: 'Nope', organization_id: o.logistics }, { token: t.anders })).status).toBe(403);
    const members = await api('GET', '/members');
    const jonas = members.data.find((m: any) => m.name === 'Agent Jonas');
    expect((await api('DELETE', `/tokens/${jonas.tokens[0].id}`)).status).toBe(204);
    expect((await api('GET', '/me', undefined, { token: t.jonas })).status).toBe(401);
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
      oldDoc: (await q.query(`SELECT organization_id IS NOT NULL AS ok FROM documents WHERE title = 'Old guidelines'`)).rows[0].ok,
      groupDocs: (await q.query('SELECT count(*)::int AS n FROM documents WHERE organization_id IS NULL')).rows[0].n,
      roles: (await q.query(`SELECT a.name, a.is_superadmin, m.role, m.organization_id IS NULL AS group_level
                               FROM memberships m JOIN actors a ON a.id = m.actor_id ORDER BY a.name`)).rows,
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
