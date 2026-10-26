/** Shapes identical on server and web live in @openpurpose/contracts; the rest are API response shapes. */
import type { Actor, DocKind, EditMode, GraphNode, GroupRef, ProposalKind, ProposalStatus, Repository, Role, Scope, SlugAlias } from '@openpurpose/contracts';

export type {
  Actor, ActorKind, DocKind, EditMode, Graph, GraphEdge, GraphNode, GroupRef, LinkRef, LinkResolution, NodeType,
  ProposalCounts, ProposalKind, ProposalStatus, Repository, Review, ReviewComment, ReviewEvent, ReviewRevision,
  ReviewThread, Role, Scope, SlugAlias, SlugKind, SlugRename, SlugRenameRef,
} from '@openpurpose/contracts';

export const EDIT_MODES: EditMode[] = ['locked', 'propose', 'open'];
export const DOC_KINDS: DocKind[] = ['purpose', 'business_logic', 'glossary', 'guidelines', 'reference', 'learnings'];

export const KIND_LABEL: Record<DocKind, string> = {
  purpose: 'Purpose',
  business_logic: 'Business logic',
  glossary: 'Glossary',
  guidelines: 'Guidelines',
  reference: 'Reference',
  learnings: 'Learnings',
};

export const MODE_LABEL: Record<EditMode, string> = {
  locked: 'Locked',
  propose: 'Agents propose',
  open: 'Agents edit',
};

export const MODE_HELP: Record<EditMode, string> = {
  locked: 'Agents can read this but not change it or suggest changes.',
  propose: 'Agent changes arrive in the inbox for a human to approve.',
  open: 'Agents can change this directly. Every change is kept in history.',
};

export const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer', agent: 'Agent' };

export interface Organization {
  id: string;
  slug: string;
  name: string;
  summary: string;
  created_at: string;
  archived_at: string | null;
  readable: boolean;
  role: Role | null;
  projects: number | null;
  /** Organizations whose members may read this one. */
  readers: string[];
  /** Old slugs it still answers to. */
  aliases: SlugAlias[];
}

export interface Me {
  actor: Actor;
  groups: GroupRef[];
  group: GroupRef & { role: Role | null; can_admin: boolean; can_edit: boolean };
  organizations: Organization[];
  current_organization_id: string | null;
  /** Set while agent mode is on. */
  agent_view: { organization_id: string; readable_organization_ids: string[]; switchable_organization_ids: string[] } | null;
  pending_proposals: number;
  public_url: string;
  version: string;
}

export interface OrgRef {
  id: string;
  slug: string;
  name: string;
}

export interface Project {
  id: string;
  organization_id: string;
  organization_slug?: string;
  organization_name?: string;
  slug: string;
  name: string;
  summary: string;
  reviewed: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  repository_count?: number;
  pending_proposals?: number;
}

export interface Doc {
  id: string;
  organization_id: string | null;
  project_id: string | null;
  scope_id: string | null;
  kind: DocKind;
  slug: string;
  title: string;
  mode: EditMode;
  position: number;
  updated_at: string;
}

export interface Section {
  id: string;
  document_id: string;
  heading: string;
  body: string;
  mode: EditMode;
  position: number;
  version: number;
  updated_at: string;
  updated_by: string | null;
  updated_by_name: string | null;
}

export interface DocDetail extends Doc {
  sections: Section[];
  project: Project | null;
  scope: Scope | null;
  organization: OrgRef | null;
  can_edit: boolean;
}

export interface ProjectDetail extends Project {
  organization: OrgRef;
  can_edit: boolean;
  repositories: Repository[];
  scopes: Scope[];
  documents: Doc[];
  apis: ApiSpec[];
  aliases: SlugAlias[];
}

/** An OpenAPI / Swagger spec attached to a project. */
export interface ApiSpec {
  id: string;
  project_id: string;
  name: string;
  source_url: string | null;
  filename: string | null;
  source_format: 'json' | 'yaml';
  spec_version: string;
  title: string;
  version: string;
  endpoint_count: number;
  schema_count: number;
  fetched_at: string | null;
  fetch_error: string | null;
  updated_at: string;
  updated_by_name: string | null;
}

export interface ApiOperationRow {
  key: string;
  method: string;
  path: string;
  summary: string;
  operation_id: string;
  tags: string[];
  deprecated: boolean;
}

export interface ApiSpecDetail extends ApiSpec {
  can_edit: boolean;
  description: string;
  servers: string[];
  operations: ApiOperationRow[];
  schemas: string[];
}

export interface ScopeDetail extends Scope {
  documents: Doc[];
  project: Project | null;
  /** The project's repositories, to pick from (empty for organization and group scopes). */
  repositories: Repository[];
  organization: OrgRef | null;
  can_edit: boolean;
  aliases: SlugAlias[];
}

export interface SectionVersion {
  id: string;
  version: number;
  heading: string;
  body: string;
  mode: EditMode;
  actor_name: string | null;
  note: string;
  created_at: string;
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  organization_id: string | null;
  organization_slug: string | null;
  organization_name: string | null;
  can_review: boolean;
  project_id: string | null;
  scope_id: string | null;
  document_id: string | null;
  section_id: string | null;
  base_version: number | null;
  heading: string;
  body: string;
  rationale: string;
  context: { remote?: string | null; path?: string | null; stacks?: string[]; manifests?: string[] };
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  reviewed_at: string | null;
  review_note: string;
  result_section_id: string | null;
  project_slug: string | null;
  project_name: string | null;
  scope_slug: string | null;
  scope_name: string | null;
  document_title: string | null;
  current_heading: string | null;
  current_body: string | null;
  current_version: number | null;
  created_by_kind: 'human' | 'agent' | null;
  reviewed_by_name: string | null;
  result_document_id: string | null;
  section_mode: EditMode | null;
  document_mode: EditMode | null;
  revision: number;
  updated_at: string;
  open_threads: number;
  comment_count: number;
  awaiting: 'review' | 'author' | null;
}

export type EditResult = { status: 'applied'; section: Section } | { status: 'proposed'; proposal: Proposal };

export interface ContextResult {
  group: { name: string };
  organization: OrgRef | null;
  project: Project | null;
  resolution: { via: string | null; remote: { key: string } | null; suggestions: Array<{ slug: string; name: string; organization_slug: string }> };
  path: string;
  stacks: string[];
  blocks: Array<{
    level: string;
    label: string;
    scope: { slug: string; name: string; reason: string } | null;
    documents: Array<{ id: string; kind: DocKind; title: string; sections: Section[] }>;
  }>;
  learning_target: { label: string };
  related: Array<{ direction: 'uses' | 'used_by'; node: GraphNode }>;
  apis: Array<ApiSpec & { project_ref: string; project_name: string; relation: 'this' | 'uses' | 'used_by' }>;
  markdown: string;
}

export interface TokenRow {
  id: string;
  prefix: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface Member extends Actor {
  created_at: string;
  disabled_at: string | null;
  memberships: Array<{ id: string; organization_id: string | null; role: Role }>;
  tokens: Array<{ id: string; prefix: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>;
  manageable: boolean;
}

export interface GroupRow extends GroupRef {
  created_at: string;
  organizations: number;
  members: number;
}

export interface SearchHit {
  organization_slug: string | null;
  section_id: string;
  heading: string;
  snippet: string;
  mode: EditMode;
  document_id: string;
  document_title: string;
  project_slug: string | null;
  scope_slug: string | null;
}

export interface LinkTarget {
  type: 'project' | 'term';
  value: string;
  label: string;
  where: string;
}

/** Where a document or learning lives. All null = group-wide. */
export interface Level {
  organization_id: string | null;
  project_id?: string | null;
  scope_id?: string | null;
}
