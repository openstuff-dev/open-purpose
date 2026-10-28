import type { Access } from '../auth.js';
import type { Queryable } from '../db.js';
import { tx } from '../db.js';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';
import { normalizePath } from '../domain/scopes.js';
import type { Finding, FindingCounts, FindingStatus } from '@openpurpose/contracts';

export type { Finding, FindingCounts, FindingStatus } from '@openpurpose/contracts';

export const FINDING_STATUSES: FindingStatus[] = ['new', 'todo', 'ask_later', 'dismissed', 'solved'];

/** Still waiting for someone: what lists show unless asked for more. */
export const OPEN_FINDING_STATUSES: FindingStatus[] = ['new', 'todo', 'ask_later'];

const FINDING_COLS = `f.id, f.organization_id, f.project_id, f.scope_id, f.status, f.file, f.line_start, f.line_end,
  f.title, f.problem, f.proposed_fix, f.commit_sha, f.remote, to_char(f.remind_after, 'YYYY-MM-DD') AS remind_after,
  f.solved_ref, a.name AS created_by_name, a.kind AS created_by_kind, f.created_at, sb.name AS status_by_name,
  f.status_at, f.status_note, f.updated_at, o.slug AS organization_slug, o.name AS organization_name,
  p.slug AS project_slug, p.name AS project_name, sc.name AS scope_name`;

const FINDING_FROM = `findings f
  JOIN organizations o ON o.id = f.organization_id
  JOIN projects p ON p.id = f.project_id
  LEFT JOIN scopes sc ON sc.id = f.scope_id
  LEFT JOIN actors a ON a.id = f.created_by
  LEFT JOIN actors sb ON sb.id = f.status_by`;

type Row = Omit<Finding, 'where' | 'can_triage'> & { organization_name: string };

function present(a: Access, r: Row): Finding {
  const { organization_name, ...rest } = r;
  return {
    ...rest,
    where: [organization_name, r.project_name, r.scope_name].filter(Boolean).join(' › '),
    can_triage: canTriage(a, r),
  };
}

/** People who edit the finding's organization sort it; agents of that organization may only mark it solved. */
export function canTriage(a: Access, f: Pick<Finding, 'organization_id'>): boolean {
  return a.canEdit(f.organization_id) || a.canAgentWrite(f.organization_id);
}

export interface FindingQuery {
  id?: string;
  projectId?: string;
  organizationId?: string;
  /** Default: the open ones (new, to do, ask me later). */
  statuses?: FindingStatus[];
  /** Only findings in this file, or anywhere under this folder. */
  path?: string;
  q?: string;
  limit?: number;
}

export async function listFindings(db: Queryable, a: Access, opts: FindingQuery = {}): Promise<Finding[]> {
  if (opts.id && !/^[0-9a-f-]{36}$/i.test(opts.id)) throw notFound('Finding');
  if (opts.organizationId) a.requireRead(opts.organizationId);
  const path = normalizePath(opts.path);
  const { rows } = await db.query<Row>(
    `SELECT ${FINDING_COLS} FROM ${FINDING_FROM}
      WHERE f.organization_id = ANY($1::uuid[])
        AND ($2::uuid IS NULL OR f.id = $2)
        AND ($3::uuid IS NULL OR f.project_id = $3)
        AND ($4::uuid IS NULL OR f.organization_id = $4)
        AND ($2::uuid IS NOT NULL OR f.status = ANY($5::finding_status[]))
        AND ($6 = '' OR f.file = $6 OR starts_with(f.file, $6 || '/'))
        AND ($7 = '' OR f.search @@ websearch_to_tsquery('simple', $7) OR f.file ILIKE '%' || $7 || '%')
      ORDER BY f.updated_at DESC
      LIMIT $8`,
    [a.readableOrgIds(), opts.id ?? null, opts.projectId ?? null, opts.organizationId ?? null,
      opts.statuses?.length ? opts.statuses : OPEN_FINDING_STATUSES, path, opts.q?.trim() ?? '', Math.min(opts.limit ?? 300, 1000)],
  );
  return rows.map((r) => present(a, r));
}

export async function getFinding(db: Queryable, a: Access, id: string): Promise<Finding> {
  const [f] = await listFindings(db, a, { id });
  if (!f) throw notFound('Finding');
  return f;
}

/**
 * Find one by its id or the first 8 characters of it, as agents see it.
 * Prefixes only match findings the actor can read.
 */
async function findId(db: Queryable, a: Access, ref: string): Promise<string> {
  const r = ref.trim().toLowerCase();
  if (/^[0-9a-f-]{36}$/.test(r)) return r;
  if (!/^[0-9a-f]{8}$/.test(r)) throw notFound('Finding');
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM findings WHERE id::text LIKE $1 || '%' AND organization_id = ANY($2::uuid[]) LIMIT 2`,
    [r, a.readableOrgIds()]);
  if (rows.length !== 1) throw notFound('Finding');
  return rows[0].id;
}

/** One finding by its id or the first 8 characters of it. */
export async function getFindingByRef(db: Queryable, a: Access, ref: string): Promise<Finding> {
  return getFinding(db, a, await findId(db, a, ref));
}

export async function findingCounts(db: Queryable, a: Access, opts: { projectId?: string; organizationId?: string } = {}): Promise<FindingCounts> {
  if (opts.organizationId) a.requireRead(opts.organizationId);
  const { rows } = await db.query<{ status: FindingStatus; n: number }>(
    `SELECT status, count(*)::int AS n FROM findings
      WHERE organization_id = ANY($1::uuid[])
        AND ($2::uuid IS NULL OR project_id = $2)
        AND ($3::uuid IS NULL OR organization_id = $3)
      GROUP BY status`,
    [a.readableOrgIds(), opts.projectId ?? null, opts.organizationId ?? null],
  );
  const out: FindingCounts = { new: 0, todo: 0, ask_later: 0, dismissed: 0, solved: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/** New findings this person could sort, for the count in the menu. */
export async function countToSort(db: Queryable, a: Access): Promise<number> {
  const editable = a.orgs.filter((o) => a.canEdit(o.id)).map((o) => o.id);
  if (!editable.length) return 0;
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM findings WHERE status = 'new' AND organization_id = ANY($1::uuid[])`, [editable]);
  return rows[0].n;
}

// ───────────────────────────── reporting ─────────────────────────────

export interface FindingInput {
  organization_id: string;
  project_id: string;
  scope_id: string | null;
  file: string;
  line_start?: number | null;
  line_end?: number | null;
  title: string;
  problem?: string;
  proposed_fix?: string;
  commit_sha?: string | null;
  remote?: string | null;
  context?: Record<string, unknown>;
}

const words = (t: string) => new Set(t.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length >= 3));

/** How alike two titles are: shared words over all words (0 to 1). */
export function titleSimilarity(x: string, y: string): number {
  const a = words(x);
  const b = words(y);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Open findings in the same project that may be the same problem: same file, or a similar title. */
export async function similarFindings(
  db: Queryable, a: Access, input: Pick<FindingInput, 'project_id' | 'file' | 'title'>,
): Promise<Finding[]> {
  const open = await listFindings(db, a, { projectId: input.project_id, limit: 1000 });
  return open
    .map((f) => ({ f, score: (f.file === input.file ? 0.5 : 0) + titleSimilarity(f.title, input.title) }))
    .filter((x) => x.score >= 0.4)
    .sort((x, y) => y.score - x.score)
    .slice(0, 5)
    .map((x) => x.f);
}

/**
 * File a finding as new. When open findings look like the same problem, nothing is
 * filed unless `evenIfSimilar`: they come back instead, so the agent can check them first.
 */
export async function reportFinding(
  db: Queryable, a: Access, input: FindingInput, opts: { evenIfSimilar?: boolean } = {},
): Promise<{ finding: Finding | null; similar: Finding[] }> {
  const file = normalizePath(input.file);
  if (!file) throw badRequest('file (the repo-relative path of the problem) is required');
  if (!input.title?.trim()) throw badRequest('title (one line a person can scan) is required');
  const lineStart = input.line_start ?? null;
  const lineEnd = input.line_end ?? lineStart;
  if (lineStart !== null && (lineStart < 1 || (lineEnd ?? lineStart) < lineStart)) throw badRequest('lines must be 1 or more, start before end');
  a.requireContribute(input.organization_id);
  const similar = await similarFindings(db, a, { ...input, file });
  if (similar.length && !opts.evenIfSimilar) return { finding: null, similar };
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO findings (organization_id, project_id, scope_id, file, line_start, line_end, title, problem, proposed_fix,
                           commit_sha, remote, context, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [input.organization_id, input.project_id, input.scope_id, file, lineStart, lineEnd, input.title.trim(),
      input.problem?.trim() ?? '', input.proposed_fix?.trim() ?? '', input.commit_sha?.trim() || null, input.remote ?? null,
      JSON.stringify(input.context ?? {}), a.actor.id],
  );
  return { finding: await getFinding(db, a, rows[0].id), similar };
}

// ───────────────────────────── sorting and solving ─────────────────────────────

export interface FindingStatusChange {
  status: FindingStatus;
  note?: string;
  /** solved: the commit or PR that fixed it. */
  solved_ref?: string | null;
  /** ask_later: don't bring it up before this day (YYYY-MM-DD). */
  remind_after?: string | null;
}

/**
 * People with edit rights move a finding to any status, including back from
 * solved or dismissed. Agents only mark one solved, and must say how.
 */
export async function setFindingStatus(db: Queryable, a: Access, ref: string, change: FindingStatusChange): Promise<Finding> {
  if (!FINDING_STATUSES.includes(change.status)) throw badRequest(`status must be one of ${FINDING_STATUSES.join(', ')}`);
  const id = await findId(db, a, ref);
  return tx(db, async (c) => {
    const { rows: [current] } = await c.query<{ organization_id: string; status: FindingStatus }>(
      'SELECT organization_id, status FROM findings WHERE id = $1 FOR UPDATE', [id]);
    if (!current) throw notFound('Finding');
    a.requireRead(current.organization_id, 'this finding');
    if (a.isAgent) {
      if (change.status !== 'solved') throw forbidden('Agents can only mark a finding solved. A person decides what else happens to it.');
      a.requireContribute(current.organization_id);
      if (!change.solved_ref?.trim()) throw badRequest('solved_ref (the commit or PR that fixed it) is required');
    } else {
      a.requireEdit(current.organization_id);
    }
    if (current.status === change.status && change.status === 'solved') throw new AppError('conflict', 'This finding is already solved');
    const remindAfter = change.status === 'ask_later' ? change.remind_after || null : null;
    if (remindAfter && !/^\d{4}-\d{2}-\d{2}$/.test(remindAfter)) throw badRequest('remind_after must be a date, YYYY-MM-DD');
    await c.query(
      `UPDATE findings SET status = $2, status_note = $3, solved_ref = $4, remind_after = $5::date,
              status_by = $6, status_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, change.status, change.note?.trim() ?? '', change.status === 'solved' ? change.solved_ref?.trim() || null : null,
        remindAfter, a.actor.id]);
    return getFinding(c, a, id);
  });
}

// ───────────────────────────── correcting ─────────────────────────────

/** What the reporter may correct. Fields left out keep their value. */
export interface FindingEdit {
  file?: string;
  /** The scope of the new file; required with `file`. */
  scope_id?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  title?: string;
  problem?: string;
  proposed_fix?: string;
  commit_sha?: string | null;
}

/**
 * Whoever reported a finding corrects it while it is still open: a wrong commit,
 * file or line, or a clearer title. Sorting it stays with people (setFindingStatus).
 */
export async function updateFinding(db: Queryable, a: Access, ref: string, edit: FindingEdit): Promise<Finding> {
  const id = await findId(db, a, ref);
  return tx(db, async (c) => {
    const { rows: [current] } = await c.query<{
      organization_id: string; status: FindingStatus; created_by: string | null; file: string; scope_id: string | null;
      line_start: number | null; line_end: number | null; title: string; problem: string; proposed_fix: string; commit_sha: string | null;
    }>(
      `SELECT organization_id, status, created_by, file, scope_id, line_start, line_end, title, problem, proposed_fix, commit_sha
         FROM findings WHERE id = $1 FOR UPDATE`, [id]);
    if (!current) throw notFound('Finding');
    a.requireRead(current.organization_id, 'this finding');
    if (current.created_by !== a.actor.id) throw forbidden('Only whoever reported a finding can correct it.');
    a.requireContribute(current.organization_id);
    if (!OPEN_FINDING_STATUSES.includes(current.status)) {
      throw new AppError('conflict', `This finding is ${current.status === 'ask_later' ? 'waiting' : current.status}; it can't be changed any more.`);
    }

    const file = edit.file === undefined ? current.file : normalizePath(edit.file);
    if (!file) throw badRequest('file (the repo-relative path of the problem) is required');
    const title = edit.title === undefined ? current.title : edit.title.trim();
    if (!title) throw badRequest('title (one line a person can scan) is required');
    // A new start line without an end means one line, as when reporting.
    const lineStart = edit.line_start === undefined ? current.line_start : edit.line_start;
    const lineEnd = edit.line_end !== undefined ? edit.line_end ?? lineStart
      : edit.line_start !== undefined ? lineStart : current.line_end;
    if (lineStart !== null && (lineStart < 1 || (lineEnd ?? lineStart) < lineStart)) throw badRequest('lines must be 1 or more, start before end');

    await c.query(
      `UPDATE findings SET file = $2, scope_id = $3, line_start = $4, line_end = $5, title = $6, problem = $7,
              proposed_fix = $8, commit_sha = $9, updated_at = now()
        WHERE id = $1`,
      [id, file, edit.file === undefined ? current.scope_id : edit.scope_id ?? null, lineStart, lineEnd, title,
        edit.problem === undefined ? current.problem : edit.problem.trim(),
        edit.proposed_fix === undefined ? current.proposed_fix : edit.proposed_fix.trim(),
        edit.commit_sha === undefined ? current.commit_sha : edit.commit_sha?.trim() || null]);
    return getFinding(c, a, id);
  });
}

// ───────────────────────────── in the context ─────────────────────────────

export interface NearbyFindings {
  todo: Finding[];
  ask_later: Finding[];
  /** How many more there are than listed. */
  more: number;
}

const NEARBY_LIMIT = 10;

/** The folder an agent works in: the path itself, or the folder of the file it names. */
export function folderOf(path: string | null | undefined): string {
  const p = normalizePath(path);
  const last = p.split('/').pop() ?? '';
  return last.includes('.') ? p.split('/').slice(0, -1).join('/') : p;
}

/**
 * To do and ask-me-later findings around the code an agent works in: the
 * folder of the file it names (or the folder itself), in the same repository.
 * Ask-me-later findings wait for their remind-after day. New ones stay out:
 * nobody has looked at them yet.
 */
export async function findingsNear(
  db: Queryable, a: Access, projectId: string, path: string | null | undefined, remote: string | null | undefined,
): Promise<NearbyFindings> {
  const folder = folderOf(path);
  const { rows } = await db.query<Row & { total: number }>(
    `SELECT ${FINDING_COLS}, count(*) OVER ()::int AS total FROM ${FINDING_FROM}
      WHERE f.project_id = $1 AND f.organization_id = ANY($2::uuid[])
        AND (f.status = 'todo' OR (f.status = 'ask_later' AND (f.remind_after IS NULL OR f.remind_after <= current_date)))
        AND ($3 = '' OR starts_with(f.file, $3 || '/'))
        AND ($4::text IS NULL OR f.remote IS NULL OR f.remote = $4)
      ORDER BY f.status = 'ask_later' DESC, f.updated_at DESC
      LIMIT $5`,
    [projectId, a.readableOrgIds(), folder, remote ?? null, NEARBY_LIMIT],
  );
  const found = rows.map(({ total: _, ...r }) => present(a, r));
  return {
    todo: found.filter((f) => f.status === 'todo'),
    ask_later: found.filter((f) => f.status === 'ask_later'),
    more: Math.max((rows[0]?.total ?? 0) - rows.length, 0),
  };
}
