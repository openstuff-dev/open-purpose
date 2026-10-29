/**
 * Types the server sends and the web app reads, defined once.
 *
 * Declarations only: nothing here exists at runtime, so this package has no
 * build step and compiles the same under the server's and the web's
 * TypeScript versions. Import with `import type`.
 *
 * Only shapes that are identical on both sides belong here. Where the server
 * works with a database row and the API returns a richer object (Proposal,
 * Organization, Section, …), each side keeps its own type for now.
 */

// ───────────────────────────── vocabulary ─────────────────────────────

export type EditMode = 'locked' | 'propose' | 'open';
export type DocKind =
  'purpose' | 'business_logic' | 'glossary' | 'guidelines' | 'reference' | 'learnings';
export type ProposalKind = 'edit_section' | 'new_section' | 'learning' | 'new_scope';

/** What a new_scope proposal creates, besides its name (heading) and description (body). */
export interface ScopeSpec {
  slug: string;
  path_globs: string[];
  stacks: string[];
  /** Repositories of the project the scope is bound to. */
  repository_ids: string[];
}
export type ProposalStatus = 'pending' | 'changes_requested' | 'approved' | 'rejected';
export type ActorKind = 'human' | 'agent';
export type Role = 'admin' | 'editor' | 'viewer' | 'agent';

// ───────────────────────────── people and places ─────────────────────────────

export interface Actor {
  id: string;
  name: string;
  kind: ActorKind;
  is_superadmin: boolean;
}

// ───────────────────────────── signing in ─────────────────────────────

/**
 * What happens to someone the server doesn't know yet. off: they can't sign in; approval: they
 * wait for a server admin; open: they get their own workspace at once.
 */
export type SignupMode = 'off' | 'approval' | 'open';

/** One way to sign in that the server's provider offers. */
export type AuthMethod = { kind: 'magic_link' } | { kind: 'oauth'; provider: string; label: string };

/** GET /api/auth/config: what the sign-in page shows. Needs no token. */
export interface AuthConfig {
  signup: SignupMode;
  /** Empty when no provider is set up: then only access tokens sign in. */
  methods: AuthMethod[];
  /** The marketing site, for a "Back to …" link. */
  site_url: string | null;
}

/** POST /api/auth/start. Needs no token. */
export interface AuthStartRequest {
  method: AuthMethod;
  /** Required for a magic link. */
  email?: string;
}

/** Either go to `redirect` (OAuth), or tell the person to check their inbox (magic link). */
export interface AuthStartResult {
  redirect: string | null;
  email_sent: boolean;
}

/**
 * Why the sign-in callback sent someone back to /sign-in?error=…
 * no-account: unknown and sign-up is off. rejected: an admin turned their sign-up down.
 * disabled: their account is turned off. other-browser: the link was opened in another browser.
 * failed: the provider said no, or something else went wrong.
 */
export type SignInErrorCode = 'no-account' | 'rejected' | 'disabled' | 'other-browser' | 'failed';

/** Where someone who signed up is. null = an admin added them. */
export type SignupStatus = 'pending' | 'approved' | 'rejected';

/** GET /api/auth/status: works without a workspace, so a pending person can see where they are. */
export interface AuthStatus {
  name: string;
  email: string | null;
  signup: SignupStatus | null;
}

/** GET /api/signups: someone who signed up, for server admins. */
export interface PendingSignup {
  id: string;
  name: string;
  email: string | null;
  /** The provider they first signed in with, e.g. 'supabase'. */
  provider: string;
  /** How they signed in there, e.g. 'github' or 'email'; null when the provider doesn't say. */
  method: string | null;
  signup: SignupStatus;
  signup_at: string;
}

/**
 * How much review an agent's writes get. edit_modes: follow each section's edit mode.
 * always_propose: propose even in open sections. auto_approve: approve its proposals in its
 * own organization as soon as they arrive.
 */
export type AgentReview = 'edit_modes' | 'always_propose' | 'auto_approve';

/** What an admin lets one agent do without a person's review. */
export interface AgentPermissions {
  review: AgentReview;
  /** File the agent's findings as to do instead of new. */
  accept_findings: boolean;
  /** Who last changed them, and when. null = never changed. */
  set_by_name: string | null;
  set_at: string | null;
}

export interface GroupRef {
  id: string;
  slug: string;
  name: string;
}

export interface Repository {
  id: string;
  project_id: string;
  remote_key: string;
  remote_url: string;
  created_at: string;
}

export interface Scope {
  id: string;
  organization_id: string | null;
  project_id: string | null;
  slug: string;
  name: string;
  description: string;
  path_globs: string[];
  stacks: string[];
  /**
   * Project scopes only: the repositories it is bound to. Empty = any repository of the project.
   */
  repository_ids: string[];
  position: number;
}

// ───────────────────────────── proposals and reviews ─────────────────────────────

export interface ProposalCounts {
  pending: number;
  changes_requested: number;
  approved: number;
  rejected: number;
}

export interface ReviewComment {
  id: string;
  thread_id: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_kind: ActorKind | null;
  body: string;
  suggestion: string | null;
  applied_at: string | null;
  applied_by_name: string | null;
  created_at: string;
}

export interface ReviewThread {
  id: string;
  proposal_id: string;
  revision: number;
  line_start: number | null;
  line_end: number | null;
  anchor: string;
  resolved_at: string | null;
  resolved_by_name: string | null;
  created_by: string | null;
  created_at: string;
  /** The lines no longer read the same in the current revision. */
  outdated: boolean;
  comments: ReviewComment[];
}

export interface ReviewRevision {
  revision: number;
  heading: string;
  body: string;
  note: string;
  actor_name: string | null;
  actor_kind: ActorKind | null;
  created_at: string;
}

export interface ReviewEvent {
  id: string;
  kind: 'proposed' | 'revised' | 'changes_requested' | 'approved' | 'rejected' | 'commented';
  revision: number;
  note: string;
  actor_name: string | null;
  actor_kind: ActorKind | null;
  created_at: string;
}

export interface Review {
  proposal_id: string;
  revision: number;
  revisions: ReviewRevision[];
  threads: ReviewThread[];
  events: ReviewEvent[];
  can_comment: boolean;
  can_revise: boolean;
  can_review: boolean;
}

// ───────────────────────────── findings ─────────────────────────────

/**
 * new: reported, nobody has looked at it. todo: worth fixing; agents may pick it up.
 * ask_later: a person must decide first; agents mention it but don't fix it.
 * dismissed: not a problem, or not worth it. solved: fixed, with the commit or PR.
 */
export type FindingStatus = 'new' | 'todo' | 'ask_later' | 'dismissed' | 'solved';

export interface Finding {
  id: string;
  organization_id: string;
  project_id: string;
  scope_id: string | null;
  status: FindingStatus;
  file: string;
  line_start: number | null;
  line_end: number | null;
  title: string;
  problem: string;
  proposed_fix: string;
  commit_sha: string | null;
  remote: string | null;
  remind_after: string | null;
  solved_ref: string | null;
  created_by_name: string | null;
  created_by_kind: ActorKind | null;
  created_at: string;
  status_by_name: string | null;
  status_at: string | null;
  status_note: string;
  updated_at: string;
  organization_slug: string;
  project_slug: string;
  project_name: string;
  scope_name: string | null;
  /** Organization › project › scope. */
  where: string;
  /** The viewer may change its status (people with edit rights; agents only to solved). */
  can_triage: boolean;
}

export type FindingCounts = Record<FindingStatus, number>;

// ───────────────────────────── the link graph (map) ─────────────────────────────

export type NodeType = 'group' | 'organization' | 'project' | 'term' | 'missing';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  /** Project slug for projects. */
  slug: string | null;
  summary: string;
  organization_id: string | null;
  organization_slug: string | null;
  project_id: string | null;
  /** True when the viewer may not read this node's content. */
  restricted: boolean;
}

export interface LinkRef {
  section_id: string;
  heading: string;
  document_title: string;
  /** Where the referring section lives, for display. */
  location: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'link' | 'defines';
  count: number;
  refs: LinkRef[];
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  organizations: { id: string; slug: string; name: string; readable: boolean }[];
}

/** One [[link]] resolved for navigation. */
export type LinkResolution =
  | {
    type: 'project';
    id: string;
    slug: string;
    name: string;
    organization_slug: string | null;
    restricted: boolean;
  } |
  { type: 'term'; section_id: string; document_id: string; heading: string; restricted: boolean } |
  { type: 'missing'; target: string };

// ───────────────────────────── slug renames ─────────────────────────────

export type SlugKind = 'organization' | 'project' | 'scope';

/** An old slug that still resolves to its organization, project or scope. */
export interface SlugAlias {
  id: string;
  old_slug: string;
  created_at: string;
}

/** A section with [[links]] that use the old slug. */
export interface SlugRenameRef extends LinkRef {
  document_id: string;
  /** How many links in the section use the old slug. */
  links: number;
}

/** What renaming a slug touches; with `applied` false it is a preview. */
export interface SlugRename {
  kind: SlugKind;
  from: string;
  to: string;
  applied: boolean;
  /** Something else here used to be called `to`. Renaming takes the name over from it. */
  alias_of: { id: string; name: string; slug: string } | null;
  /** Sections whose links get the new slug (or got it, once applied). */
  rewrite: SlugRenameRef[];
  /**
   * Sections that use the old slug but the viewer can't edit. They keep working through the alias.
   */
  cannot_edit: SlugRenameRef[];
  /** Repositories mapped to the project(s), whose .openpurpose.json may name the old slug. */
  repositories: number;
  /** Open proposals that mention the old slug. They are not rewritten. */
  open_proposals: number;
}

// ───────────────────────────── agent activity ─────────────────────────────

/** The overview's window: the last 7 or 30 days (today included), or everything. */
export type ActivityPeriod = '7d' | '30d' | 'all';

/** A document agents haven't requested for a week or a month, while it existed. */
export type Staleness = 'week' | 'month';

/** How often something happened in a period. */
export interface ActivityFigure {
  count: number;
  /** The same count for the period just before; null for all time. */
  previous: number | null;
  /** One count per day of `OrgActivity.days`. */
  daily: number[];
}

export interface OrgActivity {
  period: ActivityPeriod;
  /**
   * The days the `daily` arrays cover, as YYYY-MM-DD, oldest first. All time shows the last 53
   * weeks.
   */
  days: string[];
  /** When the first agent request in the group was recorded; null = none yet. */
  tracking_since: string | null;
  reads: ActivityFigure;
  writes: ActivityFigure;
  /** Top 3 each, most first. Documents include the group-wide ones every organization gets. */
  most_read_documents: (ActivityFigure & { id: string; title: string; where: string })[];
  most_read_projects: (ActivityFigure & { id: string; name: string; slug: string })[];
  most_written_documents: (ActivityFigure & { id: string; title: string; where: string })[];
  top_writers: (ActivityFigure & { id: string; name: string })[];
  /** Enabled documents agents stopped requesting: week-stale for 7d, month-stale otherwise. */
  stale_documents: {
    id: string;
    title: string;
    where: string;
    staleness: Staleness;
    last_read_at: string | null;
  }[];
}

/** How often agents requested one section. */
export interface SectionActivity {
  /** All time. */
  reads: number;
  last_read_at: string | null;
  /** The last 28 days, oldest first, today last. */
  daily: number[];
  /** Reads in the last 7 days, and in the 7 days before. */
  week: number;
  previous_week: number;
}

/** What the document page and document lists add to a document. */
export interface DocumentActivity {
  disabled_at: string | null;
  staleness: Staleness | null;
  last_read_at: string | null;
}

// ───────────────────────────── export and import ─────────────────────────────

/**
 * A group or organization written to one JSON file, to back it up or move it to
 * another OpenPurpose server. Every row has a `key` (its id on the server it came
 * from) that other rows refer to; an import gives every row a new id.
 * Tokens are never exported.
 */
export interface ExportFile {
  format: 'openpurpose-export';
  version: 1;
  exported_at: string;
  server_version: string;
  source: {
    kind: 'group' | 'organization';
    /** context_max_tokens is missing in files from before context budgets; null = no limit. */
    group: { slug: string; name: string; context_max_tokens?: number | null };
    /** Key of the exported organization. */
    organization: string | null;
  };
  includes: ExportIncludes;
  /** Empty unless `includes.people`. Without people, every actor reference is null. */
  people: ExportPerson[];
  organizations: ExportOrganization[];
  read_grants: { reader: string; target: string }[];
  projects: ExportProject[];
  api_specs: ExportApiSpec[];
  scopes: ExportScope[];
  documents: ExportDocument[];
  proposals: ExportProposal[];
  /** Empty unless `includes.findings`, and in files from before findings. */
  findings: ExportFinding[];
}

export interface ExportIncludes {
  /** Earlier versions of every section. */
  history: boolean;
  /** Proposals with their revisions, review threads and comments. */
  proposals: boolean;
  /** Names and memberships of people and agents (never tokens). */
  people: boolean;
  api_specs: boolean;
  /** Findings, solved and dismissed ones too. false in files from before findings. */
  findings: boolean;
}

export interface ExportPerson {
  key: string;
  name: string;
  kind: ActorKind;
  /** organization null = a role in the group itself. */
  memberships: { organization: string | null; role: Role }[];
  /** Agents only. Missing in files from before agent permissions. */
  permissions?: { review: AgentReview; accept_findings: boolean };
}

export interface ExportOrganization {
  key: string;
  slug: string;
  name: string;
  summary: string;
  created_at: string;
  archived_at: string | null;
  aliases: string[];
  /** Missing in files from before context budgets; null = no limit. */
  context_max_tokens?: number | null;
}

export interface ExportProject {
  key: string;
  organization: string;
  slug: string;
  name: string;
  summary: string;
  reviewed: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  aliases: string[];
  repositories: {
    key: string;
    remote_key: string;
    remote_url: string;
    created_by: string | null;
    created_at: string;
  }[];
}

export interface ExportApiSpec {
  key: string;
  project: string;
  name: string;
  source_url: string | null;
  filename: string | null;
  spec: unknown;
  source_format: 'json' | 'yaml';
  spec_version: string;
  title: string;
  version: string;
  endpoint_count: number;
  schema_count: number;
  content_hash: string;
  fetched_at: string | null;
  fetch_error: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExportScope {
  key: string;
  /** null for group-wide scopes. */
  organization: string | null;
  project: string | null;
  slug: string;
  name: string;
  description: string;
  path_globs: string[];
  stacks: string[];
  position: number;
  created_at: string;
  updated_at: string;
  aliases: string[];
  /** Keys of the project's repositories the scope is bound to. */
  repositories: string[];
}

export interface ExportDocument {
  key: string;
  /** All null for group-wide documents. */
  organization: string | null;
  project: string | null;
  scope: string | null;
  kind: DocKind;
  slug: string;
  title: string;
  mode: EditMode;
  position: number;
  created_at: string;
  updated_at: string;
  /** Missing in files from before documents could be disabled; null = enabled. */
  disabled_at?: string | null;
  sections: ExportSection[];
}

export interface ExportSection {
  key: string;
  heading: string;
  /** Markdown. */
  body: string;
  mode: EditMode;
  position: number;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  /** Every version, oldest first. Empty unless `includes.history`. */
  versions: {
    version: number;
    heading: string;
    body: string;
    mode: EditMode;
    actor: string | null;
    note: string;
    created_at: string;
  }[];
}

export interface ExportProposal {
  key: string;
  kind: ProposalKind;
  status: ProposalStatus;
  organization: string | null;
  project: string | null;
  scope: string | null;
  document: string | null;
  section: string | null;
  result_section: string | null;
  /** new_scope proposals: the scope it created. Missing in files from before scope proposals. */
  result_scope?: string | null;
  /** new_scope proposals: the paths, stacks and repositories it asks for. */
  scope_spec?: ScopeSpec | null;
  base_version: number | null;
  heading: string;
  body: string;
  rationale: string;
  context: Record<string, unknown>;
  revision: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string;
  /** Approved without review. Missing in files from before agent permissions. */
  auto_approved?: boolean;
  revisions: {
    revision: number;
    heading: string;
    body: string;
    note: string;
    actor: string | null;
    created_at: string;
  }[];
  events: {
    kind: ReviewEvent['kind'];
    revision: number;
    note: string;
    actor: string | null;
    created_at: string;
  }[];
  threads: {
    revision: number;
    line_start: number | null;
    line_end: number | null;
    anchor: string;
    resolved_at: string | null;
    resolved_by: string | null;
    created_by: string | null;
    created_at: string;
    comments: {
      actor: string | null;
      body: string;
      suggestion: string | null;
      applied_at: string | null;
      applied_by: string | null;
      created_at: string;
    }[];
  }[];
}

export interface ExportFinding {
  key: string;
  organization: string;
  project: string;
  scope: string | null;
  status: FindingStatus;
  file: string;
  line_start: number | null;
  line_end: number | null;
  title: string;
  problem: string;
  proposed_fix: string;
  commit_sha: string | null;
  remote: string | null;
  context: Record<string, unknown>;
  remind_after: string | null;
  solved_ref: string | null;
  created_by: string | null;
  created_at: string;
  status_by: string | null;
  status_at: string | null;
  status_note: string;
  updated_at: string;
}

/** How a changed section in a merge is handled. */
export type ImportChangePolicy = 'propose' | 'file' | 'keep';

/** What to do with one organization of the file. */
export type ImportOrgChoice =
  { action: 'new'; slug?: string } | { action: 'merge'; into: string } | { action: 'skip' };

export interface ImportOptions {
  /**
   * By organization key. Without a choice, an organization is imported as new (left out for
   * non-group-admins).
   */
  organizations?: Record<string, ImportOrgChoice>;
  /** Merge the file's group-wide content into this group's. A new group always gets it. */
  group_content?: boolean;
  /** For sections that differ. Default: propose. */
  changes?: ImportChangePolicy;
  /** Per section, by section key; overrides `changes`. */
  section_changes?: Record<string, ImportChangePolicy>;
  /**
   * In merged organizations: delete sections, documents and scopes, and archive projects, that
   * aren't in the file.
   */
  remove_missing?: boolean;
}

/** A section in a merged document. */
export interface ImportChange {
  /** The section's key in the file; null when it is only here. */
  key: string | null;
  target_id: string | null;
  /** "Organization › Project › Document". */
  place: string;
  status: 'new' | 'changed' | 'only_in_target' | 'conflict';
  action: 'add' | 'propose' | 'file' | 'keep' | 'remove' | 'skip';
  reason: string | null;
  before: { heading: string; body: string; mode: EditMode } | null;
  after: { heading: string; body: string; mode: EditMode } | null;
}

/** What an import does (or, as a preview, would do). */
export interface ImportReport {
  /**
   * false when a conflict blocks the import; `organizations` and `group` say which slug to change.
   */
  ok: boolean;
  applied: boolean;
  source: ExportFile['source'] & { exported_at: string };
  /** Set when the file becomes a new group. */
  group: {
    id: string | null;
    name: string;
    slug: string;
    conflict: string | null;
    suggested_slug: string | null;
  } | null;
  organizations: {
    key: string;
    name: string;
    /** The slug in the file. */
    slug: string;
    action: ImportOrgChoice['action'];
    /** The slug a new organization gets. */
    new_slug: string | null;
    into: { id: string; name: string } | null;
    /**
     * An organization here that already answers to the file's slug: the natural one to merge into.
     */
    existing: { id: string; name: string } | null;
    conflict: string | null;
    suggested_slug: string | null;
    /** Set once applied. */
    id: string | null;
  }[];
  /** Group-wide content in the file, and whether it is imported. */
  group_content: { documents: number; scopes: number; proposals: number; included: boolean };
  /** New rows. */
  counts: {
    people: number;
    projects: number;
    repositories: number;
    api_specs: number;
    scopes: number;
    documents: number;
    sections: number;
    section_versions: number;
    proposals: number;
    findings: number;
  };
  /** Rows matched to ones already here, and what happened to them. */
  merged: {
    people: number;
    projects: number;
    api_specs: number;
    scopes: number;
    documents: number;
    sections: number;
    unchanged: number;
    proposed: number;
    updated: number;
    kept: number;
    removed: number;
    conflicts: number;
  };
  /** Sections of merged documents that are new, changed, only here or in conflict. */
  changes: ImportChange[];
  /** Things left out or worth knowing, and why. */
  warnings: string[];
}
