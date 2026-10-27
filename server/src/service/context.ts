import type { Access } from '../auth.js';
import type { Queryable } from '../db.js';
import { matchScopes, mostSpecific, normalizePath, type ScopeMatch } from '../domain/scopes.js';
import { detectStacks, normalizeTags, type Manifest } from '../domain/stacks.js';
import { tryParseRemote } from '../domain/remote.js';
import { documentsAt, listSections } from './content.js';
import { resolveProject, type Resolution } from './projects.js';
import { relatedTo, type Related } from './graph.js';
import { apisOfProjects, type ApiSpecMeta } from './apis.js';
import { KIND_ORDER, type Document, type Level, type Project, type Scope, type Section } from './types.js';

export interface ContextRequest {
  /** Project slug ("slug" or "org/slug"), e.g. from .openpurpose.json. Wins over remote_url. */
  project?: string | null;
  remote_url?: string | null;
  /** Repo-relative path of the file or folder being worked on. */
  path?: string | null;
  stacks?: string[];
  manifests?: Manifest[];
  /** Scope slugs to include regardless of path/stack matching. */
  scopes?: string[];
  include_learnings?: boolean;
}

export type LevelKind = 'group' | 'group-scope' | 'organization' | 'organization-scope' | 'project' | 'project-scope';

export interface ContextBlock {
  level: LevelKind;
  label: string;
  scope: (Pick<Scope, 'id' | 'slug' | 'name'> & { reason: string }) | null;
  documents: Array<Pick<Document, 'id' | 'kind' | 'title' | 'mode'> & { sections: ContextSection[] }>;
}

/** shortened: only the first sentence goes to the agent, to stay within the organization's budget. */
export type ContextSection = Section & { shortened?: boolean };

export interface ContextBudget {
  /** The organization's limit; null = no limit. */
  max_tokens: number | null;
  /** Estimated size of the markdown sent (characters / 4). */
  tokens: number;
  /** How many sections were cut to their first sentence. */
  shortened: number;
}

export interface ContextResult {
  /** shown: false while the group has a single organization, so it is just that organization. */
  group: { name: string; shown: boolean };
  organization: { id: string; slug: string; name: string } | null;
  project: Project | null;
  resolution: Pick<Resolution, 'via' | 'remote' | 'renamed' | 'suggestions'>;
  path: string;
  stacks: string[];
  /** Names of repository-bound scopes skipped because remote_url was missing or not one of the project's repositories. */
  missed_repository_scopes: string[];
  blocks: ContextBlock[];
  /** Where propose_learning will file a learning for this same request by default. */
  learning_target: Level & { label: string };
  /** Projects and terms linked to/from this project with [[wikilinks]]. */
  related: Related[];
  /** API specs of this project and of related projects the agent can read. */
  apis: ContextApi[];
  budget: ContextBudget;
  markdown: string;
}

export interface ContextApi extends ApiSpecMeta {
  /** "org/slug" of the project the API belongs to. */
  project_ref: string;
  project_name: string;
  relation: 'this' | 'uses' | 'used_by';
}

function byKind(a: Document, b: Document): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.position - b.position || a.title.localeCompare(b.title);
}

const SCOPE_COLS = `id, organization_id, project_id, slug, name, description, path_globs, stacks, position,
  ARRAY(SELECT sr.repository_id FROM scope_repositories sr WHERE sr.scope_id = scopes.id) AS repository_ids,
  ARRAY(SELECT x.old_slug FROM slug_aliases x WHERE x.scope_id = scopes.id) AS aliases`;

async function scopesAt(db: Queryable, organizationId: string | null, projectId: string | null): Promise<Scope[]> {
  const { rows } = await db.query<Scope>(
    `SELECT ${SCOPE_COLS} FROM scopes WHERE organization_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2
      ORDER BY position, name`,
    [organizationId, projectId],
  );
  return rows;
}

/** The project's repository the agent is working in, when its remote is one of them. */
async function repositoryOf(db: Queryable, projectId: string, remoteUrl: string | null | undefined): Promise<{ id: string; key: string } | null> {
  const remote = tryParseRemote(remoteUrl);
  if (!remote) return null;
  const { rows } = await db.query<{ id: string; key: string }>(
    'SELECT id, remote_key AS key FROM repositories WHERE project_id = $1 AND remote_key = $2', [projectId, remote.key]);
  return rows[0] ?? null;
}

export interface Matches {
  stacks: string[];
  groupMatches: ScopeMatch<Scope>[];
  orgMatches: ScopeMatch<Scope>[];
  projectMatches: ScopeMatch<Scope>[];
  /** Scopes bound to repositories that could not apply because the agent's repository is unknown. */
  missedRepoScopes: string[];
  target: Level & { label: string };
}

/**
 * Which scopes apply, and where a learning made here belongs by default:
 * the narrowest level the work happened in (project scope, then project,
 * then organization scope, then organization). Group-wide scopes are only the
 * default outside any organization; reviewers promote learnings to the group.
 */
export async function resolveTarget(
  db: Queryable, a: Access, orgId: string | null, project: Project | null,
  req: Pick<ContextRequest, 'remote_url' | 'path' | 'stacks' | 'manifests' | 'scopes'>,
): Promise<Matches> {
  const stacks = normalizeTags([...(req.stacks ?? []), ...detectStacks(req.manifests ?? [])]);
  const input = { path: req.path, stacks, explicit: req.scopes };
  const groupMatches = matchScopes(await scopesAt(db, null, null), input);
  const orgMatches = orgId ? matchScopes(await scopesAt(db, orgId, null), input) : [];
  const repository = project ? await repositoryOf(db, project.id, req.remote_url) : null;
  const projectScopes = project ? await scopesAt(db, project.organization_id, project.id) : [];
  const projectMatches = matchScopes(projectScopes, { ...input, repository });
  const missedRepoScopes = repository ? [] : projectScopes.filter((s) => s.repository_ids?.length).map((s) => s.name);
  const org = a.org(orgId);
  const prefix = org ? `${org.name} › ` : '';
  let target: Level & { label: string };
  const bestProject = mostSpecific(projectMatches);
  const bestOrg = mostSpecific(orgMatches);
  const bestGroup = mostSpecific(groupMatches);
  if (project && bestProject) {
    target = { organization_id: project.organization_id, project_id: project.id, scope_id: bestProject.id, label: `${prefix}${project.name} › ${bestProject.name}` };
  } else if (project) {
    target = { organization_id: project.organization_id, project_id: project.id, scope_id: null, label: `${prefix}${project.name}` };
  } else if (org && bestOrg) {
    target = { organization_id: org.id, project_id: null, scope_id: bestOrg.id, label: `${org.name} › ${bestOrg.name}` };
  } else if (org) {
    target = { organization_id: org.id, project_id: null, scope_id: null, label: org.name };
  } else if (bestGroup) {
    target = { organization_id: null, project_id: null, scope_id: bestGroup.id, label: `${a.group.name} › ${bestGroup.name}` };
  } else {
    target = { organization_id: null, project_id: null, scope_id: null, label: a.group.name };
  }
  return { stacks, groupMatches, orgMatches, projectMatches, missedRepoScopes, target };
}

export async function buildContext(db: Queryable, a: Access, req: ContextRequest): Promise<ContextResult> {
  const resolution = await resolveProject(db, a, { project: req.project, remote_url: req.remote_url });
  const project = resolution.project;
  const orgId = project?.organization_id ?? a.orgId;
  if (orgId) a.requireRead(orgId);
  const org = a.org(orgId);
  const { stacks, groupMatches, orgMatches, projectMatches, missedRepoScopes, target } = await resolveTarget(db, a, orgId, project, req);

  type L = { level: Level; kind: LevelKind; label: string; match: ScopeMatch<Scope> | null };
  const g = a.group.name;
  const levels: L[] = [
    { level: { organization_id: null, project_id: null, scope_id: null }, kind: 'group', label: g, match: null },
    ...groupMatches.map((m) => ({ level: { organization_id: null, project_id: null, scope_id: m.scope.id }, kind: 'group-scope' as const, label: `${g} › ${m.scope.name}`, match: m })),
  ];
  if (org) {
    levels.push({ level: { organization_id: org.id, project_id: null, scope_id: null }, kind: 'organization', label: org.name, match: null });
    for (const m of orgMatches) {
      levels.push({ level: { organization_id: org.id, project_id: null, scope_id: m.scope.id }, kind: 'organization-scope', label: `${org.name} › ${m.scope.name}`, match: m });
    }
  }
  if (project) {
    levels.push({ level: { organization_id: project.organization_id, project_id: project.id, scope_id: null }, kind: 'project', label: project.name, match: null });
    for (const m of projectMatches) {
      levels.push({ level: { organization_id: project.organization_id, project_id: project.id, scope_id: m.scope.id }, kind: 'project-scope', label: `${project.name} › ${m.scope.name}`, match: m });
    }
  }

  const includeLearnings = req.include_learnings ?? true;
  const keepDoc = (d: Document) => includeLearnings || d.kind !== 'learnings';
  const docsPerLevel: Document[][] = [];
  for (const l of levels) docsPerLevel.push(await documentsAt(db, l.level, { forAgents: true }));
  const sections = await listSections(db, docsPerLevel.flat().filter(keepDoc).map((d) => d.id));
  const sectionsByDoc = new Map<string, Section[]>();
  for (const s of sections) sectionsByDoc.set(s.document_id, [...(sectionsByDoc.get(s.document_id) ?? []), s]);

  const blocks: ContextBlock[] = levels.map((l, i) => ({
    level: l.kind,
    label: l.label,
    scope: l.match ? { id: l.match.scope.id, slug: l.match.scope.slug, name: l.match.scope.name, reason: l.match.reason } : null,
    documents: docsPerLevel[i]
      .filter(keepDoc)
      .sort(byKind)
      .map((d) => ({ id: d.id, kind: d.kind, title: d.title, mode: d.mode, sections: sectionsByDoc.get(d.id) ?? [] }))
      .filter((d) => d.sections.length > 0),
  }));

  const result: Omit<ContextResult, 'markdown'> = {
    group: { name: g, shown: a.orgs.length > 1 },
    organization: org ? { id: org.id, slug: org.slug, name: org.name } : null,
    project,
    resolution: { via: resolution.via, remote: resolution.remote, renamed: resolution.renamed, suggestions: resolution.suggestions },
    path: normalizePath(req.path),
    stacks,
    missed_repository_scopes: missedRepoScopes,
    blocks,
    learning_target: target,
    related: [],
    apis: [],
    budget: { max_tokens: null, tokens: 0, shortened: 0 },
  };
  if (project) {
    result.related = await relatedTo(db, a, project.id);
    const relatedProjects = result.related.filter((r) => r.node.type === 'project' && r.node.project_id && !r.node.restricted);
    const ids = [project.id, ...relatedProjects.map((r) => r.node.project_id!)];
    const specs = await apisOfProjects(db, a, [...new Set(ids)]);
    result.apis = specs.map((s) => {
      const rel = relatedProjects.find((r) => r.node.project_id === s.project_id);
      const own = s.project_id === project.id;
      const orgSlug = a.org(s.organization_id)?.slug ?? '?';
      return {
        ...s,
        project_ref: own ? `${orgSlug}/${project.slug}` : `${orgSlug}/${rel?.node.slug ?? '?'}`,
        project_name: own ? project.name : rel?.node.label ?? '',
        relation: own ? 'this' : rel?.direction ?? 'uses',
      };
    });
  }
  // Once the group has several organizations it sets the budget; until then the organization does.
  const { rows: [budget] } = result.group.shown || !org
    ? await db.query<{ max: number | null }>('SELECT context_max_tokens AS max FROM groups WHERE id = $1', [a.group.id])
    : await db.query<{ max: number | null }>('SELECT context_max_tokens AS max FROM organizations WHERE id = $1', [org.id]);
  return compact(result, budget?.max ?? null);
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Which kinds of document give way first inside one level. */
const SHORTEN_ORDER: Record<Document['kind'], number> = {
  learnings: 0, reference: 1, glossary: 2, guidelines: 3, business_logic: 4, purpose: 5,
};

/**
 * Keep the context within `maxTokens` by cutting sections to their first
 * sentence: the most general level first (group, then organization, project,
 * scopes), and inside a level learnings and reference before purpose, longest
 * first. The most specific rules are the last to go. Sections keep their full
 * body in the result; only the markdown shows the excerpt.
 */
export function compact(ctx: Omit<ContextResult, 'markdown'>, maxTokens: number | null): ContextResult {
  let markdown = renderMarkdown(ctx);
  let tokens = estimateTokens(markdown);
  if (maxTokens !== null && tokens > maxTokens) {
    const candidates = ctx.blocks.flatMap((b, level) => b.documents.flatMap((d) => d.sections.map((s) => ({ s, level, kind: d.kind }))))
      .sort((x, y) => x.level - y.level || SHORTEN_ORDER[x.kind] - SHORTEN_ORDER[y.kind] || y.s.body.length - x.s.body.length);
    // The notice about shortened sections costs a little too.
    let estimate = tokens + estimateTokens(shortenedNotice(candidates.length, maxTokens));
    for (const { s } of candidates) {
      if (estimate <= maxTokens) break;
      const saved = s.body.trim().length - excerpt(s).length;
      if (saved <= 0) continue;
      s.shortened = true;
      estimate -= saved / 4;
    }
    const shortened = candidates.filter((c) => c.s.shortened).length;
    ctx.budget = { max_tokens: maxTokens, tokens: 0, shortened };
    markdown = renderMarkdown(ctx);
    tokens = estimateTokens(markdown);
  }
  ctx.budget = { max_tokens: maxTokens, tokens, shortened: ctx.budget.shortened };
  return { ...ctx, markdown };
}

const EXCERPT_CHARS = 200;

/** The first sentence of a section, as plain text, and how to read the rest. */
export function excerpt(s: Pick<Section, 'id' | 'body'>): string {
  const lines = s.body.trim().split('\n');
  const prose: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence || /^(#+|\||>\s*$|---+$)/.test(line)) continue;
    if (!line) { if (prose.length) break; continue; }
    prose.push(line.replace(/^(?:[-*+]|\d+[.)]|>)\s+/, ''));
  }
  const paragraph = prose.join(' ');
  // A sentence ends before a capital, so "e.g. 100" doesn't end it.
  const sentence = paragraph.match(/^.+?[.!?](?=\s+[\p{Lu}"'(\[*_`]|$)/u)?.[0] ?? paragraph;
  let lead = sentence;
  if (lead.length > EXCERPT_CHARS) {
    const cut = lead.slice(0, EXCERPT_CHARS);
    lead = cut.slice(0, cut.lastIndexOf(' ') > EXCERPT_CHARS / 2 ? cut.lastIndexOf(' ') : EXCERPT_CHARS);
  }
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const rest = Math.max(words(s.body) - words(lead), 0);
  const more = `_(${rest} more word${rest === 1 ? '' : 's'}: \`read_section s:${shortId(s.id)}\`)_`;
  return lead ? `${lead} … ${more}` : more;
}

function shortenedNotice(count: number, maxTokens: number): string {
  return `> **${count} section${count === 1 ? ' is' : 's are'} shortened** to fit the context budget (~${maxTokens.toLocaleString('en-US')} tokens). `
    + 'The most general ones were shortened first. When one looks relevant to your task, read it in full with `read_section`.';
}

const shortId = (id: string) => id.slice(0, 8);

export function renderMarkdown(ctx: Omit<ContextResult, 'markdown'>): string {
  const out: string[] = [];
  out.push(`# Context from OpenPurpose`);
  const projectLine = ctx.project
    ? `**${ctx.project.name}** (\`${ctx.organization ? ctx.organization.slug + '/' : ''}${ctx.project.slug}\`, found via ${ctx.resolution.via === 'project' ? 'project name' : 'git remote'})`
    : '_none resolved_';
  out.push('');
  if (ctx.group.shown) out.push(`- Group: **${ctx.group.name}**`);
  out.push(`- Organization: ${ctx.organization ? `**${ctx.organization.name}**` : '_none_'}`, `- Project: ${projectLine}`);
  if (ctx.path || ctx.stacks.length) {
    out.push(`- Path: ${ctx.path ? '`' + ctx.path + '`' : '_repo root_'}`, `- Stacks: ${ctx.stacks.length ? ctx.stacks.join(', ') : '_none given_'}`);
  }
  const scoped = ctx.blocks.filter((b) => b.scope);
  out.push(`- Scopes applied: ${scoped.length ? scoped.map((b) => `${b.label} (${b.scope!.reason})`).join('; ') : '_none_'}`);
  out.push('');

  if (ctx.resolution.renamed) {
    const { asked, current } = ctx.resolution.renamed;
    out.push(`> **\`${asked}\` is an old slug of this project.** Use \`${current}\` from now on. If \`.openpurpose.json\` in this repository still says \`${asked}\`, update it (ask the user first if you can't edit files).`);
    out.push('');
  }

  if (ctx.project && ctx.missed_repository_scopes.length) {
    const names = ctx.missed_repository_scopes.map((n) => `"${n}"`).join(', ');
    out.push(ctx.resolution.remote
      ? `> **This repository (\`${ctx.resolution.remote.key}\`) is not one of ${ctx.project.name}'s repositories**, so its repository scopes (${names}) were left out. If it belongs to the project, ask the user and call \`register_repository\`.`
      : `> **Repository scopes left out: ${names}.** They only apply inside specific repositories. Call \`get_context\` again with \`remote_url\` (\`git remote get-url origin\`).`);
    out.push('');
  }

  if (!ctx.project) {
    const wide = ctx.organization ? (ctx.group.shown ? 'group and organization' : 'organization') : 'group';
    out.push(`> **No project found for this repository.** Only ${wide}-wide context is included below.`);
    if (ctx.resolution.suggestions.length) {
      out.push(`> Possible matches: ${ctx.resolution.suggestions.map((s) => `\`${s.organization_slug}/${s.slug}\` (${s.name})`).join(', ')}.`);
    }
    out.push('> Ask the user which project this is, then call `register_repository` (existing project) or `create_project` (new one) and fetch context again.');
    out.push('');
  }

  out.push(`How to read this: general rules come first (${ctx.group.shown ? 'group, then organization' : 'organization'}), specific ones last (project, then the part of the code you are in). When two rules conflict, the more specific one wins.`);
  out.push('');
  out.push('Each section has a marker `[s:<id> · <mode>]`. **locked**: read-only for you. **propose**: your edits become proposals a person approves. **open**: you may edit directly.');
  if (ctx.budget.shortened && ctx.budget.max_tokens !== null) out.push('', shortenedNotice(ctx.budget.shortened, ctx.budget.max_tokens));

  let any = false;
  for (const block of ctx.blocks) {
    if (block.documents.length === 0) continue;
    any = true;
    out.push('', '---', '', `## ${block.label}`);
    for (const doc of block.documents) {
      out.push('', `### ${doc.title}`);
      for (const s of doc.sections) {
        out.push('', `#### ${s.heading}  \`[s:${shortId(s.id)} · ${s.mode}]\``, '', s.shortened ? excerpt(s) : s.body.trim() || '_(empty)_');
      }
    }
  }
  if (!any) out.push('', '_No guidelines have been written for this context yet._');

  if (ctx.related.length) {
    out.push('', '---', '', '## Related projects and terms');
    out.push('Linked with [[wikilinks]] in documents, in either direction.');
    out.push('Call `get_related` or `get_context` with one of these projects if your task touches it.');
    const line = (r: Related) => {
      const where = r.node.organization_slug && r.node.organization_id !== ctx.organization?.id ? `${r.node.organization_slug}/` : '';
      const name = r.node.type === 'project' ? `**${r.node.label}** (\`${where}${r.node.slug}\`)` : `term **${r.node.label}**`;
      const refs = r.refs.slice(0, 2).map((x) => `"${x.heading}"`).join(', ');
      const about = r.node.restricted ? ' — in an organization you can\'t read' : r.node.summary ? ` — ${r.node.summary}` : '';
      return `- ${name}${about}${refs ? ` · via ${refs}` : ''}`;
    };
    const uses = ctx.related.filter((r) => r.direction === 'uses');
    const usedBy = ctx.related.filter((r) => r.direction === 'used_by');
    if (uses.length) out.push('', 'This project uses / refers to:', ...uses.map(line));
    if (usedBy.length) out.push('', 'Referenced by:', ...usedBy.map(line));
  }
  if (ctx.apis.length) {
    out.push('', '---', '', '## APIs');
    out.push('OpenAPI/Swagger specs people attached to projects. Use `get_api` for endpoints and DTOs instead of guessing request and response shapes.');
    const line = (s: ContextApi) =>
      `- **${s.name}**${s.version ? ` ${s.version}` : ''} (${s.spec_version}, ${s.endpoint_count} endpoints, ${s.schema_count} schemas): \`get_api project="${s.project_ref}"${s.name !== s.title ? ` api="${s.name}"` : ''}\``;
    const own = ctx.apis.filter((s) => s.relation === 'this');
    const uses = ctx.apis.filter((s) => s.relation === 'uses');
    const usedBy = ctx.apis.filter((s) => s.relation === 'used_by');
    if (own.length) out.push('', 'This project:', ...own.map(line));
    if (uses.length) out.push('', 'Projects this one uses:', ...uses.map((s) => line(s).replace('- **', `- ${s.project_name}: **`)));
    if (usedBy.length) out.push('', 'Projects that use this one:', ...usedBy.map((s) => line(s).replace('- **', `- ${s.project_name}: **`)));
  }
  out.push('', '---', '', `If the user corrects you in a way that should apply next time, call \`propose_learning\`. It will be filed under **${ctx.learning_target.label}** unless you pass a different scope.`);
  return out.join('\n');
}

