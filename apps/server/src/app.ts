import fs from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type pg from 'pg';
import { z, ZodError } from 'zod';
import {
  type Access,
  beginRequest,
  actorFromToken,
  agentViewOf,
  bearer,
  canViewAsAgent,
  groupsOf,
  resolveAccess,
  type Actor,
} from './auth.js';
import { createProvider, SignInError } from './auth/providers/index.js';
import { RateLimiter } from './auth/rate-limit.js';
import type { Config } from './config.js';
import { endScope, type Pool } from './db.js';
import { AppError, badRequest, notFound } from './errors.js';
import { callReadTool, createMcpServer } from './mcp.js';
import * as activity from './service/activity.js';
import * as admin from './service/admin.js';
import * as apis from './service/apis.js';
import * as content from './service/content.js';
import { buildContext } from './service/context.js';
import {
  backlinks,
  buildGraph,
  focusGraph,
  projectNode,
  resolveLink,
  trimRefs,
} from './service/graph.js';
import * as projects from './service/projects.js';
import * as proposals from './service/proposals.js';
import * as findings from './service/findings.js';
import * as review from './service/review.js';
import * as signin from './service/signin.js';
import { deleteAlias, listAliases } from './service/aliases.js';
import { renameSlug } from './service/slugs.js';
import { DEFAULT_INCLUDES, exportContent } from './service/transfer/export.js';
import { importAsGroup, importContent } from './service/transfer/import.js';
import { exportZip, readExportZip } from './service/transfer/markdown.js';
import { DOC_KINDS, EDIT_MODES } from './service/types.js';
import type {
  AuthConfig as AuthConfigDto,
  AuthStartResult,
  AuthStatus,
  ExportIncludes,
  ImportReport,
  PendingSignup,
  SignInErrorCode,
} from '@openpurpose/contracts';

// From apps/server/package.json, which a release bumps (the image copies it next to dist/).
export const VERSION = (
  JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

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
    /** Needs no token at all (the sign-in routes). */
    public?: boolean;
  }
}

const mode = z
  .enum(EDIT_MODES as [string, ...string[]])
  .transform((m) => m as (typeof EDIT_MODES)[number]);
const kind = z
  .enum(DOC_KINDS as [string, ...string[]])
  .transform((k) => k as (typeof DOC_KINDS)[number]);
const id = z.uuid();
const optId = id.nullable().optional();
const role = z.enum(['admin', 'editor', 'viewer', 'agent']);
const manifest = z.object({ path: z.string(), content: z.string() });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value ?? {});
}

/** Query-string id: "", "null" and "group" mean "none" (the group level). */
const qid = (v: unknown): string | null => {
  if (typeof v !== 'string' || v === '' || v === 'null' || v === 'group') return null;
  return v;
};

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v || undefined;
};

export async function buildApp(pool: Pool, config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: config.trustProxy,
  });
  // Fails at startup on an unknown OPENPURPOSE_AUTH_PROVIDER.
  const provider = createProvider(config.auth);
  // Only the PKCE verifier between /api/auth/start and /api/auth/callback is a cookie.
  await app.register(fastifyCookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .status(err.status)
        .send({ error: err.code, message: err.message, ...err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'bad_request',
        message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
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
      access = await resolveAccess(
        pool,
        actor,
        header(req, 'x-openpurpose-group'),
        header(req, 'x-openpurpose-org'),
      );
    } catch (e) {
      const status = e instanceof AppError ? e.status : 401;
      return reply
        .status(status)
        .header('WWW-Authenticate', 'Bearer')
        .send({
          jsonrpc: '2.0',
          error: { code: -32001, message: (e as Error).message },
          id: null,
        });
    }
    const server = createMcpServer(pool, access, VERSION, config.apiSpecs);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .status(405)
      .header('Allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed (stateless server; use POST)' },
        id: null,
      });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // ───────────────────────────── REST API ─────────────────────────────
  await app.register(
    // Fastify waits for an async plugin, even one without an await.
    // eslint-disable-next-line @typescript-eslint/require-await
    async (api) => {
      // Every group-level request runs in one transaction that row-level security scopes to the
      // caller's group.
      api.addHook('preHandler', async (req) => {
        if (req.routeOptions.config.public) return;
        req.actor = await actorFromToken(pool, bearer(req.headers.authorization));
        if (req.routeOptions.config.serverLevel) return;
        // One transaction for the whole request: access is read in it, then it stays scoped to
        // the caller's group. The close hooks below end it, also when this hook throws later.
        ({ db: req.db, access: req.access } = await beginRequest(
          pool,
          req.actor,
          header(req, 'x-openpurpose-group'),
          header(req, 'x-openpurpose-org'),
        ));
        req.scopeOpen = true;
        // Agent mode: answer as an agent in the chosen organization would see it. Read-only.
        if (header(req, 'x-openpurpose-agent-view') === '1' && !req.access.isAgent) {
          if (req.method !== 'GET' && req.method !== 'HEAD' && !req.routeOptions.config.readOnly) {
            throw new AppError(
              'forbidden',
              'Agent mode is read-only. Turn it off to make changes.',
            );
          }
          req.person = req.access;
          req.access = agentViewOf(req.access);
        }
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
      const open = { config: { public: true } };

      // signing in (no token needed)
      const callbackUrl = `${config.publicUrl.replace(/\/+$/, '')}/api/auth/callback`;
      const verifierCookie = {
        name: 'op_auth_verifier',
        options: {
          path: '/api/auth',
          httpOnly: true,
          secure: config.publicUrl.startsWith('https:'),
          sameSite: 'lax' as const,
        },
      };
      // Per IP and per email, so nobody can use the magic-link sender to spam people.
      const startsPerIp = new RateLimiter(20, 15 * 60_000);
      const startsPerEmail = new RateLimiter(5, 15 * 60_000);
      const needProvider = () => {
        if (!provider)
          throw badRequest('This server has no sign-in provider. Sign in with an access token.');
        return provider;
      };

      api.get('/auth/config', open, (): AuthConfigDto => ({
        signup: config.auth.signup,
        methods: provider?.methods() ?? [],
        site_url: config.auth.siteUrl || null,
      }));
      api.post('/auth/start', open, async (req, reply): Promise<AuthStartResult> => {
        const p = needProvider();
        const body = parse(
          z.object({
            method: z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('magic_link') }),
              z.object({ kind: z.literal('oauth'), provider: z.string().min(1).max(50) }),
            ]),
            email: z.email().max(320).optional(),
          }),
          req.body,
        );
        const method = p
          .methods()
          .find(
            (m) =>
              m.kind === body.method.kind &&
              (m.kind !== 'oauth' ||
                (body.method.kind === 'oauth' && m.provider === body.method.provider)),
          );
        if (!method) throw badRequest('This server does not offer that way to sign in');
        if (method.kind === 'magic_link' && !body.email)
          throw badRequest('Enter your email address');
        const email = body.email?.trim().toLowerCase();
        if (!startsPerIp.take(`ip:${req.ip}`) || (email && !startsPerEmail.take(`email:${email}`)))
          throw new AppError(
            'too_many_requests',
            'Too many sign-in attempts. Try again in 15 minutes.',
          );
        const started = await p.start({ method, email, callbackUrl });
        if (started.notice) req.log[started.notice.level](started.notice.message);
        if (started.verifier) {
          reply.setCookie(verifierCookie.name, started.verifier, {
            ...verifierCookie.options,
            maxAge: 10 * 60,
          });
        }
        return { redirect: started.redirect ?? null, email_sent: !!started.emailSent };
      });
      api.get('/auth/callback', open, async (req, reply) => {
        const back = (reason: SignInErrorCode) => reply.redirect(`/sign-in?error=${reason}`);
        if (!provider) return back('failed');
        const verifier = req.cookies[verifierCookie.name];
        reply.clearCookie(verifierCookie.name, verifierCookie.options);
        let code: string;
        try {
          const identity = await provider.finish({
            query: Object.fromEntries(
              Object.entries(req.query as Record<string, unknown>).filter(
                (e): e is [string, string] => typeof e[1] === 'string',
              ),
            ),
            verifier,
          });
          const actorId = await signin.actorForIdentity(pool, config.auth.signup, identity);
          code = await signin.issueAuthCode(pool, actorId);
        } catch (err) {
          if (err instanceof SignInError) {
            req.log.info({ reason: err.reason }, `Sign-in refused: ${err.message}`);
            return back(err.reason);
          }
          req.log.error(err);
          return back('failed');
        }
        return reply.redirect(`/auth/done?code=${encodeURIComponent(code)}`);
      });
      api.post('/auth/exchange', open, async (req) => {
        const body = parse(z.object({ code: z.string().min(1).max(200) }), req.body);
        return { token: await signin.exchangeAuthCode(pool, body.code, config.auth.sessionDays) };
      });
      api.post('/auth/sign-out', server, async (req, reply) => {
        const token = bearer(req.headers.authorization);
        if (token) await signin.signOut(pool, token);
        return reply.status(204).send();
      });
      // Works without a workspace, unlike /me, so a pending person sees that they're waiting.
      api.get('/auth/status', server, async (req): Promise<AuthStatus> =>
        signin.status(pool, req.actor),
      );

      // sign-ups waiting for a server admin
      api.get('/signups', server, async (req): Promise<PendingSignup[]> => {
        const q = parse(
          z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }),
          req.query,
        );
        return signin.listSignups(pool, req.actor, q.status);
      });
      api.post('/signups/:id/approve', server, async (req) => {
        const { id: actorId } = parse(z.object({ id }), req.params);
        const body = parse(z.object({ workspace: z.string().min(1).max(200) }), req.body);
        return signin.approveSignup(pool, req.actor, actorId, body.workspace);
      });
      api.post('/signups/:id/reject', server, async (req, reply) => {
        const { id: actorId } = parse(z.object({ id }), req.params);
        await signin.rejectSignup(pool, req.actor, actorId);
        return reply.status(204).send();
      });

      // who am I
      api.get('/me', async (req) => {
        const a = req.access;
        return {
          actor: req.actor,
          groups: await groupsOf(pool, req.actor),
          group: {
            ...a.group,
            role: a.groupRole,
            can_admin: a.canAdmin(null),
            can_edit: a.canEdit(null),
            context_max_tokens: await admin.groupContextBudget(req.db, a),
          },
          organizations: await admin.listOrganizations(req.db, a),
          current_organization_id: a.orgId,
          /**
           * Set in agent mode: which agent is simulated, and which organizations the person may
           * simulate.
           */
          agent_view: req.person
            ? {
                organization_id: a.orgId,
                readable_organization_ids: a.readableOrgIds(),
                switchable_organization_ids: req.person.orgs
                  .filter((o) => !o.archived_at && req.person && canViewAsAgent(req.person, o.id))
                  .map((o) => o.id),
              }
            : null,
          public_url: config.publicUrl,
          version: VERSION,
        };
      });

      // the sidebar badges: refreshed far more often than /me, so kept apart and cheap
      api.get('/me/counts', async (req) => ({
        pending_proposals: await proposals.countReviewable(req.db, req.access),
        new_findings: await findings.countToSort(req.db, req.access),
      }));

      // your own account
      api.patch('/me', async (req) => {
        const body = parse(z.object({ name: z.string().min(1).max(200) }), req.body);
        await pool.query('UPDATE actors SET name = $2 WHERE id = $1', [
          req.actor.id,
          body.name.trim(),
        ]);
        return { ok: true };
      });
      api.get('/me/tokens', async (req) => admin.myTokens(pool, req.actor));
      api.post('/me/tokens', async (req, reply) => {
        const body = parse(z.object({ label: z.string().max(100).optional() }), req.body);
        return reply
          .status(201)
          .send({ token: await admin.issueOwnToken(pool, req.actor, body.label ?? '') });
      });
      api.delete('/me/tokens/:id', async (req, reply) => {
        await admin.revokeOwnToken(pool, req.actor, (req.params as { id: string }).id);
        return reply.status(204).send();
      });

      // groups (server admins)
      api.get('/groups', server, async (req) => admin.listGroups(pool, req.actor));
      api.post('/groups', server, async (req, reply) => {
        const body = parse(
          z.object({
            name: z.string().min(1),
            slug: z.string().optional(),
            organization_name: z.string().optional(),
            organization_slug: z.string().optional(),
            admin_name: z.string().optional(),
          }),
          req.body,
        );
        return reply.status(201).send(await admin.createGroup(pool, req.actor, body));
      });
      // The file as JSON, or an exported zip as base64.
      const upload = { file: z.unknown().optional(), zip: z.string().optional() };
      const unpack = async <T extends { file?: unknown; zip?: string }>(
        body: T,
        run: (file: unknown, rest: Omit<T, 'file' | 'zip'>) => Promise<ImportReport>,
      ) => {
        const { file, zip, ...rest } = body;
        if (!zip) return run(file, rest);
        const unzipped = readExportZip(Buffer.from(zip, 'base64'), config.importMaxBytes);
        const report = await run(unzipped.file, rest);
        if (unzipped.markdownEdited) {
          report.warnings.unshift(
            'The Markdown files in the zip were changed after the export. Only manifest.json is imported, so those changes are left out.',
          );
        }
        return report;
      };
      // base64 makes an uploaded zip a third larger.
      const importLimit = { bodyLimit: Math.ceil(config.importMaxBytes * 1.4) };
      const groupImport = z.object({
        ...upload,
        name: z.string().optional(),
        slug: z.string().optional(),
      });
      const groupImportConfig = { config: { serverLevel: true }, bodyLimit: importLimit.bodyLimit };
      api.post('/groups/import/preview', groupImportConfig, async (req) =>
        unpack(parse(groupImport, req.body), (file, opts) =>
          importAsGroup(pool, req.actor, file, { ...opts, dryRun: true }),
        ),
      );
      api.post('/groups/import', groupImportConfig, async (req, reply) =>
        reply
          .status(201)
          .send(
            await unpack(parse(groupImport, req.body), (file, opts) =>
              importAsGroup(pool, req.actor, file, { ...opts, dryRun: false }),
            ),
          ),
      );
      api.put('/group', async (req) => {
        const body = parse(
          z.object({
            name: z.string().min(1).max(200).optional(),
            context_max_tokens: z.number().int().min(1000).max(1_000_000).nullable().optional(),
          }),
          req.body,
        );
        if (body.name !== undefined) await admin.renameGroup(req.db, req.access, body.name);
        if (body.context_max_tokens !== undefined)
          await admin.setGroupContextBudget(req.db, req.access, body.context_max_tokens);
        return { ok: true };
      });

      // slug renames: dry_run previews what a rename touches
      const renameBody = z.object({
        slug: z.string().min(1),
        rewrite_links: z.boolean().optional(),
        take_alias: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      });
      api.delete('/aliases/:id', async (req, reply) => {
        await deleteAlias(req.db, req.access, (req.params as { id: string }).id);
        return reply.status(204).send();
      });

      // organizations
      api.get('/organizations', async (req) => admin.listOrganizations(req.db, req.access));
      api.post('/organizations', async (req, reply) => {
        const body = parse(
          z.object({
            name: z.string().min(1),
            slug: z.string().optional(),
            summary: z.string().optional(),
            take_alias: z.boolean().optional(),
          }),
          req.body,
        );
        return reply.status(201).send(await admin.createOrganization(req.db, req.access, body));
      });
      api.patch('/organizations/:id', async (req) => {
        const { slug, take_alias, ...body } = parse(
          z.object({
            name: z.string().min(1).optional(),
            slug: z.string().optional(),
            summary: z.string().optional(),
            archived: z.boolean().optional(),
            take_alias: z.boolean().optional(),
            context_max_tokens: z.number().int().min(1000).max(1_000_000).nullable().optional(),
          }),
          req.body,
        );
        const orgId = (req.params as { id: string }).id;
        // A slug change still leaves an alias behind; /rename also updates links.
        if (slug && slug.toLowerCase() !== req.access.org(orgId)?.slug) {
          await renameSlug(req.db, req.access, 'organization', orgId, {
            slug,
            take_alias,
            rewrite_links: false,
          });
        }
        return admin.updateOrganization(req.db, req.access, orgId, body);
      });
      api.get('/organizations/:id/activity', async (req) => {
        const { period } = parse(
          z.object({ period: z.enum(['7d', '30d', 'all']).default('30d') }),
          req.query,
        );
        return activity.organizationActivity(
          req.db,
          req.access,
          (req.params as { id: string }).id,
          period,
        );
      });
      api.post('/organizations/:id/rename', async (req) =>
        renameSlug(
          req.db,
          req.access,
          'organization',
          (req.params as { id: string }).id,
          parse(renameBody, req.body),
        ),
      );
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
          q: q.q,
          includeArchived: q.archived === '1' || q.archived === 'true',
          organizationId: qid(q.organization_id),
        });
      });
      api.post('/projects', async (req, reply) => {
        const body = parse(
          z.object({
            organization_id: optId,
            name: z.string().min(1),
            slug: z.string().optional(),
            summary: z.string().optional(),
            purpose: z.string().optional(),
            remote_url: z.string().optional(),
            take_alias: z.boolean().optional(),
          }),
          req.body,
        );
        return reply.status(201).send(await projects.createProject(req.db, req.access, body));
      });
      api.get('/projects/:id', async (req) => {
        const a = req.access;
        const p = await projects.getProject(
          req.db,
          a,
          decodeURIComponent((req.params as { id: string }).id),
        );
        const level = { organization_id: p.organization_id, project_id: p.id };
        const repositories = await projects.listRepositories(req.db, p.id);
        const scopes = await content.listScopes(req.db, a, level);
        const documents = await content.listDocuments(req.db, a, { ...level, scope_id: null });
        const org = a.org(p.organization_id);
        if (!org) throw notFound('Organization');
        const apiSpecs = await apis.listApis(req.db, a, p.id);
        const aliases = await listAliases(req.db, 'project', p.id);
        return {
          ...p,
          organization: { id: org.id, slug: org.slug, name: org.name },
          can_edit: a.canEdit(p.organization_id),
          repositories,
          scopes,
          documents,
          apis: apiSpecs,
          aliases,
        };
      });
      api.patch('/projects/:id', async (req) => {
        const { slug, take_alias, ...body } = parse(
          z.object({
            name: z.string().min(1).optional(),
            slug: z.string().optional(),
            summary: z.string().optional(),
            reviewed: z.boolean().optional(),
            archived: z.boolean().optional(),
            organization_id: id.optional(),
            take_alias: z.boolean().optional(),
          }),
          req.body,
        );
        const projectId = (req.params as { id: string }).id;
        // A slug change still leaves an alias behind; /rename also updates links.
        if (
          slug &&
          slug.toLowerCase() !== (await projects.getProject(req.db, req.access, projectId)).slug
        ) {
          await renameSlug(req.db, req.access, 'project', projectId, {
            slug,
            take_alias,
            rewrite_links: false,
          });
        }
        return projects.updateProject(req.db, req.access, projectId, body);
      });
      api.post('/projects/:id/rename', async (req) =>
        renameSlug(
          req.db,
          req.access,
          'project',
          (req.params as { id: string }).id,
          parse(renameBody, req.body),
        ),
      );
      api.delete('/projects/:id', async (req, reply) => {
        await projects.deleteProject(req.db, req.access, (req.params as { id: string }).id);
        return reply.status(204).send();
      });
      api.post('/projects/:id/repositories', async (req, reply) => {
        const body = parse(z.object({ remote_url: z.string().min(1) }), req.body);
        return reply
          .status(201)
          .send(
            await projects.addRepository(
              req.db,
              req.access,
              (req.params as { id: string }).id,
              body.remote_url,
            ),
          );
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
        reply
          .status(201)
          .send(
            await apis.addApi(
              req.db,
              req.access,
              apiId(req),
              parse(apiInput, req.body),
              config.apiSpecs,
            ),
          ),
      );
      api.get('/apis/:id', async (req) => {
        const { meta, api: spec } = await apis.loadApi(req.db, req.access, apiId(req));
        const p = await projects.getProject(req.db, req.access, meta.project_id);
        return {
          ...meta,
          can_edit: req.access.canEdit(p.organization_id),
          description: spec.description,
          servers: spec.servers,
          operations: spec.operations.map((o) => ({
            key: o.key,
            method: o.method,
            path: o.path,
            summary: o.summary,
            operation_id: o.operationId,
            tags: o.tags,
            deprecated: o.deprecated,
          })),
          schemas: Object.keys(spec.schemas),
        };
      });
      // The exact text agents get from get_api, for previews in the UI.
      api.get('/apis/:id/text', async (req) => {
        const q = parse(
          z.object({
            endpoint: z.string().optional(),
            schema: z.string().optional(),
            search: z.string().optional(),
            tag: z.string().optional(),
          }),
          req.query,
        );
        const { meta, api: spec } = await apis.loadApi(req.db, req.access, apiId(req));
        const p = await projects.getProject(req.db, req.access, meta.project_id);
        return {
          text: apis.renderApiText(
            meta,
            spec,
            `${req.access.org(p.organization_id)?.slug}/${p.slug}`,
            q,
          ),
        };
      });
      api.get('/apis/:id/raw', async (req, reply) => {
        const { meta, raw } = await apis.loadApi(req.db, req.access, apiId(req));
        const name = (meta.filename ?? `${meta.name || 'openapi'}.json`)
          .replace(/\.ya?ml$/i, '.json')
          .replace(/[^\w.-]+/g, '-');
        return reply
          .header('content-disposition', `attachment; filename="${name}"`)
          .type('application/json')
          .send(JSON.stringify(raw, null, 2));
      });
      api.patch('/apis/:id', specBody, async (req) =>
        apis.updateApi(req.db, req.access, apiId(req), parse(apiInput, req.body), config.apiSpecs),
      );
      api.post('/apis/:id/refresh', async (req) =>
        apis.refreshApi(req.db, req.access, apiId(req), config.apiSpecs),
      );
      api.delete('/apis/:id', async (req, reply) => {
        await apis.deleteApi(req.db, req.access, apiId(req));
        return reply.status(204).send();
      });

      // scopes
      const scopeBody = z.object({
        name: z.string().min(1),
        slug: z.string().optional(),
        description: z.string().optional(),
        path_globs: z.array(z.string()).optional(),
        stacks: z.array(z.string()).optional(),
        position: z.number().int().optional(),
        repository_ids: z.array(z.string()).optional(),
        take_alias: z.boolean().optional(),
      });
      api.get('/scopes', async (req) => {
        const q = req.query as { organization_id?: string; project_id?: string };
        return content.listScopes(req.db, req.access, {
          organization_id: qid(q.organization_id),
          project_id: qid(q.project_id),
        });
      });
      api.post('/scopes', async (req, reply) => {
        const body = parse(
          scopeBody.extend({ organization_id: optId, project_id: optId }),
          req.body,
        );
        return reply.status(201).send(await content.createScope(req.db, req.access, body, body));
      });
      api.get('/scopes/:id', async (req) => {
        const a = req.access;
        const scope = await content.getScope(req.db, a, (req.params as { id: string }).id);
        const documents = await content.listDocuments(req.db, a, { scope_id: scope.id });
        const project = scope.project_id
          ? await projects.getProject(req.db, a, scope.project_id)
          : null;
        const repositories = project ? await projects.listRepositories(req.db, project.id) : [];
        const org = a.org(scope.organization_id);
        const aliases = await listAliases(req.db, 'scope', scope.id);
        return {
          ...scope,
          documents,
          project,
          repositories,
          organization: org && { id: org.id, slug: org.slug, name: org.name },
          can_edit: a.canEdit(scope.organization_id),
          aliases,
        };
      });
      api.patch('/scopes/:id', async (req) => {
        const { slug, take_alias, ...body } = parse(scopeBody.partial(), req.body);
        const scopeId = (req.params as { id: string }).id;
        // A slug change still leaves an alias behind.
        if (
          slug &&
          slug.toLowerCase() !== (await content.getScope(req.db, req.access, scopeId)).slug
        ) {
          await renameSlug(req.db, req.access, 'scope', scopeId, {
            slug,
            take_alias,
            rewrite_links: false,
          });
        }
        return content.updateScope(req.db, req.access, scopeId, body);
      });
      api.post('/scopes/:id/rename', async (req) =>
        renameSlug(
          req.db,
          req.access,
          'scope',
          (req.params as { id: string }).id,
          parse(renameBody, req.body),
        ),
      );
      api.delete('/scopes/:id', async (req, reply) => {
        await content.deleteScope(req.db, req.access, (req.params as { id: string }).id);
        return reply.status(204).send();
      });

      // documents
      api.get('/documents', async (req) => {
        const q = req.query as { organization_id?: string; project_id?: string; scope_id?: string };
        return content.listDocuments(req.db, req.access, {
          organization_id: qid(q.organization_id),
          project_id: qid(q.project_id),
          scope_id: qid(q.scope_id),
        });
      });
      api.post('/documents', async (req, reply) => {
        const body = parse(
          z.object({
            organization_id: optId,
            project_id: optId,
            scope_id: optId,
            kind,
            title: z.string().min(1),
            slug: z.string().optional(),
            mode: mode.optional(),
            position: z.number().int().optional(),
          }),
          req.body,
        );
        return reply.status(201).send(await content.createDocument(req.db, req.access, body, body));
      });
      api.get('/documents/:id', async (req) => {
        const a = req.access;
        const doc = await content.getDocument(req.db, a, (req.params as { id: string }).id);
        const rows = await content.listSections(req.db, [doc.id]);
        const reads = await activity.sectionActivity(
          req.db,
          rows.map((s) => s.id),
        );
        const sections = rows.map((s) => ({
          ...s,
          activity: reads.get(s.id) ?? activity.NO_SECTION_ACTIVITY,
        }));
        const docActivity =
          (await activity.documentActivity(req.db, [doc])).get(doc.id) ??
          activity.noDocumentActivity(doc);
        const project = doc.project_id
          ? await projects.getProject(req.db, a, doc.project_id)
          : null;
        const scope = doc.scope_id ? await content.getScope(req.db, a, doc.scope_id) : null;
        const org = a.org(doc.organization_id);
        return {
          ...doc,
          ...docActivity,
          sections,
          project,
          scope,
          organization: org && { id: org.id, slug: org.slug, name: org.name },
          can_edit: a.canEdit(doc.organization_id),
        };
      });
      api.patch('/documents/:id', async (req) => {
        const body = parse(
          z.object({
            title: z.string().min(1).optional(),
            slug: z.string().optional(),
            mode: mode.optional(),
            position: z.number().int().optional(),
            kind: kind.optional(),
            disabled: z.boolean().optional(),
          }),
          req.body,
        );
        const { disabled, ...rest } = body;
        const docId = (req.params as { id: string }).id;
        if (disabled !== undefined)
          await content.setDocumentDisabled(req.db, req.access, docId, disabled);
        if (disabled !== undefined && !Object.keys(rest).length)
          return content.getDocument(req.db, req.access, docId);
        return content.updateDocument(req.db, req.access, docId, rest);
      });
      api.delete('/documents/:id', async (req, reply) => {
        await content.deleteDocument(req.db, req.access, (req.params as { id: string }).id);
        return reply.status(204).send();
      });
      api.post('/documents/:id/sections', async (req, reply) => {
        const body = parse(
          z.object({
            heading: z.string().min(1),
            body: z.string().optional(),
            mode: mode.optional(),
            position: z.number().int().optional(),
            note: z.string().optional(),
          }),
          req.body,
        );
        const r = await proposals.addSection(
          req.db,
          req.access,
          (req.params as { id: string }).id,
          body,
        );
        return reply.status(r.status === 'applied' ? 201 : 202).send(r);
      });
      api.put('/documents/:id/order', async (req) => {
        const body = parse(z.object({ ids: z.array(id) }), req.body);
        return content.reorderSections(
          req.db,
          req.access,
          (req.params as { id: string }).id,
          body.ids,
        );
      });

      // sections
      api.get('/sections/:id', async (req) =>
        content.getSection(req.db, req.access, (req.params as { id: string }).id),
      );
      api.patch('/sections/:id', async (req, reply) => {
        const body = parse(
          z.object({
            heading: z.string().min(1).optional(),
            body: z.string().optional(),
            mode: mode.optional(),
            expected_version: z.number().int().optional(),
            note: z.string().optional(),
          }),
          req.body,
        );
        const r = await proposals.editSection(
          req.db,
          req.access,
          (req.params as { id: string }).id,
          body,
        );
        return reply.status(r.status === 'applied' ? 200 : 202).send(r);
      });
      api.delete('/sections/:id', async (req, reply) => {
        await content.deleteSection(req.db, req.access, (req.params as { id: string }).id);
        return reply.status(204).send();
      });
      api.get('/sections/:id/versions', async (req) =>
        content.listVersions(req.db, req.access, (req.params as { id: string }).id),
      );
      api.post('/sections/:id/revert', async (req) => {
        const body = parse(z.object({ version: z.number().int().min(1) }), req.body);
        return content.revertSection(
          req.db,
          req.access,
          (req.params as { id: string }).id,
          body.version,
        );
      });

      // proposals
      api.get('/proposals', async (req) => {
        const q = req.query as { status?: string; level?: string; project_id?: string };
        const status =
          q.status && q.status !== 'all'
            ? z
                .enum(['pending', 'changes_requested', 'approved', 'rejected', 'open'])
                .parse(q.status)
            : undefined;
        return proposals.listProposals(req.db, req.access, {
          status,
          level: q.level || undefined,
          projectId: q.project_id || undefined,
        });
      });
      api.get('/proposals/counts', async (req) =>
        proposals.proposalCounts(
          req.db,
          req.access,
          (req.query as { level?: string }).level || undefined,
        ),
      );
      api.get('/proposals/:id', async (req) =>
        proposals.getProposalDetail(req.db, req.access, (req.params as { id: string }).id),
      );
      api.get('/proposals/:id/review', async (req) =>
        review.getReview(req.db, req.access, (req.params as { id: string }).id),
      );
      api.post('/proposals/:id/comments', async (req, reply) => {
        const body = parse(
          z.object({
            body: z.string().max(20000).default(''),
            thread_id: id.optional(),
            line_start: z.number().int().optional(),
            line_end: z.number().int().optional(),
            suggestion: z.string().max(50000).optional(),
          }),
          req.body,
        );
        return reply
          .status(201)
          .send(
            await review.addComment(req.db, req.access, (req.params as { id: string }).id, body),
          );
      });
      api.put('/threads/:id/resolved', async (req) => {
        await review.setResolved(
          req.db,
          req.access,
          (req.params as { id: string }).id,
          parse(z.object({ resolved: z.boolean() }), req.body).resolved,
        );
        return { ok: true };
      });
      api.post('/proposals/:id/revisions', async (req, reply) => {
        const body = parse(
          z.object({
            body: z.string(),
            heading: z.string().optional(),
            note: z.string().optional(),
            resolve: z.array(z.string()).optional(),
          }),
          req.body,
        );
        return reply
          .status(201)
          .send(
            await review.reviseProposal(
              req.db,
              req.access,
              (req.params as { id: string }).id,
              body,
            ),
          );
      });
      api.post('/comments/:id/apply', async (req) =>
        review.applySuggestion(req.db, req.access, (req.params as { id: string }).id),
      );
      api.post('/proposals/:id/request-changes', async (req) => {
        const body = parse(z.object({ note: z.string().default('') }), req.body);
        return review.requestChanges(
          req.db,
          req.access,
          (req.params as { id: string }).id,
          body.note,
        );
      });
      api.post('/proposals/learning', async (req, reply) => {
        const body = parse(
          z.object({
            heading: z.string().min(1),
            body: z.string().min(1),
            rationale: z.string().optional(),
            organization_id: optId,
            project_id: optId,
            scope_id: optId,
          }),
          req.body,
        );
        return reply.status(201).send(await proposals.proposeLearning(req.db, req.access, body));
      });
      api.post('/proposals/:id/approve', async (req) => {
        const body = parse(
          z.object({
            heading: z.string().optional(),
            body: z.string().optional(),
            note: z.string().optional(),
            mode: mode.optional(),
            target: z
              .object({ organization_id: optId, project_id: optId, scope_id: optId })
              .optional(),
          }),
          req.body,
        );
        return proposals.approveProposal(
          req.db,
          req.access,
          (req.params as { id: string }).id,
          body,
        );
      });
      api.post('/proposals/:id/reject', async (req) => {
        const body = parse(z.object({ note: z.string().optional() }), req.body);
        return proposals.rejectProposal(
          req.db,
          req.access,
          (req.params as { id: string }).id,
          body.note,
        );
      });
      api.delete('/proposals/:id', async (req, reply) => {
        await proposals.withdrawProposal(req.db, req.access, (req.params as { id: string }).id);
        return reply.status(204).send();
      });

      // findings
      const findingStatus = z.enum(
        findings.FINDING_STATUSES as [findings.FindingStatus, ...findings.FindingStatus[]],
      );
      api.get('/findings', async (req) => {
        const q = req.query as {
          status?: string;
          project_id?: string;
          organization_id?: string;
          path?: string;
          q?: string;
        };
        const statuses =
          q.status === 'all'
            ? findings.FINDING_STATUSES
            : q.status
              ? z.array(findingStatus).parse(q.status.split(','))
              : undefined;
        return findings.listFindings(req.db, req.access, {
          statuses,
          projectId: qid(q.project_id) ?? undefined,
          organizationId: qid(q.organization_id) ?? undefined,
          path: q.path,
          q: q.q,
        });
      });
      api.get('/findings/counts', async (req) => {
        const q = req.query as { project_id?: string; organization_id?: string };
        return findings.findingCounts(req.db, req.access, {
          projectId: qid(q.project_id) ?? undefined,
          organizationId: qid(q.organization_id) ?? undefined,
        });
      });
      api.get('/findings/:id', async (req) =>
        findings.getFinding(req.db, req.access, (req.params as { id: string }).id),
      );
      api.put('/findings/:id/status', async (req) => {
        const body = parse(
          z.object({
            status: findingStatus,
            note: z.string().max(2000).optional(),
            solved_ref: z.string().max(500).nullable().optional(),
            remind_after: z.iso.date().nullable().optional(),
          }),
          req.body,
        );
        return findings.setFindingStatus(
          req.db,
          req.access,
          (req.params as { id: string }).id,
          body,
        );
      });

      // context, search, graph
      api.post('/context', { config: { readOnly: true } }, async (req) =>
        buildContext(
          req.db,
          req.access,
          parse(
            z.object({
              project: z.string().optional(),
              remote_url: z.string().optional(),
              path: z.string().optional(),
              stacks: z.array(z.string()).optional(),
              manifests: z.array(manifest).optional(),
              scopes: z.array(z.string()).optional(),
              include_learnings: z.boolean().optional(),
            }),
            req.body,
          ),
        ),
      );
      // Agent mode: run one read-only MCP tool as the simulated agent and return its text exactly.
      api.post('/agent/tool', { config: { readOnly: true } }, async (req) => {
        if (!req.person) throw new AppError('forbidden', 'Turn on agent mode to call agent tools.');
        const body = parse(
          z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
          req.body,
        );
        return callReadTool(pool, req.access, VERSION, config.apiSpecs, body.name, body.args ?? {});
      });
      api.get('/search', async (req) => {
        const q = parse(
          z.object({
            q: z.string().min(1, 'q is required'),
            project_id: z.string().optional(),
            organization_id: z.string().optional(),
            near_project_id: z.string().optional(),
            near_organization_id: z.string().optional(),
            within: z.enum(['project', 'organization']).optional(),
            limit: z.coerce.number().int().optional(),
          }),
          req.query,
        );
        return content.searchSections(req.db, req.access, q.q, {
          projectId: qid(q.project_id),
          organizationId: qid(q.organization_id),
          nearProjectId: qid(q.near_project_id),
          nearOrganizationId: qid(q.near_organization_id),
          within: q.within,
          limit: q.limit,
        });
      });
      api.get('/graph', async (req) => {
        const q = req.query as {
          focus?: string;
          depth?: string;
          missing?: string;
          archived?: string;
        };
        let graph = await buildGraph(req.db, req.access, {
          includeMissing: q.missing === '1',
          includeArchived: q.archived === '1',
        });
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
        if (!node && q.project)
          node = projectNode((await projects.getProject(req.db, req.access, q.project)).id);
        if (!node) throw badRequest('node or project is required');
        return backlinks(req.db, req.access, node);
      });
      api.get('/links/resolve', async (req) => {
        const q = req.query as {
          target?: string;
          from_project?: string;
          from_organization?: string;
        };
        if (!q.target) throw badRequest('target is required');
        return resolveLink(req.db, req.access, q.target, {
          projectId: qid(q.from_project),
          organizationId: qid(q.from_organization),
        });
      });
      api.get('/link-targets', async (req) => {
        const a = req.access;
        const q = ((req.query as { q?: string }).q ?? '').trim();
        const like = `%${q}%`;
        const { rows: ps } = await req.db.query<{
          slug: string;
          name: string;
          organization_id: string;
        }>(
          `SELECT slug, name, organization_id FROM projects
            WHERE archived_at IS NULL AND organization_id = ANY($2::uuid[]) AND (slug ILIKE $1 OR name ILIKE $1)
            ORDER BY (organization_id = $3::uuid) DESC, name LIMIT 12`,
          [like, a.readableOrgIds(), a.orgId],
        );
        const { rows: ts } = await req.db.query<{
          heading: string;
          organization_id: string | null;
        }>(
          `SELECT DISTINCT ON (lower(s.heading), d.organization_id) s.heading, d.organization_id
             FROM sections s JOIN documents d ON d.id = s.document_id
            WHERE d.kind = 'glossary' AND s.heading ILIKE $1
              AND (d.organization_id IS NULL OR d.organization_id = ANY($2::uuid[]))
            ORDER BY lower(s.heading), d.organization_id LIMIT 10`,
          [like, a.readableOrgIds()],
        );
        const where = (orgId: string | null) => (orgId ? (a.org(orgId)?.name ?? '') : a.group.name);
        return [
          ...ps.map((p) => ({
            type: 'project',
            label: p.name,
            where: where(p.organization_id),
            value:
              p.organization_id === a.orgId
                ? p.slug
                : `${a.org(p.organization_id)?.slug}/${p.slug}`,
          })),
          ...ts.map((t) => ({
            type: 'term',
            value: t.heading,
            label: t.heading,
            where: where(t.organization_id),
          })),
        ];
      });

      // people, agents, memberships and tokens
      api.get('/members', async (req) => admin.listMembers(req.db, pool, req.access));
      api.post('/members', async (req, reply) => {
        const body = parse(
          z.object({
            name: z.string().min(1),
            kind: z.enum(['human', 'agent']),
            organization_id: optId,
            role: role.optional(),
            token_label: z.string().optional(),
          }),
          req.body,
        );
        return reply.status(201).send(await admin.createMember(req.db, req.access, body));
      });
      api.patch('/members/:id', async (req) => {
        const body = parse(
          z.object({
            name: z.string().min(1).optional(),
            disabled: z.boolean().optional(),
            review: z.enum(admin.AGENT_REVIEWS).optional(),
            accept_findings: z.boolean().optional(),
          }),
          req.body,
        );
        await admin.updateActor(req.db, pool, req.access, (req.params as { id: string }).id, body);
        return { ok: true };
      });
      api.post('/members/:id/memberships', async (req, reply) => {
        const body = parse(z.object({ organization_id: optId, role: role.optional() }), req.body);
        await admin.addMembership(req.db, req.access, (req.params as { id: string }).id, body);
        return reply.status(201).send({ ok: true });
      });
      api.patch('/memberships/:id', async (req) => {
        await admin.updateMembership(
          req.db,
          req.access,
          (req.params as { id: string }).id,
          parse(z.object({ role }), req.body).role,
        );
        return { ok: true };
      });
      api.delete('/memberships/:id', async (req, reply) => {
        await admin.removeMembership(req.db, req.access, (req.params as { id: string }).id);
        return reply.status(204).send();
      });
      api.post('/members/:id/tokens', async (req, reply) => {
        const body = parse(z.object({ label: z.string().optional() }), req.body);
        return reply.status(201).send({
          token: await admin.issueToken(
            req.db,
            pool,
            req.access,
            (req.params as { id: string }).id,
            body.label ?? '',
          ),
        });
      });
      api.delete('/tokens/:id', async (req, reply) => {
        await admin.revokeToken(req.db, pool, req.access, (req.params as { id: string }).id);
        return reply.status(204).send();
      });

      // export and import (also the backup)
      api.get('/export', async (req, reply) => {
        const q = req.query as Partial<
          Record<'organization_id' | 'format' | keyof ExportIncludes, string>
        >;
        const flag = (v: string | undefined, fallback: boolean) =>
          v === undefined ? fallback : v === '1' || v === 'true';
        const d = DEFAULT_INCLUDES;
        const file = await exportContent(
          req.db,
          req.access,
          qid(q.organization_id),
          {
            history: flag(q.history, d.history),
            proposals: flag(q.proposals, d.proposals),
            people: flag(q.people, d.people),
            api_specs: flag(q.api_specs, d.api_specs),
            findings: flag(q.findings, d.findings),
          },
          VERSION,
        );
        const name = file.source.organization
          ? (file.organizations.find((o) => o.key === file.source.organization)?.slug ??
            file.source.organization)
          : file.source.group.slug;
        const filename = `${name}-${file.exported_at.slice(0, 10)}.openpurpose`;
        if (q.format === 'zip') {
          return reply
            .header('content-disposition', `attachment; filename="${filename}.zip"`)
            .type('application/zip')
            .send(exportZip(file));
        }
        return reply
          .header('content-disposition', `attachment; filename="${filename}.json"`)
          .type('application/json')
          .send(JSON.stringify(file, null, 2));
      });
      const policy = z.enum(['propose', 'file', 'keep']);
      const importBody = z.object({
        ...upload,
        organizations: z
          .record(
            z.string(),
            z.discriminatedUnion('action', [
              z.object({ action: z.literal('new'), slug: z.string().optional() }),
              z.object({ action: z.literal('merge'), into: z.string() }),
              z.object({ action: z.literal('skip') }),
            ]),
          )
          .optional(),
        group_content: z.boolean().optional(),
        changes: policy.optional(),
        section_changes: z.record(z.string(), policy).optional(),
        remove_missing: z.boolean().optional(),
      });
      api.post('/import/preview', importLimit, async (req) =>
        unpack(parse(importBody, req.body), (file, opts) =>
          importContent(req.db, req.access, file, { ...opts, dryRun: true }),
        ),
      );
      api.post('/import', importLimit, async (req, reply) =>
        reply
          .status(201)
          .send(
            await unpack(parse(importBody, req.body), (file, opts) =>
              importContent(req.db, req.access, file, { ...opts, dryRun: false }),
            ),
          ),
      );
    },
    { prefix: '/api' },
  );

  // ───────────────────────────── Angular app ─────────────────────────────
  if (fs.existsSync(config.webDir)) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      // Hashed bundles never change; index.html must always be fresh so new deploys load.
      setHeaders: (reply, filePath) => {
        reply.header(
          'Cache-Control',
          filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
        );
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0];
      const isAsset = /\.[a-z0-9]{1,8}$/i.test(path);
      if (
        req.method === 'GET' &&
        !isAsset &&
        !path.startsWith('/api') &&
        !path.startsWith('/mcp')
      ) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'not_found', message: 'Not found' });
    });
  } else {
    app.log.warn(`Web UI not found at ${config.webDir}; serving API only`);
  }

  return app;
}
