import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';
import type {
  ActivityPeriod,
  OrgActivity,
  ContextResult,
  Doc,
  DocDetail,
  DocKind,
  EditMode,
  EditResult,
  Graph,
  GroupRef,
  GroupRow,
  Level,
  LinkRef,
  LinkResolution,
  LinkTarget,
  Me,
  Member,
  Organization,
  Project,
  ProjectDetail,
  Proposal,
  ProposalStatus,
  Role,
  AgentReview,
  Scope,
  ScopeDetail,
  SearchHit,
  Section,
  SectionVersion,
  GraphNode,
  TokenRow,
  ProposalCounts,
  Review,
  ReviewThread,
  ApiSpec,
  ApiSpecDetail,
  Repository,
  SlugKind,
  SlugRename,
  ExportIncludes,
  Finding,
  FindingCounts,
  FindingStatus,
  ImportOptions,
  ImportReport,
  AuthConfig,
  AuthMethod,
  AuthStartResult,
  AuthStatus,
  PendingSignup,
} from './models';

/** An export to import: parsed JSON, or a zip as base64. */
export type ImportUpload = { file: unknown } | { zip: string };

const lv = (id: string | null | undefined) => id ?? 'group';

/** Thin typed wrapper over the REST API. Every method returns a Promise. */
@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  private get<T>(
    path: string,
    params?: Record<string, string | number | undefined | null>,
  ): Promise<T> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(params ?? {}))
      if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return firstValueFrom(this.http.get<T>(`/api${path}`, { params: p }));
  }

  private send<T>(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const obs: Observable<T> = this.http.request<T>(method, `/api${path}`, { body });
    return firstValueFrom(obs);
  }

  // signing in: config, start and exchange need no token
  authConfig = () => this.get<AuthConfig>('/auth/config');
  startSignIn = (method: AuthMethod, email?: string) =>
    this.send<AuthStartResult>('POST', '/auth/start', { method, email });

  /** Swaps the one-time code from /auth/done for a session token. */
  exchangeCode = (code: string) => this.send<{ token: string }>('POST', '/auth/exchange', { code });
  /** Ends a browser session; an access token stays valid. */
  signOut = () => this.send<undefined>('POST', '/auth/sign-out');
  /** Works without a workspace: tells a pending person they're waiting. */
  authStatus = () => this.get<AuthStatus>('/auth/status');

  // sign-ups waiting for a server admin
  signups = () => this.get<PendingSignup[]>('/signups', { status: 'pending' });
  /** Gives the person a workspace of their own, with them as its admin. */
  approveSignup = (id: string, workspace: string) =>
    this.send<{ group: GroupRef; organization: Organization }>('POST', `/signups/${id}/approve`, {
      workspace,
    });

  rejectSignup = (id: string) => this.send<undefined>('POST', `/signups/${id}/reject`);

  me = () => this.get<Me>('/me');
  /** Agent mode: run one read-only MCP tool as the agent and get its text exactly. */
  agentTool = (name: string, args: Record<string, unknown>) =>
    this.send<{ text: string; is_error: boolean }>('POST', '/agent/tool', { name, args });

  renameMe = (name: string) => this.send('PATCH', '/me', { name });
  myTokens = () => this.get<TokenRow[]>('/me/tokens');
  createMyToken = (label: string) => this.send<{ token: string }>('POST', '/me/tokens', { label });
  revokeMyToken = (id: string) => this.send<undefined>('DELETE', `/me/tokens/${id}`);
  updateGroup = (body: { name?: string; context_max_tokens?: number | null }) =>
    this.send('PUT', '/group', body);

  groups = () => this.get<GroupRow[]>('/groups');
  createGroup = (body: { name: string; organization_name?: string; admin_name?: string }) =>
    this.send<{ group: GroupRef; organization: Organization; token?: string }>(
      'POST',
      '/groups',
      body,
    );

  /** Download an export of the current group (or `groupId`), or of one organization. */
  exportFile = async (opts: {
    organizationId: string | null;
    format: 'json' | 'zip';
    includes: ExportIncludes;
    groupId?: string;
  }): Promise<{ blob: Blob; name: string }> => {
    let params = new HttpParams().set('format', opts.format);
    if (opts.organizationId) params = params.set('organization_id', opts.organizationId);
    for (const [k, v] of Object.entries(opts.includes)) params = params.set(k, v ? '1' : '0');
    const headers = opts.groupId
      ? new HttpHeaders({ 'X-OpenPurpose-Group': opts.groupId })
      : undefined;
    const res = await firstValueFrom(
      this.http.get('/api/export', { params, headers, responseType: 'blob', observe: 'response' }),
    );
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
    return { blob: res.body ?? new Blob(), name: name ?? `export.openpurpose.${opts.format}` };
  };

  previewImport = (upload: ImportUpload, opts: ImportOptions) =>
    this.send<ImportReport>('POST', '/import/preview', { ...upload, ...opts });

  runImport = (upload: ImportUpload, opts: ImportOptions) =>
    this.send<ImportReport>('POST', '/import', { ...upload, ...opts });

  previewGroupImport = (upload: ImportUpload, opts: { name?: string; slug?: string }) =>
    this.send<ImportReport>('POST', '/groups/import/preview', { ...upload, ...opts });

  runGroupImport = (upload: ImportUpload, opts: { name?: string; slug?: string }) =>
    this.send<ImportReport>('POST', '/groups/import', { ...upload, ...opts });

  organizations = () => this.get<Organization[]>('/organizations');
  orgActivity = (id: string, period: ActivityPeriod) =>
    this.get<OrgActivity>(`/organizations/${id}/activity`, { period });

  createOrganization = (body: {
    name: string;
    slug?: string;
    summary?: string;
    take_alias?: boolean;
  }) => this.send<Organization>('POST', '/organizations', body);

  updateOrganization = (
    id: string,
    body: {
      name?: string;
      slug?: string;
      summary?: string;
      archived?: boolean;
      context_max_tokens?: number | null;
    },
  ) => this.send<Organization>('PATCH', `/organizations/${id}`, body);

  setReader = (targetId: string, readerId: string, allowed: boolean) =>
    this.send('PUT', `/organizations/${targetId}/readers/${readerId}`, { allowed });

  projects = (opts: { q?: string; archived?: boolean; organizationId?: string | null } = {}) =>
    this.get<Project[]>('/projects', {
      q: opts.q,
      archived: opts.archived ? '1' : undefined,
      organization_id: opts.organizationId ?? undefined,
    });

  project = (idOrSlug: string) =>
    this.get<ProjectDetail>(`/projects/${encodeURIComponent(idOrSlug)}`);

  createProject = (body: {
    organization_id: string | null;
    name: string;
    slug?: string;
    summary?: string;
    purpose?: string;
    remote_url?: string;
    take_alias?: boolean;
  }) => this.send<Project>('POST', '/projects', body);

  updateProject = (
    id: string,
    body: Partial<Pick<Project, 'name' | 'slug' | 'summary' | 'reviewed' | 'organization_id'>> & {
      archived?: boolean;
    },
  ) => this.send<Project>('PATCH', `/projects/${id}`, body);

  deleteProject = (id: string) => this.send<undefined>('DELETE', `/projects/${id}`);
  addRepository = (projectId: string, remote_url: string) =>
    this.send<Repository>('POST', `/projects/${projectId}/repositories`, { remote_url });

  deleteRepository = (id: string) => this.send<undefined>('DELETE', `/repositories/${id}`);

  addApi = (
    projectId: string,
    body: { name?: string; url?: string; filename?: string; content?: string },
  ) => this.send<ApiSpec>('POST', `/projects/${projectId}/apis`, body);

  apiSpec = (id: string) => this.get<ApiSpecDetail>(`/apis/${id}`);
  /** The exact text get_api returns to agents. */
  apiText = (
    id: string,
    q: { endpoint?: string; schema?: string; search?: string; tag?: string } = {},
  ) => this.get<{ text: string }>(`/apis/${id}/text`, q);

  updateApi = (
    id: string,
    body: { name?: string; url?: string; filename?: string; content?: string },
  ) => this.send<ApiSpec>('PATCH', `/apis/${id}`, body);

  apiRaw = (id: string) =>
    firstValueFrom(this.http.get(`/api/apis/${id}/raw`, { responseType: 'text' }));

  refreshApi = (id: string) => this.send<ApiSpec>('POST', `/apis/${id}/refresh`);
  deleteApi = (id: string) => this.send<undefined>('DELETE', `/apis/${id}`);

  scopes = (level: { organization_id: string | null; project_id?: string | null }) =>
    this.get<Scope[]>('/scopes', {
      organization_id: lv(level.organization_id),
      project_id: level.project_id ?? undefined,
    });

  scope = (id: string) => this.get<ScopeDetail>(`/scopes/${id}`);
  createScope = (body: Partial<Scope> & { name: string; take_alias?: boolean }) =>
    this.send<Scope>('POST', '/scopes', body);

  updateScope = (id: string, body: Partial<Scope>) =>
    this.send<Scope>('PATCH', `/scopes/${id}`, body);

  deleteScope = (id: string) => this.send<undefined>('DELETE', `/scopes/${id}`);

  /** Rename a slug; with dry_run, only report what it touches. */
  renameSlug = (
    kind: SlugKind,
    id: string,
    body: { slug: string; rewrite_links?: boolean; take_alias?: boolean; dry_run?: boolean },
  ) =>
    this.send<SlugRename>(
      'POST',
      `/${kind === 'organization' ? 'organizations' : kind + 's'}/${id}/rename`,
      body,
    );

  deleteAlias = (id: string) => this.send<undefined>('DELETE', `/aliases/${id}`);

  documents = (level: Level) =>
    this.get<Doc[]>('/documents', {
      organization_id: lv(level.organization_id),
      project_id: level.project_id ?? undefined,
      scope_id: level.scope_id ?? undefined,
    });

  document = (id: string) => this.get<DocDetail>(`/documents/${id}`);
  createDocument = (body: Level & { kind: DocKind; title: string; mode?: EditMode }) =>
    this.send<Doc>('POST', '/documents', body);

  updateDocument = (
    id: string,
    body: Partial<Pick<Doc, 'title' | 'mode' | 'kind' | 'position'>> & { disabled?: boolean },
  ) => this.send<Doc>('PATCH', `/documents/${id}`, body);

  deleteDocument = (id: string) => this.send<undefined>('DELETE', `/documents/${id}`);
  addSection = (docId: string, body: { heading: string; body?: string; mode?: EditMode }) =>
    this.send<EditResult>('POST', `/documents/${docId}/sections`, body);

  reorder = (docId: string, ids: string[]) =>
    this.send<Section[]>('PUT', `/documents/${docId}/order`, { ids });

  section = (id: string) => this.get<Section>(`/sections/${id}`);
  updateSection = (
    id: string,
    body: {
      heading?: string;
      body?: string;
      mode?: EditMode;
      expected_version?: number;
      note?: string;
    },
  ) => this.send<EditResult>('PATCH', `/sections/${id}`, body);

  deleteSection = (id: string) => this.send<undefined>('DELETE', `/sections/${id}`);
  versions = (id: string) => this.get<SectionVersion[]>(`/sections/${id}/versions`);
  revert = (id: string, version: number) =>
    this.send<Section>('POST', `/sections/${id}/revert`, { version });

  findings = (
    q: { status?: FindingStatus[] | 'all'; organization_id?: string; project_id?: string } = {},
  ) =>
    this.get<Finding[]>('/findings', {
      ...q,
      status: Array.isArray(q.status) ? q.status.join(',') : q.status,
    });

  finding = (id: string) => this.get<Finding>(`/findings/${id}`);
  findingCounts = (q: { organization_id?: string; project_id?: string } = {}) =>
    this.get<FindingCounts>('/findings/counts', q);

  setFindingStatus = (
    id: string,
    body: { status: FindingStatus; note?: string; remind_after?: string | null },
  ) => this.send<Finding>('PUT', `/findings/${id}/status`, body);

  proposals = (status: ProposalStatus | 'all' = 'pending', level?: string) =>
    this.get<Proposal[]>('/proposals', { status, level });

  proposal = (id: string) => this.get<Proposal>(`/proposals/${id}`);
  review = (id: string) => this.get<Review>(`/proposals/${id}/review`);
  comment = (
    id: string,
    body: {
      body: string;
      thread_id?: string;
      line_start?: number;
      line_end?: number;
      suggestion?: string;
    },
  ) => this.send<ReviewThread>('POST', `/proposals/${id}/comments`, body);

  resolveThread = (threadId: string, resolved: boolean) =>
    this.send('PUT', `/threads/${threadId}/resolved`, { resolved });

  revise = (
    id: string,
    body: { body: string; heading?: string; note?: string; resolve?: string[] },
  ) => this.send<Proposal>('POST', `/proposals/${id}/revisions`, body);

  applySuggestion = (commentId: string) =>
    this.send<Proposal>('POST', `/comments/${commentId}/apply`);

  requestChanges = (id: string, note: string) =>
    this.send<Proposal>('POST', `/proposals/${id}/request-changes`, { note });

  proposalCounts = (level?: string) => this.get<ProposalCounts>('/proposals/counts', { level });
  approve = (
    id: string,
    body: { heading?: string; body?: string; note?: string; mode?: EditMode; target?: Level },
  ) =>
    this.send<{ proposal: Proposal; section: Section }>('POST', `/proposals/${id}/approve`, body);

  withdraw = (id: string) => this.send<undefined>('DELETE', `/proposals/${id}`);
  reject = (id: string, note?: string) =>
    this.send<Proposal>('POST', `/proposals/${id}/reject`, { note });

  context = (body: {
    project?: string;
    remote_url?: string;
    path?: string;
    stacks?: string[];
    scopes?: string[];
    manifests?: { path: string; content: string }[];
  }) => this.send<ContextResult>('POST', '/context', body);

  /** near_*: where the searcher is, ranked first; within narrows to that place. */
  search = (
    q: string,
    near: {
      near_project_id?: string;
      near_organization_id?: string;
      within?: 'project' | 'organization';
    } = {},
  ) => this.get<SearchHit[]>('/search', { q, ...near });

  graph = (opts: { focus?: string; depth?: number; missing?: boolean } = {}) =>
    this.get<Graph>('/graph', {
      focus: opts.focus,
      depth: opts.depth,
      missing: opts.missing ? '1' : undefined,
    });

  backlinks = (opts: { node?: string; project?: string }) =>
    this.get<{ source: GraphNode; refs: LinkRef[] }[]>('/backlinks', opts);

  resolveLink = (
    target: string,
    from: { project?: string | null; organization?: string | null } = {},
  ) =>
    this.get<LinkResolution>('/links/resolve', {
      target,
      from_project: from.project ?? undefined,
      from_organization: from.organization ?? undefined,
    });

  linkTargets = (q: string) => this.get<LinkTarget[]>('/link-targets', { q });

  members = () => this.get<Member[]>('/members');
  createMember = (body: {
    name: string;
    kind: 'human' | 'agent';
    organization_id: string | null;
    role?: Role;
  }) => this.send<{ actor: Member; token: string }>('POST', '/members', body);

  updateMember = (
    id: string,
    body: { name?: string; disabled?: boolean; review?: AgentReview; accept_findings?: boolean },
  ) =>
    this.send('PATCH', `/members/${id}`, body);

  addMembership = (actorId: string, body: { organization_id: string | null; role: Role }) =>
    this.send('POST', `/members/${actorId}/memberships`, body);

  updateMembership = (id: string, role: Role) => this.send('PATCH', `/memberships/${id}`, { role });
  removeMembership = (id: string) => this.send<undefined>('DELETE', `/memberships/${id}`);
  issueToken = (actorId: string, label: string) =>
    this.send<{ token: string }>('POST', `/members/${actorId}/tokens`, { label });

  revokeToken = (id: string) => this.send<undefined>('DELETE', `/tokens/${id}`);
}
