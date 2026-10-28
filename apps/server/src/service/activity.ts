import type { Access } from '../auth.js';
import type { Queryable } from '../db.js';
import type {
  ActivityFigure,
  ActivityPeriod,
  DocumentActivity,
  OrgActivity,
  SectionActivity,
  Staleness,
} from '@openpurpose/contracts';

export type {
  ActivityPeriod,
  DocumentActivity,
  OrgActivity,
  SectionActivity,
  Staleness,
} from '@openpurpose/contracts';

/** What one MCP tool call by an agent did, for the activity log. */
export interface Track {
  projectId?: string | null;
  documentId?: string | null;
  sections?: { id: string; document_id: string }[];
}

/** Record one tool call. Callers skip agent mode and people. */
export async function recordRequest(
  db: Queryable,
  a: Access,
  tool: string,
  kind: 'read' | 'write',
  t: Track,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agent_requests (organization_id, actor_id, tool, kind, project_id, document_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [a.orgId, a.actor.id, tool, kind, t.projectId ?? null, t.documentId ?? null],
  );
  const sections = t.sections ?? [];
  if (!sections.length) return;
  await db.query(
    `INSERT INTO section_reads (request_id, section_id, document_id)
     SELECT $1, s, d FROM unnest($2::uuid[], $3::uuid[]) AS x(s, d)
     ON CONFLICT DO NOTHING`,
    [rows[0].id, sections.map((s) => s.id), sections.map((s) => s.document_id)],
  );
}

// ───────────────────────────── staleness ─────────────────────────────

const DAY = 86_400_000;

/**
 * A document is stale when agents haven't requested it for a month (or a week),
 * and it has existed, with tracking on, for at least that long.
 */
export function stalenessOf(
  createdAt: string | Date,
  trackingSince: string | Date | null,
  lastReadAt: string | Date | null,
  now = Date.now(),
): Staleness | null {
  if (!trackingSince) return null;
  const known = now - Math.max(new Date(createdAt).getTime(), new Date(trackingSince).getTime());
  const quiet = lastReadAt ? now - new Date(lastReadAt).getTime() : Infinity;
  if (known >= 30 * DAY && quiet >= 30 * DAY) return 'month';
  if (known >= 7 * DAY && quiet >= 7 * DAY) return 'week';
  return null;
}

async function trackingSince(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ at: string | null }>(
    'SELECT min(created_at) AS at FROM agent_requests',
  );
  return rows[0].at;
}

/** Staleness and last read of documents, by id. No permission check; callers check. */
export async function documentActivity(
  db: Queryable,
  docs: { id: string; created_at: string; disabled_at: string | null }[],
): Promise<Map<string, DocumentActivity>> {
  const out = new Map<string, DocumentActivity>();
  if (!docs.length) return out;
  const since = await trackingSince(db);
  const { rows } = await db.query<{ document_id: string; last_read_at: string }>(
    `SELECT document_id, max(created_at) AS last_read_at FROM section_reads
      WHERE document_id = ANY($1::uuid[]) GROUP BY document_id`,
    [docs.map((d) => d.id)],
  );
  const last = new Map(rows.map((r) => [r.document_id, r.last_read_at]));
  for (const d of docs) {
    const lastRead = last.get(d.id) ?? null;
    out.set(d.id, {
      disabled_at: d.disabled_at,
      last_read_at: lastRead,
      staleness: d.disabled_at ? null : stalenessOf(d.created_at, since, lastRead),
    });
  }
  return out;
}

// ───────────────────────────── sections ─────────────────────────────

/** A section nobody has read. */
export const NO_SECTION_ACTIVITY: SectionActivity = {
  reads: 0,
  last_read_at: null,
  daily: Array<number>(28).fill(0),
  week: 0,
  previous_week: 0,
};

/** A document nobody has read. */
export const noDocumentActivity = (d: { disabled_at: string | null }): DocumentActivity => ({
  disabled_at: d.disabled_at,
  last_read_at: null,
  staleness: null,
});

/** Read counts of sections, by id. No permission check; callers check. */
export async function sectionActivity(
  db: Queryable,
  sectionIds: string[],
): Promise<Map<string, SectionActivity>> {
  const out = new Map<string, SectionActivity>();
  if (!sectionIds.length) return out;
  const { rows } = await db.query<{
    section_id: string;
    reads: number;
    last_read_at: string;
    daily: number[];
    week: number;
    previous_week: number;
  }>(
    `SELECT s.id AS section_id,
            (SELECT count(*)::int FROM section_reads r WHERE r.section_id = s.id) AS reads,
            (SELECT max(created_at) FROM section_reads r WHERE r.section_id = s.id) AS last_read_at,
            ARRAY(SELECT count(r.request_id)::int
                    FROM generate_series(current_date - 27, current_date, interval '1 day') g
                    LEFT JOIN section_reads r ON r.section_id = s.id AND r.created_at >= g AND r.created_at < g + interval '1 day'
                   GROUP BY g ORDER BY g) AS daily,
            (SELECT count(*)::int FROM section_reads r WHERE r.section_id = s.id AND r.created_at >= current_date - 6) AS week,
            (SELECT count(*)::int FROM section_reads r WHERE r.section_id = s.id
                AND r.created_at >= current_date - 13 AND r.created_at < current_date - 6) AS previous_week
       FROM unnest($1::uuid[]) AS s(id)`,
    [sectionIds],
  );
  for (const r of rows) {
    out.set(r.section_id, {
      reads: r.reads,
      last_read_at: r.last_read_at,
      daily: r.daily,
      week: r.week,
      previous_week: r.previous_week,
    });
  }
  return out;
}

// ───────────────────────────── the overview ─────────────────────────────

const PERIOD_DAYS: Record<ActivityPeriod, number | null> = { '7d': 7, '30d': 30, all: null };
/** All time shows a GitHub-style year of days. */
const ALL_DAYS = 53 * 7;

interface Window {
  /** Start of the period; -infinity for all time. */
  start: string;
  /** Start of the period before; null for all time. */
  prev: string | null;
  /** First day of the daily series. */
  first_day: string;
  days: string[];
}

async function windowOf(db: Queryable, period: ActivityPeriod): Promise<Window> {
  const n = PERIOD_DAYS[period];
  const shown = n ?? ALL_DAYS;
  const { rows } = await db.query<Window>(
    `SELECT CASE WHEN $1::int IS NULL THEN '-infinity' ELSE (current_date - ($1::int - 1))::timestamptz::text END AS start,
            CASE WHEN $1::int IS NULL THEN NULL ELSE (current_date - (2 * $1::int - 1))::timestamptz::text END AS prev,
            (current_date - ($2::int - 1))::text AS first_day,
            ARRAY(SELECT g::date::text FROM generate_series(current_date - ($2::int - 1), current_date, interval '1 day') g) AS days`,
    [n, shown],
  );
  return rows[0];
}

/**
 * Count events per key over a window: the top `limit` keys by count in the period,
 * with the previous period and one count per day. `events` is SQL that yields
 * (key, at) rows; $1 is the window start (events before COALESCE(prev, start)
 * may be filtered out by it), followed by `params`.
 */
async function ranked(
  db: Queryable,
  w: Window,
  events: string,
  params: unknown[],
  limit: number | null,
) {
  const p = params.length;
  const { rows } = await db.query<ActivityFigure & { key: string }>(
    `WITH ev AS (${events}),
          top AS (SELECT key, count(*) FILTER (WHERE at >= $1::timestamptz)::int AS count FROM ev
                   GROUP BY key HAVING count(*) FILTER (WHERE at >= $1::timestamptz) > 0
                   ORDER BY 2 DESC ${limit ? `LIMIT ${limit}` : ''})
     SELECT top.key, top.count,
            CASE WHEN $${p + 2}::timestamptz IS NULL THEN NULL
                 ELSE (SELECT count(*)::int FROM ev WHERE ev.key = top.key AND ev.at >= $${p + 2}::timestamptz AND ev.at < $1::timestamptz) END AS previous,
            ARRAY(SELECT count(ev.at)::int
                    FROM generate_series($${p + 3}::date, current_date, interval '1 day') g
                    LEFT JOIN ev ON ev.key = top.key AND ev.at >= g AND ev.at < g + interval '1 day'
                   GROUP BY g ORDER BY g) AS daily
       FROM top ORDER BY top.count DESC, top.key`,
    [w.start, ...params, w.prev, w.first_day],
  );
  return rows;
}

/** The earliest time an event can matter for this window. */
const FROM = (n: number) => `COALESCE($${n}::timestamptz, $1::timestamptz)`;

function zero(w: Window, prev: boolean): ActivityFigure {
  return { count: 0, previous: prev ? 0 : null, daily: w.days.map(() => 0) };
}

async function names<T>(db: Queryable, sql: string, ids: string[]): Promise<Map<string, T>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<T & { id: string }>(sql, [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

const DOC_NAMES = `SELECT d.id, d.title, concat_ws(' › ', p.name, sc.name) AS "where"
                     FROM documents d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN scopes sc ON sc.id = d.scope_id
                    WHERE d.id = ANY($1::uuid[])`;

/** What agents did in and with an organization over a period. */
export async function organizationActivity(
  db: Queryable,
  a: Access,
  orgId: string,
  period: ActivityPeriod,
): Promise<OrgActivity> {
  a.requireRead(orgId);
  const w = await windowOf(db, period);
  const n = 2; // $2 = the organization in every query below; prev is $3.
  const hasPrev = w.prev !== null;

  // Requests made by the organization's agents.
  const requests = (kind: 'read' | 'write', key: string) =>
    `SELECT ${key} AS key, created_at AS at FROM agent_requests
      WHERE organization_id = $2 AND kind = '${kind}' AND ${key} IS NOT NULL AND created_at >= ${FROM(n + 1)}`;
  const totals = async (kind: 'read' | 'write') =>
    (await ranked(db, w, requests(kind, 'organization_id'), [orgId], 1))[0] ?? zero(w, hasPrev);

  const [reads, writes, docReads, projectReads, docWrites, writers] = [
    await totals('read'),
    await totals('write'),
    // Reads of this organization's documents and the group-wide ones its agents get too, by any
    // agent.
    await ranked(
      db,
      w,
      `SELECT DISTINCT r.document_id AS key, r.request_id, r.created_at AS at
         FROM section_reads r JOIN documents d ON d.id = r.document_id
        WHERE (d.organization_id = $2 OR d.organization_id IS NULL) AND r.created_at >= ${FROM(n + 1)}`,
      [orgId],
      3,
    ),
    await ranked(
      db,
      w,
      `SELECT r.project_id AS key, r.created_at AS at
         FROM agent_requests r JOIN projects p ON p.id = r.project_id
        WHERE p.organization_id = $2 AND r.kind = 'read' AND r.created_at >= ${FROM(n + 1)}`,
      [orgId],
      3,
    ),
    await ranked(
      db,
      w,
      `SELECT r.document_id AS key, r.created_at AS at
         FROM agent_requests r JOIN documents d ON d.id = r.document_id
        WHERE (d.organization_id = $2 OR d.organization_id IS NULL) AND r.kind = 'write' AND r.created_at >= ${FROM(n + 1)}`,
      [orgId],
      3,
    ),
    await ranked(db, w, requests('write', 'actor_id'), [orgId], 3),
  ];

  const docNames = await names<{ title: string; where: string }>(
    db,
    DOC_NAMES,
    [...docReads, ...docWrites].map((r) => r.key),
  );
  const projectNames = await names<{ name: string; slug: string }>(
    db,
    'SELECT id, name, slug FROM projects WHERE id = ANY($1::uuid[])',
    projectReads.map((r) => r.key),
  );
  const actorNames = await names<{ name: string }>(
    db,
    'SELECT id, name FROM actors WHERE id = ANY($1::uuid[])',
    writers.map((r) => r.key),
  );
  const fig = (r: ActivityFigure) => ({ count: r.count, previous: r.previous, daily: r.daily });
  const doc = (r: ActivityFigure & { key: string }) => ({
    id: r.key,
    title: docNames.get(r.key)?.title ?? 'Deleted document',
    where: docNames.get(r.key)?.where ?? '',
    ...fig(r),
  });

  const since = await trackingSince(db);
  const { rows: docs } = await db.query<{
    id: string;
    title: string;
    where: string;
    created_at: string;
    last_read_at: string | null;
  }>(
    `SELECT d.id, d.title, concat_ws(' › ', p.name, sc.name) AS "where", d.created_at,
            (SELECT max(r.created_at) FROM section_reads r WHERE r.document_id = d.id) AS last_read_at
       FROM documents d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN scopes sc ON sc.id = d.scope_id
      WHERE d.organization_id = $1 AND d.disabled_at IS NULL AND (p.id IS NULL OR p.archived_at IS NULL)
      ORDER BY d.title`,
    [orgId],
  );
  const stale = docs
    .map((d) => ({
      id: d.id,
      title: d.title,
      where: d.where,
      last_read_at: d.last_read_at,
      staleness: stalenessOf(d.created_at, since, d.last_read_at),
    }))
    .filter((d): d is typeof d & { staleness: Staleness } =>
      period === '7d' ? d.staleness !== null : d.staleness === 'month',
    );

  return {
    period,
    days: w.days,
    tracking_since: since,
    reads: fig(reads),
    writes: fig(writes),
    most_read_documents: docReads.map(doc),
    most_read_projects: projectReads.map((r) => ({
      id: r.key,
      name: projectNames.get(r.key)?.name ?? 'Deleted project',
      slug: projectNames.get(r.key)?.slug ?? '',
      ...fig(r),
    })),
    most_written_documents: docWrites.map(doc),
    top_writers: writers.map((r) => ({
      id: r.key,
      name: actorNames.get(r.key)?.name ?? 'Removed agent',
      ...fig(r),
    })),
    stale_documents: stale,
  };
}
