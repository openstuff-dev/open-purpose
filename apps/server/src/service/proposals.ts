import type { Access } from '../auth.js';
import type { Db, Queryable } from '../db.js';
import { tx } from '../db.js';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';
import { slugify } from '../domain/remote.js';
import { normalizeTags } from '../domain/stacks.js';
import {
  parseDocumentBody,
  parseScopeBody,
  renderDocumentBody,
  renderScopeBody,
  type SectionDraft,
} from '../domain/document-body.js';
import {
  applySectionChange,
  archiveSectionRow,
  assertMode,
  checkVersion,
  cleanGlobs,
  createScope,
  documentsAt,
  ensureLearningsDocument,
  getDocument,
  getSection,
  insertDocument,
  insertScope,
  insertSection,
  loadDocument,
  loadSection,
  moveSectionRow,
  resolveDocumentRef,
  resolveLevel,
  type ScopeInput,
  type SectionChange,
  type SectionInput,
} from './content.js';
import { agentRules, autoApproves, type AgentRules } from './permissions.js';
import {
  PROPOSABLE_DOC_KINDS,
  type Document,
  type EditMode,
  type Level,
  type Proposal,
  type ProposalStatus,
  type Scope,
  type Section,
} from './types.js';
import type { DocumentSpec, ProposalCounts, ScopeSpec } from '@openpurpose/contracts';

const PROPOSAL_COLS = `x.id, x.kind, x.status, x.organization_id, x.project_id, x.scope_id, x.document_id, x.section_id,
  x.base_version, x.heading, x.body, x.rationale, x.context, x.created_by, a.name AS created_by_name,
  x.created_at, x.reviewed_by, x.reviewed_at, x.review_note, x.result_section_id, x.scope_spec, x.result_scope_id,
  x.document_spec, x.target_document_id, x.target_position, x.revision, x.updated_at, x.auto_approved`;

export const isOpen = (status: ProposalStatus) =>
  status === 'pending' || status === 'changes_requested';

export async function addEvent(
  c: Queryable,
  a: Access,
  proposalId: string,
  kind: 'proposed' | 'revised' | 'changes_requested' | 'approved' | 'rejected' | 'commented',
  revision: number,
  note = '',
): Promise<void> {
  await c.query(
    'INSERT INTO proposal_events (proposal_id, kind, revision, note, actor_id) VALUES ($1, $2, $3, $4, $5)',
    [proposalId, kind, revision, note, a.actor.id],
  );
}

async function insertProposal(
  c: Queryable,
  a: Access,
  p: Partial<Proposal> & { kind: Proposal['kind']; body: string },
): Promise<Proposal> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO proposals (kind, organization_id, project_id, scope_id, document_id, section_id, base_version,
                            heading, body, rationale, context, created_by, scope_spec, document_spec,
                            target_document_id, target_position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [
      p.kind,
      p.organization_id ?? null,
      p.project_id ?? null,
      p.scope_id ?? null,
      p.document_id ?? null,
      p.section_id ?? null,
      p.base_version ?? null,
      p.heading ?? '',
      p.body,
      p.rationale ?? '',
      JSON.stringify(p.context ?? {}),
      a.actor.id,
      p.scope_spec ? JSON.stringify(p.scope_spec) : null,
      p.document_spec ? JSON.stringify(p.document_spec) : null,
      p.target_document_id ?? null,
      p.target_position ?? null,
    ],
  );
  const id = rows[0].id;
  await c.query(
    'INSERT INTO proposal_revisions (proposal_id, revision, heading, body, note, actor_id) VALUES ($1, 1, $2, $3, $4, $5)',
    [id, p.heading ?? '', p.body, p.rationale ?? '', a.actor.id],
  );
  await addEvent(c, a, id, 'proposed', 1, p.rationale ?? '');
  return loadProposal(c, id);
}

async function loadProposal(db: Queryable, id: string): Promise<Proposal> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Proposal');
  const { rows } = await db.query<Proposal>(
    `SELECT ${PROPOSAL_COLS} FROM proposals x LEFT JOIN actors a ON a.id = x.created_by WHERE x.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Proposal');
  return rows[0];
}

/**
 * A proposal's full id from its id or the first 8 characters of it, as tools answer with.
 * Prefixes only match proposals the actor can read.
 */
export async function resolveProposalRef(db: Queryable, a: Access, ref: string): Promise<string> {
  const r = ref.trim().toLowerCase();
  if (/^[0-9a-f-]{36}$/.test(r)) return r;
  if (!/^[0-9a-f-]{8,35}$/.test(r)) throw notFound('Proposal');
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM proposals
      WHERE id::text LIKE $1 || '%' AND (organization_id IS NULL OR organization_id = ANY($2::uuid[]))
      LIMIT 2`,
    [r, a.readableOrgIds()],
  );
  if (rows.length === 0) throw notFound('Proposal');
  if (rows.length > 1)
    throw badRequest(`Proposal id prefix "${ref}" is ambiguous; use more characters`);
  return rows[0].id;
}

export async function getProposal(db: Queryable, a: Access, id: string): Promise<Proposal> {
  const p = await loadProposal(db, await resolveProposalRef(db, a, id));
  a.requireRead(p.organization_id);
  return p;
}

export interface ProposalListItem extends Proposal {
  organization_slug: string | null;
  organization_name: string | null;
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
  /** move_section only: the document the section moves to, and where that document hangs. */
  target_document_title: string | null;
  target_location: string | null;
  /** new_scope only: the remote keys of the repositories it would be bound to. */
  scope_repositories: string[] | null;
  result_scope_slug: string | null;
  section_mode: EditMode | null;
  document_mode: EditMode | null;
  open_threads: number;
  comment_count: number;
  /**
   * Who has the next move: reviewers, or the author (changes requested, or unanswered comments).
   */
  awaiting: 'review' | 'author' | null;
  can_review: boolean;
}

export type { ProposalCounts } from '@openpurpose/contracts';

/**
 * Proposals the actor can read. `level`: 'group' for group-wide proposals only,
 * an organization id for one organization, or undefined for everything readable.
 */
/**
 * SQL (proposal aliased x): someone other than the author spoke last in an open
 * thread, after the author's latest revision. A revision counts as an answer.
 */
export const AUTHOR_OWES_REPLY = `EXISTS (
  SELECT 1 FROM review_threads t
   CROSS JOIN LATERAL (SELECT rc.actor_id, rc.created_at FROM review_comments rc
                        WHERE rc.thread_id = t.id ORDER BY rc.created_at DESC LIMIT 1) last
   WHERE t.proposal_id = x.id AND t.resolved_at IS NULL
     AND last.actor_id IS DISTINCT FROM x.created_by
     AND last.created_at > COALESCE((SELECT max(r.created_at) FROM proposal_revisions r
                                      WHERE r.proposal_id = x.id AND r.revision > 1 AND r.actor_id = x.created_by), '-infinity'))`;

export async function listProposals(
  db: Queryable,
  a: Access,
  opts: {
    status?: ProposalStatus | 'open';
    level?: string;
    projectId?: string;
    id?: string;
    createdBy?: string;
    limit?: number;
  } = {},
): Promise<ProposalListItem[]> {
  const orgFilter = opts.level && opts.level !== 'group' ? opts.level : null;
  if (orgFilter) a.requireRead(orgFilter);
  if (opts.id && !/^[0-9a-f-]{36}$/i.test(opts.id)) throw notFound('Proposal');
  const { rows } = await db.query<ProposalListItem>(
    `SELECT ${PROPOSAL_COLS}, a.kind AS created_by_kind, o.slug AS organization_slug, o.name AS organization_name,
            p.slug AS project_slug, p.name AS project_name, sc.slug AS scope_slug,
            sc.name AS scope_name, d.title AS document_title, d.mode AS document_mode, s.heading AS current_heading,
            s.body AS current_body, s.version AS current_version, s.mode AS section_mode,
            rv.name AS reviewed_by_name, COALESCE(rs.document_id, CASE WHEN x.kind = 'new_document' THEN x.document_id END) AS result_document_id,
            CASE WHEN x.scope_spec IS NULL THEN NULL
                 ELSE ARRAY(SELECT r.remote_key FROM repositories r
                             WHERE r.id::text IN (SELECT jsonb_array_elements_text(x.scope_spec->'repository_ids'))
                             ORDER BY r.remote_key) END AS scope_repositories,
            rsc.slug AS result_scope_slug, td.title AS target_document_title,
            CASE WHEN td.id IS NULL THEN NULL
                 ELSE COALESCE((SELECT y.name FROM scopes y WHERE y.id = td.scope_id),
                               (SELECT y.name FROM projects y WHERE y.id = td.project_id),
                               (SELECT y.name FROM organizations y WHERE y.id = td.organization_id)) END AS target_location,
            (SELECT count(*)::int FROM review_threads t WHERE t.proposal_id = x.id AND t.resolved_at IS NULL) AS open_threads,
            (SELECT count(*)::int FROM review_comments rc JOIN review_threads t ON t.id = rc.thread_id WHERE t.proposal_id = x.id) AS comment_count,
            CASE WHEN x.status NOT IN ('pending', 'changes_requested') THEN NULL
                 WHEN x.status = 'changes_requested' THEN 'author'
                 WHEN ${AUTHOR_OWES_REPLY} THEN 'author'
                 ELSE 'review' END AS awaiting
       FROM proposals x
       LEFT JOIN actors a ON a.id = x.created_by
       LEFT JOIN actors rv ON rv.id = x.reviewed_by
       LEFT JOIN organizations o ON o.id = x.organization_id
       LEFT JOIN projects p ON p.id = x.project_id
       LEFT JOIN scopes sc ON sc.id = x.scope_id
       LEFT JOIN documents d ON d.id = x.document_id
       LEFT JOIN sections s ON s.id = x.section_id
       LEFT JOIN sections rs ON rs.id = x.result_section_id
       LEFT JOIN scopes rsc ON rsc.id = x.result_scope_id
       LEFT JOIN documents td ON td.id = x.target_document_id
      WHERE ($1::proposal_status IS NULL OR x.status = $1)
        AND (x.organization_id IS NULL OR x.organization_id = ANY($2::uuid[]))
        AND ($3::uuid IS NULL OR x.organization_id = $3)
        AND (NOT $4 OR x.organization_id IS NULL)
        AND ($5::uuid IS NULL OR x.project_id = $5)
        AND ($7::uuid IS NULL OR x.id = $7)
        AND (NOT $8 OR x.status IN ('pending', 'changes_requested'))
        AND ($9::uuid IS NULL OR x.created_by = $9)
      ORDER BY x.updated_at DESC
      LIMIT $6`,
    [
      opts.status && opts.status !== 'open' ? opts.status : null,
      a.readableOrgIds(),
      orgFilter,
      opts.level === 'group',
      opts.projectId ?? null,
      Math.min(opts.limit ?? 300, 1000),
      opts.id ?? null,
      opts.status === 'open',
      opts.createdBy ?? null,
    ],
  );
  return rows.map((r) => ({ ...r, can_review: canReview(a, r) }));
}

export async function getProposalDetail(
  db: Queryable,
  a: Access,
  id: string,
): Promise<ProposalListItem> {
  const p = (await listProposals(db, a, { id: await resolveProposalRef(db, a, id) })).at(0);
  if (!p) throw notFound('Proposal');
  return p;
}

/** How many proposals per status the actor can see, for the tab counts. */
export async function proposalCounts(
  db: Queryable,
  a: Access,
  level?: string,
): Promise<ProposalCounts> {
  const orgFilter = level && level !== 'group' ? level : null;
  if (orgFilter) a.requireRead(orgFilter);
  const { rows } = await db.query<{ status: ProposalStatus; n: number }>(
    `SELECT status, count(*)::int AS n FROM proposals x
      WHERE (x.organization_id IS NULL OR x.organization_id = ANY($1::uuid[]))
        AND ($2::uuid IS NULL OR x.organization_id = $2)
        AND (NOT $3 OR x.organization_id IS NULL)
      GROUP BY status`,
    [a.readableOrgIds(), orgFilter, level === 'group'],
  );
  const out: ProposalCounts = { pending: 0, changes_requested: 0, approved: 0, rejected: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/**
 * Editors of a proposal's level review it. Group editors may also review any
 * organization's learnings, but only to promote them to the group.
 */
export function canReview(a: Access, p: Pick<Proposal, 'kind' | 'organization_id'>): boolean {
  return a.canEdit(p.organization_id) || (p.kind === 'learning' && a.canEdit(null));
}

/** Pending proposals this actor could review. */
export async function countReviewable(db: Queryable, a: Access): Promise<number> {
  const editable = a.orgs.filter((o) => a.canEdit(o.id)).map((o) => o.id);
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM proposals
      WHERE status = 'pending'
        AND ((organization_id IS NULL AND $1) OR organization_id = ANY($2::uuid[]) OR (kind = 'learning' AND $1))
        AND (organization_id IS NULL OR organization_id = ANY($3::uuid[]))`,
    [a.canEdit(null), editable, a.readableOrgIds()],
  );
  return rows[0].n;
}

// ───────────────────────── mode-aware edits (humans and agents) ─────────────────────────

/** proposal on an applied result: the change was proposed and approved automatically. */
export type EditResult =
  | { status: 'applied'; section: Section; proposal?: Proposal } |
  { status: 'proposed'; proposal: Proposal };

/**
 * The single entry point for changing a section's content.
 *  - Editors of the section's level: applied directly, whatever the mode (they can also change
 *    the mode).
 *  - Agents (own organization or group-wide content): "open" → applied; "propose" → proposal;
 *    "locked" → refused. An admin can make an agent propose in open sections too, or have its
 *    proposals approved automatically (see permissions.ts).
 */
export async function editSection(
  db: Db,
  a: Access,
  ref: string,
  change: SectionChange & { expected_version?: number; note?: string; rationale?: string },
): Promise<EditResult> {
  return tx(db, async (c) => {
    const section = await getSection(c, a, ref, { forUpdate: true });
    const orgId = section.organization_id;
    a.requireContribute(orgId);
    checkVersion(section, change.expected_version);
    if (a.canEdit(orgId)) {
      return {
        status: 'applied',
        section: await applySectionChange(c, section, change, a.actor.id, change.note ?? ''),
      };
    }
    if (change.mode !== undefined && change.mode !== section.mode) {
      throw forbidden('Agents cannot change edit modes; ask a person to do it in the web UI');
    }
    if (section.mode === 'locked') {
      throw new AppError(
        'locked',
        `Section "${section.heading}" is locked. Agents can read it but not change or propose changes to it.`,
      );
    }
    const rules = await agentRules(c, a);
    if (section.mode === 'open' && rules.review !== 'always_propose') {
      const updated = await applySectionChange(
        c,
        section,
        { heading: change.heading, body: change.body },
        a.actor.id,
        change.note ?? '',
      );
      return { status: 'applied', section: updated };
    }
    const doc = await getDocument(c, a, section.document_id);
    const proposal = await insertProposal(c, a, {
      kind: 'edit_section',
      organization_id: doc.organization_id,
      project_id: doc.project_id,
      scope_id: doc.scope_id,
      document_id: doc.id,
      section_id: section.id,
      base_version: section.version,
      heading: change.heading?.trim() || section.heading,
      body: change.body ?? section.body,
      rationale: change.rationale ?? change.note ?? '',
    });
    return proposed(c, a, rules, proposal);
  });
}

/** Same policy as editSection, applied to the document's mode. */
export async function addSection(
  db: Db,
  a: Access,
  documentId: string,
  input: SectionInput & { note?: string; rationale?: string },
): Promise<EditResult> {
  return tx(db, async (c) => {
    const doc = await getDocument(c, a, await resolveDocumentRef(c, documentId));
    a.requireContribute(doc.organization_id);
    if (a.canEdit(doc.organization_id)) {
      return {
        status: 'applied',
        section: await insertSection(c, doc.id, input, a.actor.id, input.note ?? 'Created'),
      };
    }
    if (doc.mode === 'locked') {
      throw new AppError(
        'locked',
        `Document "${doc.title}" is locked; agents cannot add sections to it.`,
      );
    }
    const rules = await agentRules(c, a);
    if (doc.mode === 'open' && rules.review !== 'always_propose') {
      const section = await insertSection(
        c,
        doc.id,
        { ...input, mode: 'open' },
        a.actor.id,
        input.note ?? 'Added by agent',
      );
      return { status: 'applied', section };
    }
    const proposal = await insertProposal(c, a, {
      kind: 'new_section',
      organization_id: doc.organization_id,
      project_id: doc.project_id,
      scope_id: doc.scope_id,
      document_id: doc.id,
      heading: input.heading,
      body: input.body ?? '',
      rationale: input.rationale ?? input.note ?? '',
    });
    return proposed(c, a, rules, proposal);
  });
}

// ───────────────────────────── archiving and moving ─────────────────────────────

export interface SectionMoveInput {
  /** Why: shown to the reviewer. */
  rationale?: string;
  context?: Record<string, unknown>;
}

/** Refuse a second open archive or move proposal for the same section. */
async function assertNoOpenChange(c: Queryable, section: Section): Promise<void> {
  const { rows } = await c.query<{ id: string; kind: string }>(
    `SELECT id, kind FROM proposals
      WHERE section_id = $1 AND kind IN ('archive_section', 'move_section')
        AND status IN ('pending', 'changes_requested') LIMIT 1`,
    [section.id],
  );
  if (rows[0])
    throw new AppError(
      'conflict',
      `"${section.heading}" already has an open proposal to ${rows[0].kind === 'archive_section' ? 'archive' : 'move'} it (proposal ${rows[0].id.slice(0, 8)}). Wait for a person to review it.`,
    );
}

/**
 * Archive a section: it stays in its document, with its history, but agents no longer get it.
 * Same policy as editSection: editors archive right away; agents archive "open" sections, propose
 * for "propose" ones and can't touch "locked" ones.
 */
export async function archiveSection(
  db: Db,
  a: Access,
  ref: string,
  input: SectionMoveInput = {},
): Promise<EditResult> {
  return tx(db, async (c) => {
    const section = await getSection(c, a, ref, { forUpdate: true });
    a.requireContribute(section.organization_id);
    if (a.canEdit(section.organization_id))
      return { status: 'applied', section: await archiveSectionRow(c, section, a.actor.id) };
    if (section.mode === 'locked')
      throw new AppError(
        'locked',
        `Section "${section.heading}" is locked. Agents can read it but not archive it.`,
      );
    await assertNoOpenChange(c, section);
    const rules = await agentRules(c, a);
    if (section.mode === 'open' && rules.review !== 'always_propose')
      return { status: 'applied', section: await archiveSectionRow(c, section, a.actor.id) };
    const doc = await getDocument(c, a, section.document_id);
    const proposal = await insertProposal(c, a, {
      kind: 'archive_section',
      organization_id: doc.organization_id,
      project_id: doc.project_id,
      scope_id: doc.scope_id,
      document_id: doc.id,
      section_id: section.id,
      base_version: section.version,
      heading: section.heading,
      body: section.body,
      rationale: input.rationale ?? '',
      context: input.context ?? {},
    });
    return proposed(c, a, rules, proposal);
  });
}

/**
 * Move a section to another document of the same organization, keeping its id and history.
 * Editors move right away. Agents move directly only when both the section and the target
 * document are "open"; otherwise they propose. Locked sections and documents are refused.
 */
export async function moveSection(
  db: Db,
  a: Access,
  ref: string,
  targetRef: string,
  input: SectionMoveInput & { position?: number | null } = {},
): Promise<EditResult> {
  return tx(db, async (c) => {
    const section = await getSection(c, a, ref, { forUpdate: true });
    a.requireContribute(section.organization_id);
    const target = await getDocument(c, a, await resolveDocumentRef(c, targetRef));
    if (target.organization_id !== section.organization_id)
      throw badRequest(
        'Sections move only within one organization. Pick a document of the same organization, or propose a new section there instead.',
      );
    if (target.id === section.document_id)
      throw badRequest('The section is already in that document.');
    const position = input.position ?? null;
    if (a.canEdit(section.organization_id))
      return { status: 'applied', section: await moveSectionRow(c, section, target, position) };
    if (section.mode === 'locked')
      throw new AppError(
        'locked',
        `Section "${section.heading}" is locked. Agents can read it but not move it.`,
      );
    if (target.mode === 'locked')
      throw new AppError(
        'locked',
        `Document "${target.title}" is locked; agents cannot move sections into it.`,
      );
    await assertNoOpenChange(c, section);
    const rules = await agentRules(c, a);
    if (section.mode === 'open' && target.mode === 'open' && rules.review !== 'always_propose')
      return { status: 'applied', section: await moveSectionRow(c, section, target, position) };
    const doc = await getDocument(c, a, section.document_id);
    const proposal = await insertProposal(c, a, {
      kind: 'move_section',
      organization_id: doc.organization_id,
      project_id: doc.project_id,
      scope_id: doc.scope_id,
      document_id: doc.id,
      section_id: section.id,
      base_version: section.version,
      heading: section.heading,
      body: section.body,
      rationale: input.rationale ?? '',
      context: input.context ?? {},
      target_document_id: target.id,
      target_position: position,
    });
    return proposed(c, a, rules, proposal);
  });
}

/** A section proposal that was just made: approve it now if the agent may skip review. */
async function proposed(
  c: Db,
  a: Access,
  rules: AgentRules,
  proposal: Proposal,
): Promise<EditResult> {
  if (!autoApproves(a, rules, proposal.organization_id)) return { status: 'proposed', proposal };
  const r = await applyApproval(c, a, proposal, {}, rules);
  if (!r.section) throw new AppError('conflict', 'Approving the proposal made no section');
  return { status: 'applied', section: r.section, proposal: r.proposal };
}

// ───────────────────────────── learnings ─────────────────────────────

export interface LearningInput extends Partial<Level> {
  heading: string;
  body: string;
  rationale?: string;
  context?: Record<string, unknown>;
}

/**
 * Always a proposal, even from editors: learnings are reviewed before they become rules. Unless an
 * admin lets the agent approve automatically: then it comes back approved.
 */
export async function proposeLearning(db: Db, a: Access, input: LearningInput): Promise<Proposal> {
  if (!input.heading.trim())
    throw badRequest('heading (a one-line summary of the learning) is required');
  if (!input.body.trim()) throw badRequest('body is required');
  return tx(db, async (c) => {
    const level = await resolveLevel(c, input);
    a.requireContribute(level.organization_id);
    const proposal = await insertProposal(c, a, {
      kind: 'learning',
      ...level,
      heading: input.heading.trim(),
      body: input.body.trim(),
      rationale: input.rationale ?? '',
      context: input.context ?? {},
    });
    const rules = await agentRules(c, a);
    if (!autoApproves(a, rules, proposal.organization_id)) return proposal;
    return (await applyApproval(c, a, proposal, {}, rules)).proposal;
  });
}

// ───────────────────────────── scopes ─────────────────────────────

export interface ScopeProposalInput extends ScopeInput {
  /** Why this part of the code needs its own rules. */
  rationale?: string;
  context?: Record<string, unknown>;
}

/** proposal on an applied result: the scope was proposed and approved automatically. */
export type ScopeResult =
  | { status: 'applied'; scope: Scope; proposal?: Proposal } |
  { status: 'proposed'; proposal: Proposal };

/**
 * A new scope of a project, or of an organization when no project is given. Editors create it
 * right away; agents propose it, and it's created when a person approves the proposal.
 */
export async function proposeScope(
  db: Db,
  a: Access,
  level: { organization_id?: string | null; project_id?: string | null },
  input: ScopeProposalInput,
): Promise<ScopeResult> {
  if (!input.name.trim()) throw badRequest('name is required');
  const lv = await resolveLevel(db, level);
  if (a.canEdit(lv.organization_id)) {
    return { status: 'applied', scope: await createScope(db, a, lv, input) };
  }
  a.requireContribute(lv.organization_id);
  const slug = input.slug?.trim() || slugify(input.name);
  const taken = await db.query(
    `SELECT 1 FROM scopes WHERE organization_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2
        AND slug = $3`,
    [lv.organization_id, lv.project_id, slug],
  );
  if (taken.rowCount) {
    throw new AppError('conflict', `There already is a scope "${slug}" here; call list_scopes`);
  }
  const repositoryIds = [...new Set(input.repository_ids ?? [])];
  if (repositoryIds.length) {
    if (!lv.project_id) throw badRequest('Only project scopes can be bound to repositories');
    const { rowCount } = await db.query(
      'SELECT 1 FROM repositories WHERE id = ANY($1::uuid[]) AND project_id = $2',
      [repositoryIds, lv.project_id],
    );
    if (rowCount !== repositoryIds.length)
      throw badRequest("repository_ids must be repositories of the scope's project");
  }
  const spec: ScopeSpec = {
    slug,
    path_globs: cleanGlobs(input.path_globs),
    stacks: normalizeTags(input.stacks ?? []),
    repository_ids: repositoryIds,
  };
  return tx(db, async (c) => {
    const proposal = await insertProposal(c, a, {
      kind: 'new_scope',
      organization_id: lv.organization_id,
      project_id: lv.project_id,
      heading: input.name.trim(),
      // Reviewed together: the description, then a "## Heading" line per first guideline.
      body: renderScopeBody(input.description ?? '', input.guidelines ?? []),
      rationale: input.rationale ?? '',
      context: input.context ?? {},
      scope_spec: spec,
    });
    const rules = await agentRules(c, a);
    if (!autoApproves(a, rules, proposal.organization_id)) return { status: 'proposed', proposal };
    const r = await applyApproval(c, a, proposal, {}, rules);
    if (!r.scope) throw new AppError('conflict', 'Approving the proposal made no scope');
    return { status: 'applied', scope: r.scope, proposal: r.proposal };
  });
}

// ───────────────────────────── documents ─────────────────────────────

export interface DocumentProposalInput {
  title: string;
  kind: string;
  slug?: string;
  /** Its first sections. More can be added with add_section once it exists. */
  sections?: SectionDraft[];
  /** Why the level needs this document. */
  rationale?: string;
  context?: Record<string, unknown>;
}

/** proposal on an applied result: the document was proposed and approved automatically. */
export type DocumentResult =
  | { status: 'applied'; document: Document; sections: Section[]; proposal?: Proposal } |
  { status: 'proposed'; proposal: Proposal };

/** A new_scope proposal's description and first guidelines, or a 400 that says how to fix it. */
export function scopeText(body: string): { description: string; guidelines: SectionDraft[] } {
  const r = parseScopeBody(body);
  if ('error' in r) throw badRequest(r.error);
  return r;
}

/** The sections of a new_document proposal's text, or a 400 that says how to fix it. */
export function documentSections(body: string): SectionDraft[] {
  const r = parseDocumentBody(body);
  if ('error' in r) throw badRequest(r.error);
  return r.sections;
}

/**
 * A new document at a level, with its first sections. Editors create it right away; agents
 * propose it, and it's created when a person approves the proposal. The sections are reviewed
 * as one text, a "## Heading" line per section.
 */
export async function proposeDocument(
  db: Db,
  a: Access,
  level: Partial<Level>,
  input: DocumentProposalInput,
): Promise<DocumentResult> {
  const title = input.title.trim();
  if (!title) throw badRequest('title is required');
  if (!(PROPOSABLE_DOC_KINDS as string[]).includes(input.kind))
    throw badRequest(
      input.kind === 'learnings'
        ? 'Learnings documents are made when a learning is approved; call propose_learning instead.'
        : `kind must be one of ${PROPOSABLE_DOC_KINDS.join(', ')}`,
    );
  const sections = (input.sections ?? []).map((s) => ({
    heading: s.heading.trim(),
    body: s.body.trim(),
  }));
  if (sections.some((s) => !s.heading)) throw badRequest('Every section needs a heading');
  const body = renderDocumentBody(sections);
  // The text must read back as the same sections, e.g. no "## " line inside a body.
  if (documentSections(body).length !== sections.length)
    throw badRequest('A section body has a "## " line. Use "###" for headings inside a section.');
  const spec: DocumentSpec = {
    kind: input.kind as DocumentSpec['kind'],
    slug: input.slug?.trim() || slugify(title),
  };
  return tx(db, async (c) => {
    const lv = await resolveLevel(c, level);
    a.requireContribute(lv.organization_id);
    const taken = (await documentsAt(c, lv)).find((d) => d.slug === spec.slug);
    if (taken)
      throw new AppError(
        'conflict',
        `There already is a document "${taken.title}" (${spec.slug}) here${taken.disabled_at ? ', disabled for agents' : ''}. Add sections to it with add_section(document_id="${taken.id.slice(0, 8)}") instead.`,
      );
    const { rows: pending } = await c.query<{ id: string }>(
      `SELECT id FROM proposals
        WHERE kind = 'new_document' AND status IN ('pending', 'changes_requested')
          AND organization_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2
          AND scope_id IS NOT DISTINCT FROM $3 AND document_spec->>'slug' = $4`,
      [lv.organization_id, lv.project_id, lv.scope_id, spec.slug],
    );
    if (pending[0])
      throw new AppError(
        'conflict',
        `A document "${spec.slug}" is already proposed here (proposal ${pending[0].id.slice(0, 8)}). Change it with revise_proposal instead.`,
      );
    if (a.canEdit(lv.organization_id)) {
      const document = await createProposedDocument(c, lv, title, spec, sections, 'propose', {
        actorId: a.actor.id,
        note: 'Created',
      });
      return { status: 'applied', ...document };
    }
    const proposal = await insertProposal(c, a, {
      kind: 'new_document',
      ...lv,
      heading: title,
      body,
      rationale: input.rationale ?? '',
      context: input.context ?? {},
      document_spec: spec,
    });
    const rules = await agentRules(c, a);
    if (!autoApproves(a, rules, proposal.organization_id)) return { status: 'proposed', proposal };
    const r = await applyApproval(c, a, proposal, {}, rules);
    if (!r.document) throw new AppError('conflict', 'Approving the proposal made no document');
    return { status: 'applied', document: r.document, sections: r.sections, proposal: r.proposal };
  });
}

/** Insert a document and its sections, in order. No permission check. */
async function createProposedDocument(
  c: Queryable,
  level: Level,
  title: string,
  spec: DocumentSpec,
  sections: SectionDraft[],
  mode: EditMode,
  by: { actorId: string; note: string },
): Promise<{ document: Document; sections: Section[] }> {
  const position = (await documentsAt(c, level)).filter((d) => d.kind !== 'learnings').length;
  const document = await insertDocument(c, level, {
    kind: spec.kind,
    title,
    slug: spec.slug,
    mode,
    position,
  });
  const made: Section[] = [];
  for (const [i, s] of sections.entries())
    made.push(
      await insertSection(
        c,
        document.id,
        { heading: s.heading, body: s.body, mode, position: i },
        by.actorId,
        by.note,
      ),
    );
  return { document, sections: made };
}

// ───────────────────────────── review ─────────────────────────────

export interface ApproveInput {
  heading?: string;
  body?: string;
  note?: string;
  /**
   * Learnings only: where to file it. All null = group-wide (promote to the group).
   * Defaults to the proposal's suggestion.
   */
  target?: Partial<Level>;
  /** Edit mode for the resulting section (new sections and learnings). */
  mode?: EditMode;
}

export async function approveProposal(
  db: Db,
  a: Access,
  id: string,
  input: ApproveInput = {},
): Promise<Approval> {
  return tx(db, async (c) => {
    const { rows } = await c.query<{ status: ProposalStatus }>(
      'SELECT status FROM proposals WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!rows[0]) throw notFound('Proposal');
    const p = await getProposal(c, a, id);
    if (!canReview(a, p)) a.requireEdit(p.organization_id);
    if (!isOpen(rows[0].status))
      throw new AppError('conflict', `Proposal is already ${rows[0].status}`);
    return applyApproval(c, a, p, input);
  });
}

/** What approving made: a section, a scope, or a document with its sections. */
export interface Approval {
  proposal: Proposal;
  section: Section | null;
  scope: Scope | null;
  document: Document | null;
  sections: Section[];
}

/**
 * Turn a proposal into the section, scope or document it proposes. Callers check who may approve;
 * `auto` means nobody reviewed it: an admin lets the agent who made it skip review.
 */
async function applyApproval(
  c: Db,
  a: Access,
  p: Proposal,
  input: ApproveInput,
  auto?: AgentRules,
): Promise<Approval> {
  const id = p.id;
  // Archiving and moving don't change the text: the proposal holds a copy for review only.
  const keepsText = p.kind === 'archive_section' || p.kind === 'move_section';
  const heading = keepsText ? p.heading : input.heading?.trim() || p.heading;
  const body = keepsText ? p.body : (input.body ?? p.body);
  let revision = p.revision;
  if (heading !== p.heading || body !== p.body) {
    // Edits made while approving become a revision too, so the history shows what was changed.
    revision = await insertRevision(c, a, p, heading, body, 'Edited while approving');
  }
  const note = auto
    ? `Approved automatically: ${auto.set_by_name ?? 'an admin'} lets ${a.actor.name} skip review`
    : input.note || `Approved proposal from ${p.created_by_name ?? 'unknown'}`;
  let section: Section | null = null;
  let scope: Scope | null = null;
  let document: Document | null = null;
  let sections: Section[] = [];
  let level: Level = {
    organization_id: p.organization_id,
    project_id: p.project_id,
    scope_id: p.scope_id,
  };

  if (p.kind === 'edit_section') {
    if (!p.section_id)
      throw new AppError('conflict', 'The section this proposal edits no longer exists');
    const current = await loadSection(c, p.section_id, { forUpdate: true });
    section = await applySectionChange(
      c,
      current,
      { heading, body, mode: assertMode(input.mode) },
      a.actor.id,
      note,
    );
  } else if (p.kind === 'new_section') {
    if (!p.document_id)
      throw new AppError('conflict', 'The document for this proposal no longer exists');
    section = await insertSection(
      c,
      p.document_id,
      { heading, body, mode: assertMode(input.mode) },
      a.actor.id,
      note,
    );
  } else if (p.kind === 'new_scope') {
    const spec = p.scope_spec;
    // Repositories removed since the proposal was made are left out.
    const repositoryIds = spec?.repository_ids.length
      ? (
          await c.query<{ id: string }>(
            'SELECT id FROM repositories WHERE id = ANY($1::uuid[]) AND project_id = $2',
            [spec.repository_ids, p.project_id],
          )
        ).rows.map((r) => r.id)
      : undefined;
    const scopeLevel = { organization_id: p.organization_id, project_id: p.project_id };
    const { description, guidelines } = scopeText(body);
    const scopeInput = {
      name: heading,
      description,
      guidelines,
      slug: spec?.slug,
      path_globs: spec?.path_globs,
      stacks: spec?.stacks,
      repository_ids: repositoryIds,
    };
    // The guidelines are the proposer's words, approved with the scope.
    const author = { actorId: p.created_by, note: note || 'Approved with the scope' };
    scope = auto
      ? await insertScope(c, { ...scopeLevel, scope_id: null }, scopeInput, author)
      : await createScope(c, a, scopeLevel, scopeInput, author);
  } else if (p.kind === 'archive_section' || p.kind === 'move_section') {
    if (!p.section_id)
      throw new AppError('conflict', 'The section this proposal is about no longer exists');
    const current = await loadSection(c, p.section_id, { forUpdate: true });
    if (p.kind === 'archive_section') {
      section = await archiveSectionRow(c, current, a.actor.id);
    } else {
      if (!p.target_document_id)
        throw new AppError('conflict', 'The document this section should move to no longer exists');
      const [from, to] = [
        await loadDocument(c, current.document_id),
        await loadDocument(c, p.target_document_id),
      ];
      if (from.organization_id !== to.organization_id)
        throw new AppError('conflict', 'Sections move only within one organization');
      section = await moveSectionRow(c, current, to, p.target_position);
    }
  } else if (p.kind === 'new_document') {
    const spec = p.document_spec;
    if (!spec) throw new AppError('conflict', 'This proposal has no document kind or slug');
    const drafts = documentSections(body);
    const taken = (await documentsAt(c, level)).find((d) => d.slug === spec.slug);
    if (taken)
      throw new AppError(
        'conflict',
        `There already is a document "${taken.title}" (${spec.slug}) here. Reject this proposal, or add its sections to that document.`,
      );
    ({ document, sections } = await createProposedDocument(
      c,
      level,
      heading,
      spec,
      drafts,
      assertMode(input.mode) ?? 'propose',
      { actorId: a.actor.id, note },
    ));
  } else {
    if (input.target) level = await resolveLevel(c, input.target);
    // Filing somewhere else (e.g. promoting to the group) needs edit rights there too.
    if (!auto && !a.canEdit(level.organization_id)) {
      throw forbidden(
        level.organization_id === p.organization_id || level.organization_id
          ? `Only editors of ${a.levelName(level.organization_id)} can file it there`
          : `Only workspace editors can promote a learning to ${a.group.name}`,
      );
    }
    const doc = await ensureLearningsDocument(c, level);
    section = await insertSection(
      c,
      doc.id,
      { heading, body, mode: assertMode(input.mode) ?? 'propose' },
      a.actor.id,
      note,
    );
  }

  await c.query(
    `UPDATE proposals SET status = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = $3,
              result_section_id = $4, heading = $5, body = $6, organization_id = $7, project_id = $8, scope_id = $9,
              document_id = COALESCE(document_id, $10), result_scope_id = $11, auto_approved = $12
        WHERE id = $1`,
    [
      id,
      a.actor.id,
      auto ? note : (input.note ?? ''),
      section?.id ?? null,
      heading,
      body,
      level.organization_id,
      level.project_id,
      level.scope_id,
      section?.document_id ?? document?.id ?? null,
      scope?.id ?? null,
      !!auto,
    ],
  );
  await c.query('UPDATE proposals SET updated_at = now() WHERE id = $1', [id]);
  await addEvent(c, a, id, 'approved', revision, auto ? note : (input.note ?? ''));
  return { proposal: await loadProposal(c, id), section, scope, document, sections };
}

export async function rejectProposal(db: Db, a: Access, id: string, note = ''): Promise<Proposal> {
  return tx(db, async (c) => {
    const p = await getProposal(c, a, id);
    if (!canReview(a, p)) a.requireEdit(p.organization_id);
    const r = await c.query(
      `UPDATE proposals SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3, updated_at = now()
        WHERE id = $1 AND status IN ('pending', 'changes_requested')`,
      [id, a.actor.id, note],
    );
    if (!r.rowCount) throw new AppError('conflict', `Proposal is already ${p.status}`);
    await addEvent(c, a, id, 'rejected', p.revision, note);
    return loadProposal(c, id);
  });
}

/** Add a revision row and bump the proposal's text. Returns the new revision number. */
export async function insertRevision(
  c: Queryable,
  a: Access,
  p: Pick<Proposal, 'id' | 'revision'>,
  heading: string,
  body: string,
  note: string,
): Promise<number> {
  const revision = p.revision + 1;
  await c.query(
    'INSERT INTO proposal_revisions (proposal_id, revision, heading, body, note, actor_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [p.id, revision, heading, body, note, a.actor.id],
  );
  await c.query(
    'UPDATE proposals SET heading = $2, body = $3, revision = $4, updated_at = now() WHERE id = $1',
    [p.id, heading, body, revision],
  );
  return revision;
}

/** The author (or an editor) can withdraw an open proposal. */
export async function withdrawProposal(db: Db, a: Access, id: string): Promise<void> {
  const p = await getProposal(db, a, id);
  if (!isOpen(p.status)) throw new AppError('conflict', `Proposal is already ${p.status}`);
  if (p.created_by !== a.actor.id) a.requireEdit(p.organization_id);
  await db.query('DELETE FROM proposals WHERE id = $1', [id]);
}
