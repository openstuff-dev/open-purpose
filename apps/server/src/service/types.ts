import type {
  DocKind,
  EditMode,
  ProposalKind,
  ProposalStatus,
  ScopeSpec,
  DocumentSpec,
  Website,
} from '@openpurpose/contracts';

export type {
  DocKind,
  DocumentSpec,
  EditMode,
  ProposalKind,
  ProposalStatus,
  Repository,
  Scope,
  Website,
} from '@openpurpose/contracts';

/** Still being worked on: waiting for a review, or for the author after changes were requested. */
export const OPEN_STATUSES: ProposalStatus[] = ['pending', 'changes_requested'];

export const EDIT_MODES: EditMode[] = ['locked', 'propose', 'open'];
export const DOC_KINDS: DocKind[] = [
  'purpose',
  'business_logic',
  'glossary',
  'guidelines',
  'reference',
  'learnings',
];
/** Kinds an agent may propose a document of. Learnings documents are made when one is approved. */
export const PROPOSABLE_DOC_KINDS = DOC_KINDS.filter(
  (k): k is DocumentSpec['kind'] => k !== 'learnings',
);

/** Order in which document kinds appear inside one level of the context. */
export const KIND_ORDER: Record<DocKind, number> = {
  purpose: 0,
  business_logic: 1,
  glossary: 2,
  guidelines: 3,
  reference: 4,
  learnings: 5,
};

export interface Group {
  id: string;
  slug: string;
  name: string;
  created_at: string;
}

export interface Organization {
  id: string;
  slug: string;
  name: string;
  summary: string;
  /**
   * Largest get_context, in estimated tokens, before general sections are shortened. null = no
   * limit.
   */
  context_max_tokens: number | null;
  websites: Website[];
  created_at: string;
  archived_at: string | null;
}

export interface Project {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  summary: string;
  reviewed: boolean;
  websites: Website[];
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface Document {
  id: string;
  organization_id: string | null;
  project_id: string | null;
  scope_id: string | null;
  kind: DocKind;
  slug: string;
  title: string;
  mode: EditMode;
  position: number;
  created_at: string;
  updated_at: string;
  /** Disabled documents stay here, but agents don't get them. */
  disabled_at: string | null;
}

export interface Section {
  id: string;
  document_id: string;
  heading: string;
  body: string;
  mode: EditMode;
  /** Agents always get it in full, even where the rest is first sentences. */
  pinned: boolean;
  position: number;
  version: number;
  updated_at: string;
  updated_by: string | null;
  updated_by_name?: string | null;
  /** Archived sections stay in their document but agents don't get them. */
  archived_at: string | null;
  archived_by_name?: string | null;
}

export interface SectionVersion {
  id: string;
  section_id: string;
  version: number;
  heading: string;
  body: string;
  mode: EditMode;
  actor_id: string | null;
  actor_name: string | null;
  note: string;
  created_at: string;
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  organization_id: string | null;
  project_id: string | null;
  scope_id: string | null;
  document_id: string | null;
  section_id: string | null;
  base_version: number | null;
  heading: string;
  body: string;
  rationale: string;
  context: Record<string, unknown>;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string;
  result_section_id: string | null;
  /** new_scope only: slug, paths, stacks and repositories of the scope to create. */
  scope_spec: ScopeSpec | null;
  /** new_scope only: the scope created on approval. */
  result_scope_id: string | null;
  /** new_document only: kind and slug of the document to create. document_id is set on approval. */
  document_spec: DocumentSpec | null;
  /** move_section only: the document the section moves to, and its position there (null = last). */
  target_document_id: string | null;
  target_position: number | null;
  revision: number;
  updated_at: string;
  /** Approved without review: an admin lets the agent who made it skip review. */
  auto_approved: boolean;
}

/**
 * Where a document (or learning) lives. All null = group-wide.
 * organization_id only = one organization. project_id implies its organization.
 * scope_id = a scope at any of those levels.
 */
export interface Level {
  organization_id: string | null;
  project_id: string | null;
  scope_id: string | null;
}

export const GROUP_LEVEL: Level = { organization_id: null, project_id: null, scope_id: null };
