import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Access } from './auth.js';
import type { ApiSpecConfig } from './config.js';
import type { Pool, Queryable } from './db.js';
import { withScope } from './db.js';
import { AppError } from './errors.js';
import { getSection, listSections, documentsAt, searchSections } from './service/content.js';
import { findApi, loadApi, refreshStale, renderApiText } from './service/apis.js';
import { recordRequest, type Track } from './service/activity.js';
import { buildContext, resolveTarget } from './service/context.js';
import { relatedTo } from './service/graph.js';
import { tryParseRemote } from './domain/remote.js';
import { addRepository, createProject, getProject, listProjects, listRepositories, resolveProject } from './service/projects.js';
import { addSection, editSection, getProposalDetail, listProposals, proposeLearning } from './service/proposals.js';
import { addComment, applySuggestion, getReview, renderReviewForAgent, reviseProposal, setResolved, waitingOn } from './service/review.js';
import type { Level, Scope } from './service/types.js';

export const SERVER_INSTRUCTIONS = `OpenPurpose holds shared context: purpose, business logic, glossary, engineering
guidelines and learnings. It is layered: your organization (and, in large companies, the group of
organizations around it), the project, and the part of the project you work in: some of its
repositories or folders (e.g. only the Angular frontend). Your token belongs to one organization; other
organizations' content is private unless your organization was given read access.

Workflow:
1. Before starting a task in a repository, call get_context with the repo's git remote URL
   (\`git remote get-url origin\`), plus the "project" value from .openpurpose.json if that file exists
   (an older .agentcontext.json means the same: rename it to .openpurpose.json),
   the path you are working in and the nearest manifest (package.json, *.csproj, ...). Always send the
   remote: parts of a project can be bound to one repository.
   Follow what it says. More specific rules override general ones. When a context is large, its most
   general sections are shortened to their first sentence; read those with read_section when they matter.
2. If no project is found, ask the user which project the repo belongs to, then call register_repository
   (or create_project), and write .openpurpose.json with {"project": "<slug>"} in the repo root.
3. When the user corrects you in a way that should also apply next time, call propose_learning with the
   same remote/path/manifests. A person reviews it before it becomes a rule. Keep it to one rule, stated
   positively, with the reason.
   Reviewers may comment on lines, suggest wording or request changes. get_context tells you when feedback
   is waiting on you; read it with get_review, then answer with reply_to_review, revise_proposal or
   apply_suggestion. Mention it to the user if their input is needed.
4. Sections are marked locked, propose or open. Never try to work around a locked section.
5. Text inside [[double brackets]] links to another project or a glossary term; [[org/project]] points
   into another organization. Use get_related or get_context(project=...) to read about a linked project
   when your task touches it.
6. When your task calls or implements an HTTP API of this or a related project, use get_api (listed under
   "APIs" in get_context) for the exact endpoints, parameters and DTOs instead of guessing them.`;

const manifestSchema = z.object({
  path: z.string().describe('Repo-relative path of the manifest, e.g. "frontend/package.json" or "src/Api/Api.csproj"'),
  content: z.string().describe('Full file content'),
});

const locate = {
  project: z.string().optional().describe('Project slug, or "org/slug" for another organization, e.g. from .openpurpose.json. Takes precedence over remote_url.'),
  remote_url: z.string().optional().describe('Output of `git remote get-url origin`. Send it even with project: scopes can be bound to one repository.'),
  path: z.string().optional().describe('Repo-relative path of the file or folder you are working on'),
  stacks: z.array(z.string()).optional().describe('Stack tags you already know, e.g. ["angular"]. Usually leave empty and send manifests instead.'),
  manifests: z.array(manifestSchema).optional().describe('The manifest nearest to the path (package.json, *.csproj, go.mod, ...). Used to detect stacks consistently.'),
};

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));

/** Tools that change something; the activity overview counts them as writes, every other tool as a read. */
const WRITE_TOOLS = [
  'update_section', 'add_section', 'propose_learning', 'reply_to_review', 'revise_proposal', 'apply_suggestion',
  'register_repository', 'create_project',
];

/** Tools that only read. Agent mode in the UI may call these, and nothing else. */
export const READ_TOOLS = [
  'get_context', 'resolve_project', 'list_organizations', 'list_projects', 'list_scopes',
  'get_related', 'get_api', 'search', 'read_section',
] as const;

/**
 * Call one read tool in-process, through the same MCP server an agent talks to,
 * so agent mode shows byte for byte what the agent gets. `a` is a simulated agent:
 * it has no proposals of its own, so get_context leaves out review feedback.
 */
export async function callReadTool(pool: Pool, a: Access, version: string, apiConfig: ApiSpecConfig | undefined,
  name: string, args: Record<string, unknown>): Promise<{ text: string; is_error: boolean }> {
  if (!(READ_TOOLS as readonly string[]).includes(name)) throw new AppError('bad_request', `Agent mode can only call read tools: ${READ_TOOLS.join(', ')}`);
  const server = createMcpServer(pool, a, version, apiConfig, { simulated: true });
  const client = new Client({ name: 'openpurpose-agent-mode', version });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n'), is_error: !!r.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

export function createMcpServer(pool: Pool, a: Access, version: string, apiConfig?: ApiSpecConfig, opts: { simulated?: boolean } = {}): McpServer {
  const server = new McpServer(
    { name: 'openpurpose', version },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  );

  /**
   * Each tool call runs in its own transaction, scoped to the caller's group.
   * A successful call by a real agent is recorded for the activity overview;
   * `track` says what it touched. Agent mode in the UI isn't recorded.
   */
  const run = async (tool: string, fn: (db: Queryable, track: Track) => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await withScope(pool, { groupId: a.group.id }, async (db) => {
        const track: Track = {};
        const result = await fn(db, track);
        if (!opts.simulated && a.isAgent && !result.isError) {
          await recordRequest(db, a, tool, WRITE_TOOLS.includes(tool) ? 'write' : 'read', track);
        }
        return result;
      });
    } catch (err) {
      const message = err instanceof AppError ? `${err.code}: ${err.message}` : `error: ${(err as Error).message ?? String(err)}`;
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  };
  const ref = (orgId: string | null, slug: string) => `${a.org(orgId)?.slug ?? '?'}/${slug}`;

  server.registerTool('get_context', {
    title: 'Get context',
    description: 'Get the group, organization, project and scope-specific guidelines that apply to the code you are about to work on. Call this before starting a task. '
      + 'Over the organization\'s size budget, the most general sections are shortened to their first sentence; read_section gives the full text.',
    inputSchema: {
      ...locate,
      scopes: z.array(z.string()).optional().describe('Scope slugs to include even if path/stack do not match'),
      include_learnings: z.boolean().optional().describe('Default true'),
    },
  }, (args) => run('get_context', async (db, track) => {
    const built = await buildContext(db, a, args);
    track.projectId = built.project?.id;
    track.sections = built.blocks.flatMap((b) => b.documents.flatMap((d) => d.sections.map((s) => ({ id: s.id, document_id: d.id }))));
    if (apiConfig) refreshStale(pool, a.group.id, built.apis, apiConfig);
    const ctx = built.markdown;
    const waiting = opts.simulated ? [] : await waitingOn(db, a);
    if (!waiting.length) return text(ctx);
    const lines = waiting.map((w) => `- \`${w.id}\` "${w.heading}" in ${w.where}: ${w.status === 'changes_requested' ? 'changes requested' : 'new comments'}${w.open_threads ? `, ${w.open_threads} open thread${w.open_threads === 1 ? '' : 's'}` : ''}`);
    return text(`${ctx}\n\n---\n\n## Review feedback waiting on you\n\nReviewers responded to proposals you made. Read each with \`get_review\` and answer with \`reply_to_review\`, \`revise_proposal\` or \`apply_suggestion\`.\n\n${lines.join('\n')}`);
  }));

  server.registerTool('resolve_project', {
    title: 'Resolve project',
    description: 'Find which OpenPurpose project a repository belongs to. Returns the project, or suggestions when unknown.',
    inputSchema: { project: locate.project, remote_url: locate.remote_url },
  }, (args) => run('resolve_project', async (db, track) => {
    const r = await resolveProject(db, a, args);
    track.projectId = r.project?.id;
    return json({
      found: !!r.project,
      project: r.project && { slug: r.project.slug, ref: ref(r.project.organization_id, r.project.slug), name: r.project.name, summary: r.project.summary },
      via: r.via,
      remote_key: r.remote?.key ?? null,
      suggestions: r.suggestions.map((s) => ({ ref: `${s.organization_slug}/${s.slug}`, name: s.name, summary: s.summary })),
      renamed: r.renamed && `"${r.renamed.asked}" is an old slug. Use "${r.renamed.current}" from now on, and update .openpurpose.json if it has the old one.`,
      next: r.project ? 'Call get_context.' : 'Ask the user which project this is, then call register_repository or create_project.',
    });
  }));

  server.registerTool('list_organizations', {
    title: 'List organizations',
    description: 'Organizations in your group and whether you can read them.',
    inputSchema: {},
  }, () => run('list_organizations', async () => json({
    group: a.group.name,
    yours: a.org(a.orgId)?.slug ?? null,
    organizations: a.orgs.filter((o) => !o.archived_at).map((o) => ({ slug: o.slug, name: o.name, readable: a.canRead(o.id) })),
  })));

  server.registerTool('list_projects', {
    title: 'List projects',
    description: 'List or search projects you can read, by name, slug or repository.',
    inputSchema: {
      q: z.string().optional().describe('Search text'),
      organization: z.string().optional().describe('Organization slug; default: every organization you can read'),
    },
  }, ({ q, organization }) => run('list_projects', async (db) => {
    const org = organization ? a.orgBySlug(organization) : null;
    if (organization && !org) throw new AppError('not_found', `Organization "${organization}" not found`);
    const rows = await listProjects(db, a, { q, organizationId: org?.id ?? null });
    return json(rows.slice(0, 50).map((p) => ({ ref: `${p.organization_slug}/${p.slug}`, name: p.name, summary: p.summary, repositories: p.repository_count })));
  }));

  server.registerTool('list_scopes', {
    title: 'List scopes',
    description: 'List the scopes (parts of a project: some of its repositories and/or folders; or stacks across the organization or group) that guidelines and learnings can be filed under.',
    inputSchema: { project: z.string().optional().describe('Project slug. Omit for group and organization scopes only.') },
  }, ({ project }) => run('list_scopes', async (db, track) => {
    const p = project ? await getProject(db, a, project) : null;
    track.projectId = p?.id;
    const orgId = p?.organization_id ?? a.orgId;
    const at = async (org: string | null, proj: string | null) => (await db.query<Scope & { repositories: string[] }>(
      `SELECT slug, name, path_globs, stacks, description,
              ARRAY(SELECT r.remote_key FROM scope_repositories sr JOIN repositories r ON r.id = sr.repository_id
                     WHERE sr.scope_id = scopes.id ORDER BY r.remote_key) AS repositories
         FROM scopes
        WHERE organization_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2 ORDER BY position, name`, [org, proj])).rows;
    const fmt = (s: Scope & { repositories: string[] }) => ({
      slug: s.slug, name: s.name, ...(s.repositories.length ? { repositories: s.repositories } : {}),
      paths: s.path_globs, stacks: s.stacks, description: s.description,
    });
    return json({
      group: (await at(null, null)).map(fmt),
      organization: orgId ? (await at(orgId, null)).map(fmt) : [],
      project: p ? (await at(p.organization_id, p.id)).map(fmt) : [],
    });
  }));

  server.registerTool('get_related', {
    title: 'Get related projects',
    description: 'Projects and glossary terms linked to/from a project with [[wikilinks]], including the purpose of each related project you can read. Use this when working across services.',
    inputSchema: {
      project: z.string().describe('Project slug or org/slug'),
      include_purpose: z.boolean().optional().describe('Include each related project\'s purpose text (default true)'),
    },
  }, ({ project, include_purpose }) => run('get_related', async (db, track) => {
    const p = await getProject(db, a, project);
    track.projectId = p.id;
    const related = await relatedTo(db, a, p.id);
    if (related.length === 0) return text(`Nothing links to or from ${p.name} yet.`);
    const out: string[] = [`# Related to ${p.name}`];
    for (const r of related) {
      const where = r.node.organization_slug ? `${r.node.organization_slug}/` : '';
      const head = r.node.type === 'project' ? `${r.node.label} (\`${where}${r.node.slug}\`)` : `Term: ${r.node.label}`;
      const refs = r.refs.map((x) => `"${x.heading}"`).join(', ');
      out.push('', `## ${r.direction === 'uses' ? '→' : '←'} ${head}`,
        r.direction === 'uses' ? `${p.name} refers to it in: ${refs}` : `It refers to ${p.name} in: ${refs}`);
      if (r.node.restricted) {
        out.push('', `_It belongs to ${a.org(r.node.organization_id)?.name ?? 'another organization'}, which you can't read._`);
      } else if (r.node.type === 'project' && include_purpose !== false && r.node.project_id && r.node.organization_id) {
        const docs = (await documentsAt(db, { organization_id: r.node.organization_id, project_id: r.node.project_id, scope_id: null }, { forAgents: true }))
          .filter((d) => d.kind === 'purpose');
        for (const s of await listSections(db, docs.map((d) => d.id))) out.push('', `### ${s.heading}`, s.body.trim());
      } else if (r.node.summary) {
        out.push('', r.node.summary);
      }
    }
    return text(out.join('\n'));
  }));

  server.registerTool('get_api', {
    title: 'Get API',
    description: 'Endpoints and DTOs from the OpenAPI/Swagger spec attached to a project. Without endpoint/schema: every endpoint, one line each, '
      + 'with request and response types. With endpoint: its parameters, request body, responses and every DTO they use, as TypeScript-like interfaces. '
      + 'With schema: one DTO and what it references.',
    inputSchema: {
      project: z.string().optional().describe('Project slug or org/slug. Defaults to the project of remote_url.'),
      remote_url: z.string().optional().describe('Output of `git remote get-url origin`, when project is not given'),
      api: z.string().optional().describe('Which API, by name, when the project has several'),
      endpoint: z.string().optional().describe('"METHOD /path" (e.g. "GET /orders/{id}"), an operationId, a path, or words to search for'),
      schema: z.string().optional().describe('A DTO / schema name, e.g. "OrderDto"'),
      search: z.string().optional().describe('Only list endpoints whose path, summary, tag or operationId contain these words'),
      tag: z.string().optional().describe('Only list endpoints with this tag'),
    },
  }, (args) => run('get_api', async (db, track) => {
    let projectId: string;
    if (args.project) projectId = (await getProject(db, a, args.project)).id;
    else if (args.remote_url) {
      const r = await resolveProject(db, a, { remote_url: args.remote_url });
      if (!r.project) throw new AppError('not_found', 'No project is registered for that remote. Pass project instead.');
      projectId = r.project.id;
    } else throw new AppError('bad_request', 'Pass project (slug or org/slug) or remote_url');
    track.projectId = projectId;
    const meta = await findApi(db, a, projectId, args.api);
    const { api } = await loadApi(db, a, meta.id);
    const p = await getProject(db, a, projectId);
    if (apiConfig) refreshStale(pool, a.group.id, [meta], apiConfig);
    return text(renderApiText(meta, api, ref(p.organization_id, p.slug), args));
  }));

  server.registerTool('search', {
    title: 'Search',
    description: 'Full-text search across guidelines, business logic, glossary and learnings you can read.',
    inputSchema: {
      query: z.string().describe('Words to search for'),
      project: z.string().optional().describe('Limit to this project plus its organization and group-wide content'),
    },
  }, ({ query, project }) => run('search', async (db, track) => {
    const projectId = project ? (await getProject(db, a, project)).id : null;
    track.projectId = projectId;
    const hits = await searchSections(db, a, query, { projectId, limit: 15 });
    return json(hits.map((h) => ({
      section_id: h.section_id.slice(0, 8), heading: h.heading, mode: h.mode, document: h.document_title,
      where: [h.organization_slug ?? a.group.name, h.project_slug, h.scope_slug].filter(Boolean).join(' › '), snippet: h.snippet,
    })));
  }));

  server.registerTool('read_section', {
    title: 'Read section',
    description: 'Read one section in full, with its version (needed for update_section) and edit mode.',
    inputSchema: { section_id: z.string().describe('Section id or its 8-character prefix, as shown in [s:xxxxxxxx]') },
  }, ({ section_id }) => run('read_section', async (db, track) => {
    const s = await getSection(db, a, section_id);
    track.sections = [{ id: s.id, document_id: s.document_id }];
    return json({ id: s.id, heading: s.heading, mode: s.mode, version: s.version, document_id: s.document_id, body: s.body });
  }));

  server.registerTool('update_section', {
    title: 'Update section',
    description: 'Change a section in your organization or a group-wide one. "open" sections change immediately; "propose" sections create a proposal for a person to review; "locked" sections are refused. Send the complete new body, not a diff.',
    inputSchema: {
      section_id: z.string(),
      body: z.string().describe('The complete new markdown body'),
      heading: z.string().optional(),
      expected_version: z.number().int().optional().describe('Version you read; protects against overwriting someone else\'s change'),
      reason: z.string().describe('Why this change is needed, shown to the reviewer'),
    },
  }, (x) => run('update_section', async (db, track) => {
    const r = await editSection(db, a, x.section_id, {
      body: x.body, heading: x.heading, expected_version: x.expected_version, note: x.reason, rationale: x.reason,
    });
    track.documentId = r.status === 'applied' ? r.section.document_id : r.proposal.document_id;
    track.projectId = r.status === 'applied' ? null : r.proposal.project_id;
    return r.status === 'applied'
      ? text(`Applied. Section is now at version ${r.section.version}.`)
      : text(`Proposed for review (proposal ${r.proposal.id.slice(0, 8)}). A person will approve or reject it in OpenPurpose.`);
  }));

  server.registerTool('add_section', {
    title: 'Add section',
    description: 'Add a section to a document. Depends on the document\'s mode, like update_section. For lessons learned from a user\'s correction, use propose_learning instead.',
    inputSchema: { document_id: z.string(), heading: z.string(), body: z.string(), reason: z.string() },
  }, (x) => run('add_section', async (db, track) => {
    const r = await addSection(db, a, x.document_id, { heading: x.heading, body: x.body, note: x.reason, rationale: x.reason });
    track.documentId = r.status === 'applied' ? r.section.document_id : r.proposal.document_id;
    return r.status === 'applied'
      ? text(`Added section ${r.section.id.slice(0, 8)}.`)
      : text(`Proposed for review (proposal ${r.proposal.id.slice(0, 8)}).`);
  }));

  server.registerTool('propose_learning', {
    title: 'Propose learning',
    description: 'Record something the user taught you so every agent gets it next time. It is filed under the most specific matching scope (e.g. only the Angular frontend of this project), and a person approves it first; they can also promote it to the whole organization or group. Pass the same remote_url/path/manifests you used for get_context.',
    inputSchema: {
      heading: z.string().describe('The rule in one line, e.g. "Every user action must be undoable"'),
      body: z.string().describe('The rule in detail: what to do, what not to do, and a short example if useful'),
      rationale: z.string().describe('What happened: the user\'s correction, in a sentence or two'),
      ...locate,
      scope: z.string().optional().describe('File under this scope slug instead of the automatic choice'),
      level: z.enum(['auto', 'project', 'organization', 'group']).optional().describe('auto (default): most specific scope. project: whole project. organization: your whole organization. group: every organization (a reviewer must agree).'),
    },
  }, (x) => run('propose_learning', async (db, track) => {
    const r = await resolveProject(db, a, { project: x.project, remote_url: x.remote_url });
    const project = r.project;
    track.projectId = project?.id;
    const orgId = project?.organization_id ?? a.orgId;
    let target: Level & { label: string };
    if (x.level === 'group') {
      target = { organization_id: null, project_id: null, scope_id: null, label: a.group.name };
    } else if (x.level === 'organization') {
      if (!orgId) throw new AppError('bad_request', 'No organization known; pass project or remote_url.');
      target = { organization_id: orgId, project_id: null, scope_id: null, label: a.org(orgId)!.name };
    } else if (x.level === 'project') {
      if (!project) throw new AppError('bad_request', 'No project resolved; pass project or remote_url, or use level "organization".');
      target = { organization_id: project.organization_id, project_id: project.id, scope_id: null, label: project.name };
    } else if (x.scope) {
      const { rows } = await db.query<Scope>(
        `SELECT id, organization_id, project_id, name FROM scopes s
          WHERE (slug = $1 OR EXISTS (SELECT 1 FROM slug_aliases x WHERE x.scope_id = s.id AND x.old_slug = $1))
            AND ((project_id = $2::uuid) OR (project_id IS NULL AND organization_id = $3::uuid) OR (organization_id IS NULL))
          ORDER BY slug = $1 DESC, project_id NULLS LAST, organization_id NULLS LAST LIMIT 1`,
        [x.scope, project?.id ?? null, orgId]);
      const s = rows[0];
      if (!s) throw new AppError('not_found', `Scope "${x.scope}" not found; call list_scopes`);
      target = { organization_id: s.organization_id, project_id: s.project_id, scope_id: s.id, label: s.name };
    } else {
      if (!project) throw new AppError('bad_request', 'No project resolved for this repository. Ask the user which project it is (register_repository), or pass level "organization".');
      target = (await resolveTarget(db, a, project.organization_id, project, x)).target;
    }
    const p = await proposeLearning(db, a, {
      heading: x.heading, body: x.body, rationale: x.rationale,
      organization_id: target.organization_id, project_id: target.project_id, scope_id: target.scope_id,
      context: { remote: r.remote?.key ?? null, path: x.path ?? null, stacks: x.stacks ?? [], manifests: (x.manifests ?? []).map((m) => m.path) },
    });
    return text(`Learning proposed for **${target.label}** (proposal ${p.id.slice(0, 8)}). It applies once a person approves it.`);
  }));

  server.registerTool('list_my_proposals', {
    title: 'List my proposals',
    description: 'Your proposals and learnings that are still open, with whether the next move is yours (feedback waiting) or the reviewers\'.',
    inputSchema: {},
  }, () => run('list_my_proposals', async (db) => {
    const rows = await listProposals(db, a, { status: 'open', createdBy: a.actor.id, limit: 50 });
    if (!rows.length) return text('You have no open proposals.');
    return json(rows.map((p) => ({
      id: p.id, heading: p.heading, kind: p.kind, status: p.status, revision: p.revision,
      next_move: p.awaiting === 'author' ? 'yours' : 'reviewers', open_threads: p.open_threads,
      where: [p.organization_name ?? a.group.name, p.project_name, p.scope_name].filter(Boolean).join(' › '),
    })));
  }));

  server.registerTool('get_review', {
    title: 'Get review',
    description: 'Read the review of a proposal: current text with line numbers, open comment threads, suggested replacements and the reviewers\' verdict.',
    inputSchema: { proposal_id: z.string().describe('Proposal id') },
  }, ({ proposal_id }) => run('get_review', async (db) => {
    const p = await getProposalDetail(db, a, proposal_id);
    return text(renderReviewForAgent(p, await getReview(db, a, p.id)));
  }));

  server.registerTool('reply_to_review', {
    title: 'Reply to review',
    description: 'Answer a review thread (thread_id), or start a new comment on lines of the current text (line_start/line_end) or on the whole proposal. Use this to explain, ask the reviewer something, or say what you changed.',
    inputSchema: {
      proposal_id: z.string(),
      body: z.string().describe('Your reply, in markdown'),
      thread_id: z.string().optional().describe('Thread to answer; omit to start a new thread'),
      line_start: z.number().int().optional().describe('New thread only: first line (1-based) of the current text'),
      line_end: z.number().int().optional(),
      resolve: z.boolean().optional().describe('Also mark the thread resolved'),
    },
  }, (x) => run('reply_to_review', async (db) => {
    const t = await addComment(db, a, x.proposal_id, { body: x.body, thread_id: x.thread_id, line_start: x.line_start, line_end: x.line_end });
    if (x.resolve) await setResolved(db, a, t.id, true);
    return text(`Replied in thread ${t.id}${x.resolve ? ' and resolved it' : ''}.`);
  }));

  server.registerTool('revise_proposal', {
    title: 'Revise proposal',
    description: 'Replace the proposed text with a new revision after review feedback. Send the complete new text. If changes were requested, this hands it back to the reviewers.',
    inputSchema: {
      proposal_id: z.string(),
      body: z.string().describe('The complete new text'),
      heading: z.string().optional(),
      note: z.string().describe('What you changed and why, shown in the review timeline'),
      resolve: z.array(z.string()).optional().describe('Ids of threads this revision addresses'),
    },
  }, (x) => run('revise_proposal', async (db, track) => {
    const p = await reviseProposal(db, a, x.proposal_id, { body: x.body, heading: x.heading, note: x.note, resolve: x.resolve });
    Object.assign(track, { projectId: p.project_id, documentId: p.document_id });
    return text(`Saved revision ${p.revision}. Status: ${p.status.replace('_', ' ')}.`);
  }));

  server.registerTool('apply_suggestion', {
    title: 'Apply suggestion',
    description: 'Accept a reviewer\'s suggested replacement for some lines. Creates a new revision and resolves the thread.',
    inputSchema: { comment_id: z.string().describe('The comment id given in get_review') },
  }, ({ comment_id }) => run('apply_suggestion', async (db, track) => {
    const p = await applySuggestion(db, a, comment_id);
    Object.assign(track, { projectId: p.project_id, documentId: p.document_id });
    return text(`Applied. The proposal is now at revision ${p.revision}.`);
  }));

  server.registerTool('register_repository', {
    title: 'Register repository',
    description: 'Map a git repository to an existing project in your organization, after the user has told you which project it belongs to.',
    inputSchema: {
      remote_url: z.string().describe('Output of `git remote get-url origin`'),
      project: z.string().describe('Project slug'),
    },
  }, (x) => run('register_repository', async (db, track) => {
    const repo = await addRepository(db, a, x.project, x.remote_url);
    track.projectId = repo.project_id;
    // Same repository name under another remote: most likely the repository moved.
    const name = tryParseRemote(repo.remote_url)?.repo.toLowerCase();
    const moved = (await listRepositories(db, repo.project_id))
      .filter((r) => r.id !== repo.id && tryParseRemote(r.remote_url)?.repo.toLowerCase() === name);
    const note = moved.length
      ? `\n\nThis project is also mapped to ${moved.map((r) => `\`${r.remote_key}\``).join(', ')}. If the repository moved, tell the user they can remove the old mapping on the project's page in OpenPurpose.`
      : '';
    return text(`Mapped ${repo.remote_key} to project "${x.project}". Also write .openpurpose.json with {"project": "${x.project}"} in the repo root.${note}`);
  }));

  server.registerTool('create_project', {
    title: 'Create project',
    description: 'Create a new project in your organization when the user confirms the repository belongs to a project OpenPurpose does not know yet. Projects created by agents are flagged for review.',
    inputSchema: {
      name: z.string(),
      slug: z.string().optional().describe('Lower-case, dashes; derived from name when omitted'),
      purpose: z.string().describe('What the project does, in the user\'s words'),
      remote_url: z.string().optional().describe('Repository to map to the project'),
    },
  }, (x) => run('create_project', async (db, track) => {
    const p = await createProject(db, a, { name: x.name, slug: x.slug, purpose: x.purpose, summary: x.purpose.split('\n')[0].slice(0, 200), remote_url: x.remote_url });
    track.projectId = p.id;
    return text(`Created project "${p.slug}" in ${a.org(p.organization_id)?.name} (pending review).${x.remote_url ? ' Repository mapped.' : ''}`);
  }));

  return server;
}
