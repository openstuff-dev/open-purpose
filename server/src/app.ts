import fs from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type pg from 'pg';
import { z, ZodError } from 'zod';
import { Access, actorFromToken, agentViewOf, bearer, canViewAsAgent, groupsOf, resolveAccess, type Actor } from './auth.js';
import type { Config } from './config.js';
import { beginScope, endScope, type Pool } from './db.js';
import { AppError, badRequest } from './errors.js';
import { createMcpServer } from './mcp.js';
import * as admin from './service/admin.js';
import * as apis from './service/apis.js';
import * as content from './service/content.js';
import { buildContext } from './service/context.js';
import { backlinks, buildGraph, focusGraph, projectNode, resolveLink, trimRefs } from './service/graph.js';
import * as projects from './service/projects.js';
import * as proposals from './service/proposals.js';
import * as review from './service/review.js';
import { DOC_KINDS, EDIT_MODES } from './service/types.js';

export const VERSION = '0.2.0';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
    access: Access;
    db: pg.PoolClient;
    scopeOpen: boolean;
    /** The person behind an agent-mode request (req.access is then the simulated agent). */
    person: Access | null;
  }
  interface FastifyContextConfig {
    /** Server-level route: authenticated, but not scoped to a group. */
    serverLevel?: boolean;
    /** A POST that only reads (e.g. /context takes a body), so agent mode allows it. */
    readOnly?: boolean;
  }
}

const mode = z.enum(EDIT_MODES as [string, ...string[]]).transform((m) => m as (typeof EDIT_MODES)[number]);
const kind = z.enum(DOC_KINDS as [string, ...string[]]).transform((k) => k as (typeof DOC_KINDS)[number]);
const id = z.string().uuid();
const optId = id.nullable().optional();
const role = z.enum(['admin', 'editor', 'viewer', 'agent']);
const manifest = z.object({ path: z.string(), content: z.string() });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value ?? {});
}

/** Query-string id: "", "null" and "group" mean "none" (the group level). */
const qid = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '' || v === 'null' || v === 'group') return null;
  return String(v);
};

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v || undefined;
};

export async function buildApp(pool: Pool, config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 5 * 1024 * 1024 });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'bad_request', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Internal server error' });
  });

  app.decorateRequest('actor', null as unknown as Actor);
  app.decorateRequest('access', null as unknown as Access);
  app.decorateRequest('db', null as unknown as pg.PoolClient);
  app.decorateRequest('scopeOpen', false);
  app.decorateRequest('person', null);

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, version: VERSION };
  });

  // ───────────────────────────── MCP (streamable HTTP, stateless) ─────────────────────────────
  app.post('/mcp', async (req, reply) => {
    let access: Access;
    try {
      const actor = await actorFromToken(pool, bearer(req.headers.authorization));
      access = await resolveAccess(pool, actor, header(req, 'x-openpurpose-group'), header(req, 'x-openpurpose-org'));
    } catch (e) {
      const status = e instanceof AppError ? e.status : 401;
      return reply.status(status).header('WWW-Authenticate', 'Bearer').send({
        jsonrpc: '2.0', error: { code: -32001, message: (e as Error).message }, id: null,
      });
    }
    const server = createMcpServer(pool, access, VERSION, config.apiSpecs);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.status(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server; use POST)' }, id: null });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // ───────────────────────────── REST API ─────────────────────────────
  await app.register(async (api) => {
    // Every group-level request runs in one transaction that row-level security scopes to the caller's group.
    api.addHook('preHandler', async (req) => {
      req.actor = await actorFromToken(pool, bearer(req.headers.authorization));
      if (req.routeOptions.config.serverLevel) return;
      req.access = await resolveAccess(pool, req.actor, header(req, 'x-openpurpose-group'), header(req, 'x-openpurpose-org'));
      // Agent mode: answer as an agent in the chosen organization would see it. Read-only.
      if (header(req, 'x-openpurpose-agent-view') === '1' && !req.access.isAgent) {
        if (req.method !== 'GET' && req.method !== 'HEAD' && !req.routeOptions.config.readOnly) {
          throw new AppError('forbidden', 'Agent mode is read-only. Turn it off to make changes.');
        }
        req.person = req.access;
        req.access = agentViewOf(req.access);
      }
      req.db = await beginScope(pool, { groupId: req.access.group.id });
      req.scopeOpen = true;
    });
    const close = async (req: FastifyRequest, ok: boolean) => {
      if (!req.scopeOpen) return;
      req.scopeOpen = false;
      await endScope(req.db, ok);
    };
    api.addHook('onSend', async (req, reply, payload) => {
      await close(req, reply.statusCode < 400);
      return payload;
    });
    api.addHook('onResponse', async (req) => close(req, false));
    api.addHook('onRequestAbort', async (req) => close(req, false));

    const server = { config: { serverLevel: true } };

    // who am I
    api.get('/me', async (req) => {
      const a = req.access;
      return {
        actor: req.actor,
        groups: await groupsOf(pool, req.actor),
        group: { ...a.group, role: a.groupRole, can_admin: a.canAdmin(null), can_edit: a.canEdit(null) },
        organizations: await admin.listOrganizations(req.db, a),
        current_organization_id: a.orgId,
        /** Set in agent mode: which agent is simulated, and which organizations the person may simulate. */
        agent_view: req.person ? {
          organization_id: a.orgId,
          readable_organization_ids: a.readableOrgIds(),
          switchable_organization_ids: req.person.orgs.filter((o) => !o.archived_at && canViewAsAgent(req.person!, o.id)).map((o) => o.id),
        } : null,
        pending_proposals: await proposals.countReviewable(req.db, a),
        public_url: config.publicUrl,
        version: VERSION,
      };
    });

    // your own account
    api.patch('/me', async (req) => {
      const body = parse(z.object({ name: z.string().min(1).max(200) }), req.body);
      await pool.query('UPDATE actors SET name = $2 WHERE id = $1', [req.actor.id, body.name.trim()]);
      return { ok: true };
    });
    api.get('/me/tokens', async (req) => admin.myTokens(pool, req.actor));
    api.post('/me/tokens', async (req, reply) => {
      const body = parse(z.object({ label: z.string().max(100).optional() }), req.body);
      return reply.status(201).send({ token: await admin.issueOwnToken(pool, req.actor, body.label ?? '') });
    });
    api.delete('/me/tokens/:id', async (req, reply) => {
      await admin.revokeOwnToken(pool, req.actor, (req.params as { id: string }).id);
      return reply.status(204).send();
    });

    // groups (server admins)
    api.get('/groups', server, async (req) => admin.listGroups(pool, req.actor));
    api.post('/groups', server, async (req, reply) => {
      const body = parse(z.object({
        name: z.string().min(1), slug: z.string().optional(), organization_name: z.string().min(1),
        organization_slug: z.string().optional(), admin_name: z.string().optional(),
      }), req.body);
      return reply.status(201).send(await admin.createGroup(pool, req.actor, body));
    });
    api.put('/group', async (req) => {
      await admin.renameGroup(req.db, req.access, parse(z.object({ name: z.string().min(1).max(200) }), req.body).name);
      return { ok: true };
    });

    // organizations
    api.get('/organizations', async (req) => admin.listOrganizations(req.db, req.access));
    api.post('/organizations', async (req, reply) => {
      const body = parse(z.object({ name: z.string().min(1), slug: z.string().optional(), summary: z.string().optional() }), req.body);
      return reply.status(201).send(await admin.createOrganization(req.db, req.access, body));
    });
    api.patch('/organizations/:id', async (req) => {
      const body = parse(z.object({ name: z.string().min(1).optional(), slug: z.string().optional(), summary: z.string().optional(), archived: z.boolean().optional() }), req.body);
      return admin.updateOrganization(req.db, req.access, (req.params as { id: string }).id, body);
    });
    api.put('/organizations/:id/readers/:reader', async (req) => {
      const p = req.params as { id: string; reader: string };
      const body = parse(z.object({ allowed: z.boolean() }), req.body);
      await admin.setReadGrant(req.db, req.access, p.reader, p.id, body.allowed);
      return { ok: true };
    });

    // projects
    api.get('/projects', async (req) => {
      const q = req.query as { q?: string; archived?: string; organization_id?: string };
      return projects.listProjects(req.db, req.access, {
        q: q.q, includeArchived: q.archived === '1' || q.archived === 'true', organizationId: qid(q.organization_id),
      });
    });
    api.post('/projects', async (req, reply) => {
      const body = parse(z.object({
        organization_id: optId, name: z.string().min(1), slug: z.string().optional(), summary: z.string().optional(),
        purpose: z.string().optional(), remote_url: z.string().optional(),
      }), req.body);
      return reply.status(201).send(await projects.createProject(req.db, req.access, body));
    });
    api.get('/projects/:id', async (req) => {
      const a = req.access;
      const p = await projects.getProject(req.db, a, decodeURIComponent((req.params as { id: string }).id));
      const level = { organization_id: p.organization_id, project_id: p.id };
      const repositories = await projects.listRepositories(req.db, p.id);
      const scopes = await content.listScopes(req.db, a, level);
      const documents = await content.listDocuments(req.db, a, { ...level, scope_id: null });
      const org = a.org(p.organization_id)!;
      const apiSpecs = await apis.listApis(req.db, a, p.id);
      return { ...p, organization: { id: org.id, slug: org.slug, name: org.name }, can_edit: a.canEdit(p.organization_id), repositories, scopes, documents, apis: apiSpecs };
    });
    api.patch('/projects/:id', async (req) => {
      const body = parse(z.object({
        name: z.string().min(1).optional(), slug: z.string().optional(), summary: z.string().optional(),
        reviewed: z.boolean().optional(), archived: z.boolean().optional(), organization_id: id.optional(),
      }), req.body);
      return projects.updateProject(req.db, req.access, (req.params as { id: string }).id, body);
    });
    api.delete('/projects/:id', async (req, reply) => {
      await projects.deleteProject(req.db, req.access, (req.params as { id: string }).id);
      return reply.status(204).send();
    });
    api.post('/projects/:id/repositories', async (req, reply) => {
      const body = parse(z.object({ remote_url: z.string().min(1) }), req.body);
      return reply.status(201).send(await projects.addRepository(req.db, req.access, (req.params as { id: string }).id, body.remote_url));
    });
    api.delete('/repositories/:id', async (req, reply) => {
      await projects.deleteRepository(req.db, req.access, (req.params as { id: string }).id);
      return reply.status(204).send();
    });

    // API specs (OpenAPI / Swagger) per project
    const apiInput = z.object({
      name: z.string().max(200).optional(),
      url: z.string().max(2000).optional(),
      filename: z.string().max(300).optional(),
      content: z.string().optional(),
    });
    // Uploaded specs travel as JSON strings, so allow some headroom over the spec limit.
    const specBody = { bodyLimit: Math.ceil(config.apiSpecs.maxBytes * 1.2) + 65536 };
    const apiId = (req: FastifyRequest) => (req.params as { id: string }).id;
    api.get('/projects/:id/apis', async (req) => apis.listApis(req.db, req.access, apiId(req)));
    api.post('/projects/:id/apis', specBody, async (req, reply) =>
      reply.status(201).send(await apis.addApi(req.db, req.access, apiId(req), parse(apiInput, req.body), config.apiSpecs)));
    api.get('/apis/:id', async (req) => {
      const { meta, api: spec } = await apis.loadApi(req.db, req.access, apiId(req));
      const p = await projects.getProject(req.db, req.access, meta.project_id);
      return {
        ...meta,
        can_edit: req.access.canEdit(p.organization_id),
        description: spec.description,
        servers: spec.servers,
        operations: spec.operations.map((o) => ({ key: o.key, method: o.method, path: o.path, summary: o.summary, operation_id: o.operationId, tags: o.tags, deprecated: o.deprecated })),
        schemas: Object.keys(spec.schemas),
      };
    });
    // The exact text agents get from get_api, for previews in the UI.
    api.get('/apis/:id/text', async (req) => {
      const q = parse(z.object({ endpoint: z.string().optional(), schema: z.string().optional(), search: z.string().optional(), tag: z.string().optional() }), req.query);
      const { meta, api: spec } = await apis.loadApi(req.db, req.access, apiId(req));
      const p = await projects.getProject(req.db, req.access, meta.project_id);
      return { text: apis.renderApiText(meta, spec, `${req.access.org(p.organization_id)?.slug}/${p.slug}`, q) };
    });
    api.get('/apis/:id/raw', async (req, reply) => {
      const { meta, raw } = await apis.loadApi(req.db, req.access, apiId(req));
      const name = (meta.filename ?? `${meta.name || 'openapi'}.json`).replace(/\.ya?ml$/i, '.json').replace(/[^\w.-]+/g, '-');
      return reply.header('content-disposition', `attachment; filename="${name}"`).type('application/json').send(JSON.stringify(raw, null, 2));
    });
    api.patch('/apis/:id', specBody, async (req) => apis.updateApi(req.db, req.access, apiId(req), parse(apiInput, req.body), config.apiSpecs));
    api.post('/apis/:id/refresh', async (req) => apis.refreshApi(req.db, req.access, apiId(req), config.apiSpecs));
    api.delete('/apis/:id', async (req, reply) => {
      await apis.deleteApi(req.db, req.access, apiId(req));
      return reply.status(204).send();
    });

    // scopes
    const scopeBody = z.object({
      name: z.string().min(1), slug: z.string().optional(), description: z.string().optional(),
      path_globs: z.array(z.string()).optional(), stacks: z.array(z.string()).optional(), position: z.number().int().optional(),
    });
    api.get('/scopes', async (req) => {
      const q = req.query as { organization_id?: string; project_id?: string };
      return content.listScopes(req.db, req.access, { organization_id: qid(q.organization_id), project_id: qid(q.project_id) });
    });
    api.post('/scopes', async (req, reply) => {
      const body = parse(scopeBody.extend({ organization_id: optId, project_id: optId }), req.body);
      return reply.status(201).send(await content.createScope(req.db, req.access, body, body));
    });
    api.get('/scopes/:id', async (req) => {
      const a = req.access;
      const scope = await content.getScope(req.db, a, (req.params as { id: string }).id);
      const documents = await content.listDocuments(req.db, a, { scope_id: scope.id });
      const project = scope.project_id ? await projects.getProject(req.db, a, scope.project_id) : null;
      const org = a.org(scope.organization_id);
      return { ...scope, documents, project, organization: org && { id: org.id, slug: org.slug, name: org.name }, can_edit: a.canEdit(scope.organization_id) };
    });
    api.patch('/scopes/:id', async (req) => content.updateScope(req.db, req.access, (req.params as { id: string }).id, parse(scopeBody.partial(), req.body)));
    api.delete('/scopes/:id', async (req, reply) => {
      await content.deleteScope(req.db, req.access, (req.params as { id: string }).id);
      return reply.status(204).send();
    });

    // documents
    api.get('/documents', async (req) => {
      const q = req.query as { organization_id?: string; project_id?: string; scope_id?: string };
      return content.listDocuments(req.db, req.access, {
        organization_id: qid(q.organization_id), project_id: qid(q.project_id), scope_id: qid(q.scope_id),
      });
    });
    api.post('/documents', async (req, reply) => {
      const body = parse(z.object({
        organization_id: optId, project_id: optId, scope_id: optId, kind, title: z.string().min(1),
        slug: z.string().optional(), mode: mode.optional(), position: z.number().int().optional(),
      }), req.body);
      return reply.status(201).send(await content.createDocument(req.db, req.access, body, body));
    });
    api.get('/documents/:id', async (req) => {
      const a = req.access;
      const doc = await content.getDocument(req.db, a, (req.params as { id: string }).id);
      const sections = await content.listSections(req.db, [doc.id]);
      const project = doc.project_id ? await projects.getProject(req.db, a, doc.project_id) : null;
      const scope = doc.scope_id ? await content.getScope(req.db, a, doc.scope_id) : null;
      const org = a.org(doc.organization_id);
      return {
        ...doc, sections, project, scope, organization: org && { id: org.id, slug: org.slug, name: org.name },
        can_edit: a.canEdit(doc.organization_id),
      };
    });
    api.patch('/documents/:id', async (req) => {
      const body = parse(z.object({
        title: z.string().min(1).optional(), slug: z.string().optional(), mode: mode.optional(),
        position: z.number().int().optional(), kind: kind.optional(),
      }), req.body);
      return content.updateDocument(req.db, req.access, (req.params as { id: string }).id, body);
    });
    api.delete('/documents/:id', async (req, reply) => {
      await content.deleteDocument(req.db, req.access, (req.params as { id: string }).id);
      return reply.status(204).send();
    });
    api.post('/documents/:id/sections', async (req, reply) => {
      const body = parse(z.object({
        heading: z.string().min(1), body: z.string().optional(), mode: mode.optional(),
        position: z.number().int().optional(), note: z.string().optional(),
      }), req.body);
      const r = await proposals.addSection(req.db, req.access, (req.params as { id: string }).id, body);
      return reply.status(r.status === 'applied' ? 201 : 202).send(r);
    });
    api.put('/documents/:id/order', async (req) => {
      const body = parse(z.object({ ids: z.array(id) }), req.body);
      return content.reorderSections(req.db, req.access, (req.params as { id: string }).id, body.ids);
    });

    // sections
    api.get('/sections/:id', async (req) => content.getSection(req.db, req.access, (req.params as { id: string }).id));
    api.patch('/sections/:id', async (req, reply) => {
      const body = parse(z.object({
        heading: z.string().min(1).optional(), body: z.string().optional(), mode: mode.optional(),
        expected_version: z.number().int().optional(), note: z.string().optional(),
      }), req.body);
      const r = await proposals.editSection(req.db, req.access, (req.params as { id: string }).id, body);
      return reply.status(r.status === 'applied' ? 200 : 202).send(r);
    });
    api.delete('/sections/:id', async (req, reply) => {
      await content.deleteSection(req.db, req.access, (req.params as { id: string }).id);
      return reply.status(204).send();
    });
    api.get('/sections/:id/versions', async (req) => content.listVersions(req.db, req.access, (req.params as { id: string }).id));
    api.post('/sections/:id/revert', async (req) => {
      const body = parse(z.object({ version: z.number().int().min(1) }), req.body);
      return content.revertSection(req.db, req.access, (req.params as { id: string }).id, body.version);
    });

    // proposals
    api.get('/proposals', async (req) => {
      const q = req.query as { status?: string; level?: string; project_id?: string };
      const status = q.status && q.status !== 'all' ? z.enum(['pending', 'changes_requested', 'approved', 'rejected', 'open']).parse(q.status) : undefined;
      return proposals.listProposals(req.db, req.access, { status, level: q.level || undefined, projectId: q.project_id || undefined });
    });
    api.get('/proposals/counts', async (req) =>
      proposals.proposalCounts(req.db, req.access, (req.query as { level?: string }).level || undefined));
    api.get('/proposals/:id', async (req) => proposals.getProposalDetail(req.db, req.access, (req.params as { id: string }).id));
    api.get('/proposals/:id/review', async (req) => review.getReview(req.db, req.access, (req.params as { id: string }).id));
    api.post('/proposals/:id/comments', async (req, reply) => {
      const body = parse(z.object({
        body: z.string().max(20000).default(''), thread_id: id.optional(),
        line_start: z.number().int().optional(), line_end: z.number().int().optional(), suggestion: z.string().max(50000).optional(),
      }), req.body);
      return reply.status(201).send(await review.addComment(req.db, req.access, (req.params as { id: string }).id, body));
    });
    api.put('/threads/:id/resolved', async (req) => {
      await review.setResolved(req.db, req.access, (req.params as { id: string }).id, parse(z.object({ resolved: z.boolean() }), req.body).resolved);
      return { ok: true };
    });
    api.post('/proposals/:id/revisions', async (req, reply) => {
      const body = parse(z.object({
        body: z.string(), heading: z.string().optional(), note: z.string().optional(), resolve: z.array(z.string()).optional(),
      }), req.body);
      return reply.status(201).send(await review.reviseProposal(req.db, req.access, (req.params as { id: string }).id, body));
    });
    api.post('/comments/:id/apply', async (req) => review.applySuggestion(req.db, req.access, (req.params as { id: string }).id));
    api.post('/proposals/:id/request-changes', async (req) => {
      const body = parse(z.object({ note: z.string().default('') }), req.body);
      return review.requestChanges(req.db, req.access, (req.params as { id: string }).id, body.note);
    });
    api.post('/proposals/learning', async (req, reply) => {
      const body = parse(z.object({
        heading: z.string().min(1), body: z.string().min(1), rationale: z.string().optional(),
        organization_id: optId, project_id: optId, scope_id: optId,
      }), req.body);
      return reply.status(201).send(await proposals.proposeLearning(req.db, req.access, body));
    });
    api.post('/proposals/:id/approve', async (req) => {
      const body = parse(z.object({
        heading: z.string().optional(), body: z.string().optional(), note: z.string().optional(), mode: mode.optional(),
        target: z.object({ organization_id: optId, project_id: optId, scope_id: optId }).optional(),
      }), req.body);
      return proposals.approveProposal(req.db, req.access, (req.params as { id: string }).id, body);
    });
    api.post('/proposals/:id/reject', async (req) => {
      const body = parse(z.object({ note: z.string().optional() }), req.body);
      return proposals.rejectProposal(req.db, req.access, (req.params as { id: string }).id, body.note);
    });
    api.delete('/proposals/:id', async (req, reply) => {
      await proposals.withdrawProposal(req.db, req.access, (req.params as { id: string }).id);
      return reply.status(204).send();
    });

    // context, search, graph
    api.post('/context', { config: { readOnly: true } }, async (req) => buildContext(req.db, req.access, parse(z.object({
      project: z.string().optional(), remote_url: z.string().optional(), path: z.string().optional(),
      stacks: z.array(z.string()).optional(), manifests: z.array(manifest).optional(),
      scopes: z.array(z.string()).optional(), include_learnings: z.boolean().optional(),
    }), req.body)));
    api.get('/search', async (req) => {
      const q = req.query as { q?: string; project_id?: string; organization_id?: string };
      if (!q.q) throw badRequest('q is required');
      return content.searchSections(req.db, req.access, q.q, { projectId: qid(q.project_id), organizationId: qid(q.organization_id) });
    });
    api.get('/graph', async (req) => {
      const q = req.query as { focus?: string; depth?: string; missing?: string; archived?: string };
      let graph = await buildGraph(req.db, req.access, { includeMissing: q.missing === '1', includeArchived: q.archived === '1' });
      if (q.focus) {
        let focus = q.focus;
        if (!/^(project|term|org|missing):/.test(focus) && focus !== 'group') {
          focus = projectNode((await projects.getProject(req.db, req.access, focus)).id);
        }
        graph = focusGraph(graph, focus, Math.min(Math.max(Number(q.depth ?? 1) || 1, 1), 4));
      }
      return trimRefs(graph);
    });
    api.get('/backlinks', async (req) => {
      const q = req.query as { node?: string; project?: string };
      let node = q.node;
      if (!node && q.project) node = projectNode((await projects.getProject(req.db, req.access, q.project)).id);
      if (!node) throw badRequest('node or project is required');
      return backlinks(req.db, req.access, node);
    });
    api.get('/links/resolve', async (req) => {
      const q = req.query as { target?: string; from_project?: string; from_organization?: string };
      if (!q.target) throw badRequest('target is required');
      return resolveLink(req.db, req.access, q.target, { projectId: qid(q.from_project), organizationId: qid(q.from_organization) });
    });
    api.get('/link-targets', async (req) => {
      const a = req.access;
      const q = ((req.query as { q?: string }).q ?? '').trim();
      const like = `%${q}%`;
      const { rows: ps } = await req.db.query<{ slug: string; name: string; organization_id: string }>(
          `SELECT slug, name, organization_id FROM projects
            WHERE archived_at IS NULL AND organization_id = ANY($2::uuid[]) AND (slug ILIKE $1 OR name ILIKE $1)
            ORDER BY (organization_id = $3::uuid) DESC, name LIMIT 12`, [like, a.readableOrgIds(), a.orgId]);
      const { rows: ts } = await req.db.query<{ heading: string; organization_id: string | null }>(
          `SELECT DISTINCT ON (lower(s.heading), d.organization_id) s.heading, d.organization_id
             FROM sections s JOIN documents d ON d.id = s.document_id
            WHERE d.kind = 'glossary' AND s.heading ILIKE $1
              AND (d.organization_id IS NULL OR d.organization_id = ANY($2::uuid[]))
            ORDER BY lower(s.heading), d.organization_id LIMIT 10`, [like, a.readableOrgIds()]);
      const where = (orgId: string | null) => (orgId ? a.org(orgId)?.name ?? '' : a.group.name);
      return [
        ...ps.map((p) => ({
          type: 'project', label: p.name, where: where(p.organization_id),
          value: p.organization_id === a.orgId ? p.slug : `${a.org(p.organization_id)?.slug}/${p.slug}`,
        })),
        ...ts.map((t) => ({ type: 'term', value: t.heading, label: t.heading, where: where(t.organization_id) })),
      ];
    });

    // people, agents, memberships and tokens
    api.get('/members', async (req) => admin.listMembers(req.db, pool, req.access));
    api.post('/members', async (req, reply) => {
      const body = parse(z.object({
        name: z.string().min(1), kind: z.enum(['human', 'agent']), organization_id: optId,
        role: role.optional(), token_label: z.string().optional(),
      }), req.body);
      return reply.status(201).send(await admin.createMember(req.db, req.access, body));
    });
    api.patch('/members/:id', async (req) => {
      const body = parse(z.object({ name: z.string().min(1).optional(), disabled: z.boolean().optional() }), req.body);
      await admin.updateActor(req.db, pool, req.access, (req.params as { id: string }).id, body);
      return { ok: true };
    });
    api.post('/members/:id/memberships', async (req, reply) => {
      const body = parse(z.object({ organization_id: optId, role: role.optional() }), req.body);
      await admin.addMembership(req.db, req.access, (req.params as { id: string }).id, body);
      return reply.status(201).send({ ok: true });
    });
    api.patch('/memberships/:id', async (req) => {
      await admin.updateMembership(req.db, req.access, (req.params as { id: string }).id, parse(z.object({ role }), req.body).role);
      return { ok: true };
    });
    api.delete('/memberships/:id', async (req, reply) => {
      await admin.removeMembership(req.db, req.access, (req.params as { id: string }).id);
      return reply.status(204).send();
    });
    api.post('/members/:id/tokens', async (req, reply) => {
      const body = parse(z.object({ label: z.string().optional() }), req.body);
      return reply.status(201).send({ token: await admin.issueToken(req.db, pool, req.access, (req.params as { id: string }).id, body.label ?? '') });
    });
    api.delete('/tokens/:id', async (req, reply) => {
      await admin.revokeToken(req.db, pool, req.access, (req.params as { id: string }).id);
      return reply.status(204).send();
    });
  }, { prefix: '/api' });

  // ───────────────────────────── Angular app ─────────────────────────────
  if (fs.existsSync(config.webDir)) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      // Hashed bundles never change; index.html must always be fresh so new deploys load.
      setHeaders: (reply, filePath) => {
        reply.header('Cache-Control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0];
      const isAsset = /\.[a-z0-9]{1,8}$/i.test(path);
      if (req.method === 'GET' && !isAsset && !path.startsWith('/api') && !path.startsWith('/mcp')) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'not_found', message: 'Not found' });
    });
  } else {
    app.log.warn(`Web UI not found at ${config.webDir}; serving API only`);
  }

  return app;
}
