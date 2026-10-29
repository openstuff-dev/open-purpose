/**
 * Pull-request style review of proposals: comments on lines of the proposed
 * text, suggestions that can be applied with one click, "request changes",
 * replies and new revisions from the author (a person or an agent).
 */
import type { Access } from '../auth.js';
import type { Db, Queryable } from '../db.js';
import { tx } from '../db.js';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';
import {
  AUTHOR_OWES_REPLY,
  addEvent,
  canReview,
  getProposal,
  insertRevision,
  isOpen,
} from './proposals.js';
import type { Proposal } from './types.js';
import type {
  Review,
  ReviewComment,
  ReviewEvent,
  ReviewRevision,
  ReviewThread,
} from '@openpurpose/contracts';

export type {
  Review,
  ReviewComment,
  ReviewEvent,
  ReviewRevision,
  ReviewThread,
} from '@openpurpose/contracts';

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const linesOf = (text: string) => text.split('\n');

function slice(text: string, start: number, end: number): string {
  return linesOf(text)
    .slice(start - 1, end)
    .join('\n');
}

/** Find where an anchor's lines are now (first exact match), or null. */
export function relocate(
  text: string,
  anchor: string,
  hint: number,
): { start: number; end: number } | null {
  const lines = linesOf(text);
  const want = linesOf(anchor);
  const matches: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((l, k) => lines[i + k] === l)) matches.push(i + 1);
  }
  if (!matches.length) return null;
  const best = matches.reduce((b, m) => (Math.abs(m - hint) < Math.abs(b - hint) ? m : b));
  return { start: best, end: best + want.length - 1 };
}

// ───────────────────────────── permissions ─────────────────────────────

const isAuthor = (a: Access, p: Proposal) => p.created_by === a.actor.id;

function canComment(a: Access, p: Proposal): boolean {
  return isAuthor(a, p) || canReview(a, p) || a.canContribute(p.organization_id);
}

/** The author, or anyone who could approve it, may change the proposed text. */
function canRevise(a: Access, p: Proposal): boolean {
  return isAuthor(a, p) || canReview(a, p);
}

async function openProposal(db: Queryable, a: Access, id: string): Promise<Proposal> {
  const p = await getProposal(db, a, id);
  return p;
}

// ───────────────────────────── reading ─────────────────────────────

export async function getReview(db: Queryable, a: Access, proposalId: string): Promise<Review> {
  const p = await openProposal(db, a, proposalId);
  const revisions = (
    await db.query<ReviewRevision>(
      `SELECT r.revision, r.heading, r.body, r.note, ac.name AS actor_name, ac.kind AS actor_kind, r.created_at
       FROM proposal_revisions r LEFT JOIN actors ac ON ac.id = r.actor_id
      WHERE r.proposal_id = $1 ORDER BY r.revision`,
      [p.id],
    )
  ).rows;
  const threads = (
    await db.query<Omit<ReviewThread, 'comments' | 'outdated'>>(
      `SELECT t.id, t.proposal_id, t.revision, t.line_start, t.line_end, t.anchor, t.resolved_at,
            rb.name AS resolved_by_name, t.created_by, t.created_at
       FROM review_threads t LEFT JOIN actors rb ON rb.id = t.resolved_by
      WHERE t.proposal_id = $1 ORDER BY t.created_at`,
      [p.id],
    )
  ).rows;
  const comments = (
    await db.query<ReviewComment>(
      `SELECT c.id, c.thread_id, c.actor_id, ac.name AS actor_name, ac.kind AS actor_kind, c.body, c.suggestion,
            c.applied_at, ap.name AS applied_by_name, c.created_at
       FROM review_comments c
       JOIN review_threads t ON t.id = c.thread_id
       LEFT JOIN actors ac ON ac.id = c.actor_id
       LEFT JOIN actors ap ON ap.id = c.applied_by
      WHERE t.proposal_id = $1 ORDER BY c.created_at`,
      [p.id],
    )
  ).rows;
  const events = (
    await db.query<ReviewEvent>(
      `SELECT e.id, e.kind, e.revision, e.note, ac.name AS actor_name, ac.kind AS actor_kind, e.created_at
       FROM proposal_events e LEFT JOIN actors ac ON ac.id = e.actor_id
      WHERE e.proposal_id = $1 ORDER BY e.created_at`,
      [p.id],
    )
  ).rows;

  const byThread = new Map<string, ReviewComment[]>();
  for (const c of comments) byThread.set(c.thread_id, [...(byThread.get(c.thread_id) ?? []), c]);

  return {
    proposal_id: p.id,
    revision: p.revision,
    revisions,
    threads: threads.map((t) => {
      // A line thread moves with its lines; if they changed, it is outdated (still visible in the
      // conversation).
      let outdated = false;
      let line_start = t.line_start;
      let line_end = t.line_end;
      if (t.line_start !== null && t.revision !== p.revision) {
        const at = relocate(p.body, t.anchor, t.line_start);
        if (at) {
          line_start = at.start;
          line_end = at.end;
        } else {
          outdated = true;
        }
      }
      return { ...t, line_start, line_end, outdated, comments: byThread.get(t.id) ?? [] };
    }),
    events,
    can_comment: canComment(a, p),
    can_revise: canRevise(a, p) && isOpen(p.status),
    can_review: canReview(a, p) && isOpen(p.status),
  };
}

// ───────────────────────────── writing ─────────────────────────────

export interface CommentInput {
  body: string;
  /** Reply to this thread; omit to start a new one. */
  thread_id?: string;
  /**
   * New thread on lines of the current revision (1-based, inclusive). Omit for a general comment.
   */
  line_start?: number;
  line_end?: number;
  /** Replacement text for those lines. Only on a new line thread, or a reply in one. */
  suggestion?: string;
}

export async function addComment(
  db: Db,
  a: Access,
  proposalId: string,
  input: CommentInput,
): Promise<ReviewThread> {
  if (!input.body.trim() && input.suggestion === undefined)
    throw badRequest('Write a comment or a suggestion');
  return tx(db, async (c) => {
    const p = await openProposal(c, a, proposalId);
    if (!canComment(a, p)) throw forbidden('You can read this proposal but not comment on it');
    let threadId = input.thread_id;
    if (threadId) {
      if (!isUuid(threadId)) throw notFound('Thread');
      const { rows } = await c.query<{
        proposal_id: string;
        line_start: number | null;
        resolved_at: string | null;
      }>('SELECT proposal_id, line_start, resolved_at FROM review_threads WHERE id = $1', [
        threadId,
      ]);
      const thread = rows.at(0);
      if (thread?.proposal_id !== p.id) throw notFound('Thread');
      if (input.suggestion !== undefined && thread.line_start === null)
        throw badRequest('Suggestions need lines; start a thread on the lines instead');
      // Replying to a resolved thread reopens it.
      if (thread.resolved_at)
        await c.query(
          'UPDATE review_threads SET resolved_at = NULL, resolved_by = NULL WHERE id = $1',
          [threadId],
        );
    } else {
      let start: number | null = null;
      let end: number | null = null;
      let anchor = '';
      if (input.line_start !== undefined) {
        const total = p.body.split('\n').length;
        start = input.line_start;
        end = input.line_end ?? input.line_start;
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 1 ||
          end < start ||
          end > total
        ) {
          throw badRequest(`Lines must be between 1 and ${total}`);
        }
        anchor = slice(p.body, start, end);
      } else if (input.suggestion !== undefined) {
        throw badRequest('Suggestions need lines (line_start and line_end)');
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO review_threads (proposal_id, revision, line_start, line_end, anchor, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [p.id, p.revision, start, end, anchor, a.actor.id],
      );
      threadId = rows[0].id;
    }
    await c.query(
      'INSERT INTO review_comments (thread_id, actor_id, body, suggestion) VALUES ($1, $2, $3, $4)',
      [threadId, a.actor.id, input.body.trim(), input.suggestion ?? null],
    );
    await c.query('UPDATE proposals SET updated_at = now() WHERE id = $1', [p.id]);
    const review = await getReview(c, a, p.id);
    const thread = review.threads.find((t) => t.id === threadId);
    if (!thread) throw notFound('Thread');
    return thread;
  });
}

export async function setResolved(
  db: Db,
  a: Access,
  threadId: string,
  resolved: boolean,
): Promise<void> {
  if (!isUuid(threadId)) throw notFound('Thread');
  return tx(db, async (c) => {
    const { rows } = await c.query<{ proposal_id: string; created_by: string | null }>(
      'SELECT proposal_id, created_by FROM review_threads WHERE id = $1',
      [threadId],
    );
    if (!rows[0]) throw notFound('Thread');
    const p = await openProposal(c, a, rows[0].proposal_id);
    if (!(rows[0].created_by === a.actor.id || canRevise(a, p))) {
      throw forbidden('Only the thread starter, the author or a reviewer can resolve this');
    }
    await c.query(
      resolved
        ? 'UPDATE review_threads SET resolved_at = now(), resolved_by = $2 WHERE id = $1'
        : 'UPDATE review_threads SET resolved_at = NULL, resolved_by = NULL WHERE id = $1 AND $2::uuid IS NOT NULL',
      [threadId, a.actor.id],
    );
  });
}

export interface ReviseInput {
  body: string;
  heading?: string;
  note?: string;
  /** Threads this revision addresses; they are resolved. */
  resolve?: string[];
}

/**
 * A new revision of the proposed text. When changes were requested, a
 * revision from the author hands it back to the reviewers.
 */
export async function reviseProposal(
  db: Db,
  a: Access,
  proposalId: string,
  input: ReviseInput,
): Promise<Proposal> {
  return tx(db, async (c) => {
    const { rows } = await c.query('SELECT 1 FROM proposals WHERE id = $1 FOR UPDATE', [
      proposalId,
    ]);
    if (!rows[0]) throw notFound('Proposal');
    const p = await openProposal(c, a, proposalId);
    if (!isOpen(p.status)) throw new AppError('conflict', `Proposal is already ${p.status}`);
    if (!canRevise(a, p)) throw forbidden('Only the author or a reviewer can revise this proposal');
    const heading = input.heading?.trim() || p.heading;
    if (heading === p.heading && input.body === p.body) throw badRequest('Nothing changed');
    const revision = await insertRevision(c, a, p, heading, input.body, input.note ?? '');
    if (p.status === 'changes_requested' && isAuthor(a, p)) {
      await c.query('UPDATE proposals SET status = \'pending\' WHERE id = $1', [p.id]);
    }
    await addEvent(c, a, p.id, 'revised', revision, input.note ?? '');
    for (const t of input.resolve ?? []) {
      if (isUuid(t))
        await c.query(
          'UPDATE review_threads SET resolved_at = now(), resolved_by = $3 WHERE id = $1 AND proposal_id = $2',
          [t, p.id, a.actor.id],
        );
    }
    return getProposal(c, a, p.id);
  });
}

/** Replace the thread's lines with the suggestion: a new revision, and the thread is resolved. */
export async function applySuggestion(db: Db, a: Access, commentId: string): Promise<Proposal> {
  if (!isUuid(commentId)) throw notFound('Suggestion');
  return tx(db, async (c) => {
    const { rows } = await c.query<{
      suggestion: string | null;
      applied_at: string | null;
      thread_id: string;
      proposal_id: string;
      line_start: number | null;
      line_end: number | null;
      anchor: string;
      revision: number;
      author: string | null;
    }>(
      `SELECT rc.suggestion, rc.applied_at, rc.thread_id, t.proposal_id, t.line_start, t.line_end, t.anchor, t.revision,
              ac.name AS author
         FROM review_comments rc JOIN review_threads t ON t.id = rc.thread_id LEFT JOIN actors ac ON ac.id = rc.actor_id
        WHERE rc.id = $1`,
      [commentId],
    );
    const s = rows.at(0);
    if (!s) throw notFound('Suggestion');
    if (s.suggestion === null || s.line_start === null || s.line_end === null)
      throw notFound('Suggestion');
    if (s.applied_at) throw new AppError('conflict', 'This suggestion was already applied');
    await c.query('SELECT 1 FROM proposals WHERE id = $1 FOR UPDATE', [s.proposal_id]);
    const p = await openProposal(c, a, s.proposal_id);
    if (!isOpen(p.status)) throw new AppError('conflict', `Proposal is already ${p.status}`);
    if (!canRevise(a, p)) throw forbidden('Only the author or a reviewer can apply suggestions');
    const at =
      s.revision === p.revision
        ? { start: s.line_start, end: s.line_end }
        : relocate(p.body, s.anchor, s.line_start);
    if (!at || slice(p.body, at.start, at.end) !== s.anchor) {
      throw new AppError(
        'conflict',
        'The lines this suggestion replaces have changed since. Apply it by hand.',
      );
    }
    const lines = linesOf(p.body);
    lines.splice(at.start - 1, at.end - at.start + 1, ...linesOf(s.suggestion));
    const revision = await insertRevision(
      c,
      a,
      p,
      p.heading,
      lines.join('\n'),
      `Applied suggestion from ${s.author ?? 'unknown'}`,
    );
    await addEvent(
      c,
      a,
      p.id,
      'revised',
      revision,
      `Applied suggestion from ${s.author ?? 'unknown'}`,
    );
    await c.query('UPDATE review_comments SET applied_at = now(), applied_by = $2 WHERE id = $1', [
      commentId,
      a.actor.id,
    ]);
    await c.query('UPDATE review_threads SET resolved_at = now(), resolved_by = $2 WHERE id = $1', [
      s.thread_id,
      a.actor.id,
    ]);
    return getProposal(c, a, p.id);
  });
}

/** Reviewer verdict short of approving: the author has to act next. */
export async function requestChanges(
  db: Db,
  a: Access,
  proposalId: string,
  note: string,
): Promise<Proposal> {
  return tx(db, async (c) => {
    const p = await openProposal(c, a, proposalId);
    if (!canReview(a, p)) throw forbidden('Only reviewers can request changes');
    if (!isOpen(p.status)) throw new AppError('conflict', `Proposal is already ${p.status}`);
    await c.query(
      'UPDATE proposals SET status = \'changes_requested\', updated_at = now() WHERE id = $1',
      [p.id],
    );
    await addEvent(c, a, p.id, 'changes_requested', p.revision, note.trim());
    return getProposal(c, a, p.id);
  });
}

// ───────────────────────────── for agents ─────────────────────────────

export interface Waiting {
  id: string;
  heading: string;
  status: string;
  open_threads: number;
  where: string;
}

/**
 * The actor's open proposals where it is their move: changes requested, or someone else spoke last
 * in an open thread.
 */
export async function waitingOn(db: Queryable, a: Access): Promise<Waiting[]> {
  const { rows } = await db.query<Waiting>(
    `SELECT x.id, x.heading, x.status,
            (SELECT count(*)::int FROM review_threads t WHERE t.proposal_id = x.id AND t.resolved_at IS NULL) AS open_threads,
            concat_ws(' › ', COALESCE(o.name, $2), p.name, sc.name) AS where
       FROM proposals x
       LEFT JOIN organizations o ON o.id = x.organization_id
       LEFT JOIN projects p ON p.id = x.project_id
       LEFT JOIN scopes sc ON sc.id = x.scope_id
      WHERE x.created_by = $1 AND x.status IN ('pending', 'changes_requested')
        AND (x.status = 'changes_requested' OR ${AUTHOR_OWES_REPLY})
      ORDER BY x.updated_at DESC LIMIT 20`,
    [a.actor.id, a.group.name],
  );
  return rows;
}

/**
 * Plain-text rendering of a review for an agent: numbered lines, threads, suggestions, verdicts.
 */
export function renderReviewForAgent(
  p: Proposal & {
    organization_name?: string | null;
    project_name?: string | null;
    scope_name?: string | null;
  },
  r: Review,
): string {
  const out: string[] = [];
  out.push(
    `# Proposal ${p.id}`,
    '',
    `- Status: **${p.status.replace('_', ' ')}** (revision ${p.revision})`,
  );
  out.push(`- Kind: ${p.kind.replace('_', ' ')}`);
  const spec = p.scope_spec;
  if (spec) {
    const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'any');
    out.push(
      `- Name: ${p.heading}`,
      `- Slug: ${spec.slug}`,
      `- Paths: ${list(spec.path_globs)}`,
      `- Stacks: ${list(spec.stacks)}`,
    );
  } else {
    out.push(`- Heading: ${p.heading}`);
  }
  const lastVerdict = [...r.events]
    .reverse()
    .find((e) => e.kind === 'changes_requested' || e.kind === 'approved' || e.kind === 'rejected');
  if (lastVerdict)
    out.push(
      `- Last verdict: ${lastVerdict.kind.replace('_', ' ')} by ${lastVerdict.actor_name ?? 'unknown'}${lastVerdict.note ? `: "${lastVerdict.note}"` : ''}`,
    );
  out.push('', '## Current text (line numbers for reference)', '', '```');
  linesOf(p.body).forEach((l, i) => out.push(`${String(i + 1).padStart(3)} | ${l}`));
  out.push('```');
  const open = r.threads.filter((t) => !t.resolved_at);
  const resolved = r.threads.length - open.length;
  out.push(
    '',
    `## Open threads (${open.length})${resolved ? `, ${resolved} resolved not shown` : ''}`,
  );
  if (!open.length) out.push('', '_None._');
  for (const t of open) {
    const where =
      t.line_start === null
        ? 'General comment'
        : t.outdated
          ? `Outdated: lines that read:\n> ${t.anchor.split('\n').join('\n> ')}`
          : `Lines ${t.line_start}–${t.line_end}`;
    out.push('', `### Thread ${t.id}`, where);
    for (const c of t.comments) {
      out.push(
        '',
        `**${c.actor_name ?? 'unknown'}**${c.actor_kind === 'agent' ? ' (agent)' : ''}: ${c.body || '_(suggestion only)_'}`,
      );
      if (c.suggestion !== null) {
        out.push(
          `Suggested replacement for lines ${t.line_start}–${t.line_end}${c.applied_at ? ' (applied)' : ` (apply with apply_suggestion comment_id=${c.id})`}:`,
          '```',
          c.suggestion,
          '```',
        );
      }
    }
  }
  out.push(
    '',
    '---',
    'Reply with reply_to_review (thread_id to answer a thread), change the text with revise_proposal (pass resolve=[thread ids] it addresses), or apply_suggestion.',
  );
  return out.join('\n');
}
