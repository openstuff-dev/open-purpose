import type { DocKind, EditMode, ProposalKind, ProposalStatus } from '@openpurpose/contracts';

export type { DocKind, EditMode, ProposalKind, ProposalStatus, Repository, Scope } from '@openpurpose/contracts';

/** Still being worked on: waiting for a review, or for the author after changes were requested. */
export const OPEN_STATUSES: ProposalStatus[] = ['pending', 'changes_requested'];

export const EDIT_MODES: EditMode[] = ['locked', 'propose', 'open'];
export const DOC_KINDS: DocKind[] = ['purpose', 'business_logic', 'glossary', 'guidelines', 'reference', 'learnings'];

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
  /** Largest get_context, in estimated tokens, before general sections are shortened. null = no limit. */
  context_max_tokens: number | null;
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
  position: number;
  version: number;
  updated_at: string;
  updated_by: string | null;
  updated_by_name?: string | null;
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
  revision: number;
  updated_at: string;
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
