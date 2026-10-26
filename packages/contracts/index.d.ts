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
export type DocKind = 'purpose' | 'business_logic' | 'glossary' | 'guidelines' | 'reference' | 'learnings';
export type ProposalKind = 'edit_section' | 'new_section' | 'learning';
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
  /** Project scopes only: the repositories it is bound to. Empty = any repository of the project. */
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
  organizations: Array<{ id: string; slug: string; name: string; readable: boolean }>;
}

/** One [[link]] resolved for navigation. */
export type LinkResolution =
  | { type: 'project'; id: string; slug: string; name: string; organization_slug: string | null; restricted: boolean }
  | { type: 'term'; section_id: string; document_id: string; heading: string; restricted: boolean }
  | { type: 'missing'; target: string };

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
  /** Sections that use the old slug but the viewer can't edit. They keep working through the alias. */
  cannot_edit: SlugRenameRef[];
  /** Repositories mapped to the project(s), whose .agentcontext.json may name the old slug. */
  repositories: number;
  /** Open proposals that mention the old slug. They are not rewritten. */
  open_proposals: number;
}
