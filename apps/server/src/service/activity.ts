import type pg from 'pg';
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

/**
 * When agents first requested anything in this workspace (row-level security narrows it), as a
 * subquery: the start of what staleness can know about.
 */
export const TRACKING_SINCE_SQL = '(SELECT min(created_at) FROM agent_requests)';

/** The last time agents read a section of the document with id `docId` (a SQL expression). */
export const lastReadSql = (docId: string) =>
  `(SELECT max(r.created_at) FROM section_reads r WHERE r.document_id = ${docId})`;

/** A document row with `last_read_at` and `tracking_since` selected alongside it. */
export interface DocumentReadRow {
  created_at: string;
  disabled_at: string | null;
  last_read_at: string | null;
  tracking_since: string | null;
}

/** Turn `last_read_at` and `tracking_since` into the activity people see. */
export function withActivity<T extends DocumentReadRow>(
  row: T,
): Omit<T, 'tracking_since'> & DocumentActivity {
  const { tracking_since, ...doc } = row;
  return {
    ...doc,
    disabled_at: row.disabled_at,
    last_read_at: row.last_read_at,
    staleness: row.disabled_at
      ? null
      : stalenessOf(row.created_at, tracking_since, row.last_read_at),
  };
}

/** Staleness and last read of documents, by id, in one round trip. No permission check. */
export async function documentActivity(
  db: Queryable,
  docs: { id: string; created_at: string; disabled_at: string | null }[],
): Promise<Map<string, DocumentActivity>> {
  const out = new Map<string, DocumentActivity>();
  if (!docs.length) return out;
  const { rows } = await db.query<{ id: string; last_read_at: string | null; at: string | null }>(
    `SELECT d.id, ${lastReadSql('d.id')} AS last_read_at, ${TRACKING_SINCE_SQL} AS at
       FROM unnest($1::uuid[]) AS d(id)`,
    [docs.map((d) => d.id)],
  );
  const read = new Map(rows.map((r) => [r.id, r]));
  for (const d of docs) {
    const r = read.get(d.id);
    const { disabled_at, last_read_at, staleness } = withActivity({
      created_at: d.created_at,
      disabled_at: d.disabled_at,
      last_read_at: r?.last_read_at ?? null,
      tracking_since: r?.at ?? null,
    });
    out.set(d.id, { disabled_at, last_read_at, staleness });
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

/** The row type of `sectionActivitySql`. */
export interface SectionActivityRow extends SectionActivity {
  section_id: string;
}

/**
 * Read counts of the sections `from` yields as `s(id)`, e.g. `unnest($1::uuid[]) AS s(id)` or
 * `sections s WHERE s.document_id = ...`.
 */
export const sectionActivitySql = (from: string) => `SELECT s.id AS section_id,
            (SELECT count(*)::int FROM section_reads r WHERE r.section_id = s.id) AS reads,
            (SELECT max(created_at) FROM section_reads r WHERE r.section_id = s.id) AS last_read_at,
            ARRAY(SELECT count(r.request_id)::int
                    FROM generate_series(current_date - 27, current_date, interval '1 day') g
                    LEFT JOIN section_reads r ON r.section_id = s.id AND r.created_at >= g AND r.created_at < g + interval '1 day'
                   GROUP BY g ORDER BY g) AS daily,
            (SELECT count(*)::int FROM section_reads r WHERE r.section_id = s.id AND r.created_at >= current_date - 6) AS week,
            (SELECT count(*)::int FROM section_reads r WHERE r.section_id = s.id
                AND r.created_at >= current_date - 13 AND r.created_at < current_date - 6) AS previous_week
       FROM ${from}`;

/** Read counts of sections, by id. No permission check; callers check. */
export async function sectionActivity(
  db: Queryable,
  sectionIds: string[],
): Promise<Map<string, SectionActivity>> {
  if (!sectionIds.length) return new Map();
  const { rows } = await db.query<SectionActivityRow>(
    sectionActivitySql('unnest($1::uuid[]) AS s(id)'),
    [sectionIds],
  );
  return activityById(rows);
}

/** Section activity rows by section id. */
export function activityById(rows: SectionActivityRow[]): Map<string, SectionActivity> {
  const out = new Map<string, SectionActivity>();
  for (const { section_id, ...activity } of rows) out.set(section_id, activity);
  return out;
}

// ───────────────────────────── the overview ─────────────────────────────

const PERIOD_DAYS: Record<ActivityPeriod, number | null> = { '7d': 7, '30d': 30, all: null };
/** All time shows a GitHub-style year of days. */
const ALL_DAYS = 53 * 7;

/**
 * The period as SQL, from the database's own date: `start` of the period (-infinity for all
 * time), `prev` the start of the period before (null for all time), `first_day` of the daily
 * series, and `days`.
 */
const windowSql = (period: ActivityPeriod) => {
  const n = PERIOD_DAYS[period];
  const shown = n ?? ALL_DAYS;
  return `SELECT ${n === null ? `'-infinity'::timestamptz` : `(current_date - ${n - 1})::timestamptz`} AS start,
          ${n === null ? 'NULL::timestamptz' : `(current_date - ${2 * n - 1})::timestamptz`} AS prev,
          current_date - ${shown - 1} AS first_day,
          ARRAY(SELECT g::date::text FROM generate_series(current_date - ${shown - 1}, current_date, interval '1 day') g) AS days`;
};

/** The earliest time an event can matter for the window `w`. */
const FROM_W = '(SELECT COALESCE(prev, start) FROM w)';

/**
 * Count events per key over the window: the top `limit` keys by count in the period, with the
 * previous period, one count per day and whatever `label` (SQL selecting from `l`, joined on
 * `l.id = top.key`) names them by. `events` is SQL that yields (key, at) rows and may use
 * FROM_W to skip events too old to matter.
 */
const rankedSql = (
  period: ActivityPeriod,
  events: string,
  limit: number,
  label?: { from: string; columns: string },
) => `WITH w AS (${windowSql(period)}),
       ev AS (${events}),
       top AS (SELECT key, count(*) FILTER (WHERE at >= (SELECT start FROM w))::int AS count FROM ev
                GROUP BY key HAVING count(*) FILTER (WHERE at >= (SELECT start FROM w)) > 0
                ORDER BY 2 DESC LIMIT ${limit})
  SELECT top.key, top.count,
         CASE WHEN (SELECT prev FROM w) IS NULL THEN NULL
              ELSE (SELECT count(*)::int FROM ev WHERE ev.key = top.key
                       AND ev.at >= (SELECT prev FROM w) AND ev.at < (SELECT start FROM w)) END AS previous,
         ARRAY(SELECT count(ev.at)::int
                 FROM generate_series((SELECT first_day FROM w), current_date, interval '1 day') g
                 LEFT JOIN ev ON ev.key = top.key AND ev.at >= g AND ev.at < g + interval '1 day'
                GROUP BY g ORDER BY g) AS daily
         ${label ? `, ${label.columns}` : ''}
    FROM top ${label ? `LEFT JOIN ${label.from} ON l.id = top.key` : ''}
   ORDER BY top.count DESC, top.key`;

type Ranked<T = object> = ActivityFigure & { key: string } & Partial<T>;

const DOC_LABEL = {
  from: `(SELECT d.id, d.title, concat_ws(' › ', p.name, sc.name) AS "where" FROM documents d
           LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN scopes sc ON sc.id = d.scope_id) l`,
  columns: 'l.title, l."where"',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What agents did in and with an organization over a period, in one round trip. */
export async function organizationActivity(
  db: Queryable,
  a: Access,
  orgId: string,
  period: ActivityPeriod,
): Promise<OrgActivity> {
  a.requireRead(orgId);
  // Several statements can't take $1, so the organization goes in as a literal. requireRead
  // only passes for organizations loaded from the database, and their ids are uuids.
  if (!UUID.test(orgId)) throw new Error(`Not a uuid: ${orgId}`);
  const org = `'${orgId}'::uuid`;

  // Requests made by the organization's agents.
  const requests = (kind: 'read' | 'write', key: string) =>
    `SELECT ${key} AS key, created_at AS at FROM agent_requests
      WHERE organization_id = ${org} AND kind = '${kind}' AND ${key} IS NOT NULL AND created_at >= ${FROM_W}`;

  const [win, reads, writes, docReads, projectReads, docWrites, writers, sinceRes, docsRes] =
    (await db.query(`
    ${windowSql(period)};
    ${rankedSql(period, requests('read', 'organization_id'), 1)};
    ${rankedSql(period, requests('write', 'organization_id'), 1)};
    ${rankedSql(
        period,
        // Reads of this organization's documents and the group-wide ones its agents get too, by
        // any agent.
        `SELECT DISTINCT r.document_id AS key, r.request_id, r.created_at AS at
         FROM section_reads r JOIN documents d ON d.id = r.document_id
        WHERE (d.organization_id = ${org} OR d.organization_id IS NULL) AND r.created_at >= ${FROM_W}`,
        3,
        DOC_LABEL,
      )};
    ${rankedSql(
        period,
        `SELECT r.project_id AS key, r.created_at AS at
         FROM agent_requests r JOIN projects p ON p.id = r.project_id
        WHERE p.organization_id = ${org} AND r.kind = 'read' AND r.created_at >= ${FROM_W}`,
        3,
        { from: 'projects l', columns: 'l.name, l.slug' },
      )};
    ${rankedSql(
        period,
        `SELECT r.document_id AS key, r.created_at AS at
         FROM agent_requests r JOIN documents d ON d.id = r.document_id
        WHERE (d.organization_id = ${org} OR d.organization_id IS NULL) AND r.kind = 'write' AND r.created_at >= ${FROM_W}`,
        3,
        DOC_LABEL,
      )};
    ${rankedSql(period, requests('write', 'actor_id'), 3, { from: 'actors l', columns: 'l.name' })};
    SELECT ${TRACKING_SINCE_SQL} AS at;
    SELECT d.id, d.title, concat_ws(' › ', p.name, sc.name) AS "where", d.created_at,
           ${lastReadSql('d.id')} AS last_read_at
      FROM documents d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN scopes sc ON sc.id = d.scope_id
     WHERE d.organization_id = ${org} AND d.disabled_at IS NULL AND (p.id IS NULL OR p.archived_at IS NULL)
     ORDER BY d.title`)) as unknown as [
      pg.QueryResult<{ days: string[] }>,
      pg.QueryResult<Ranked>,
      pg.QueryResult<Ranked>,
      pg.QueryResult<Ranked<{ title: string; where: string }>>,
      pg.QueryResult<Ranked<{ name: string; slug: string }>>,
      pg.QueryResult<Ranked<{ title: string; where: string }>>,
      pg.QueryResult<Ranked<{ name: string }>>,
      pg.QueryResult<{ at: string | null }>,
      pg.QueryResult<{
        id: string;
        title: string;
        where: string;
        created_at: string;
        last_read_at: string | null;
      }>,
    ];
  const days = win.rows[0].days;
  const hasPrev = period !== 'all';
  const zero: ActivityFigure = { count: 0, previous: hasPrev ? 0 : null, daily: days.map(() => 0) };
  const fig = (r: ActivityFigure) => ({ count: r.count, previous: r.previous, daily: r.daily });
  const doc = (r: Ranked<{ title: string; where: string }>) => ({
    id: r.key,
    title: r.title ?? 'Deleted document',
    where: r.where ?? '',
    ...fig(r),
  });

  const since = sinceRes.rows[0].at;
  const stale = docsRes.rows
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
    days,
    tracking_since: since,
    reads: fig(reads.rows[0] ?? zero),
    writes: fig(writes.rows[0] ?? zero),
    most_read_documents: docReads.rows.map(doc),
    most_read_projects: projectReads.rows.map((r) => ({
      id: r.key,
      name: r.name ?? 'Deleted project',
      slug: r.slug ?? '',
      ...fig(r),
    })),
    most_written_documents: docWrites.rows.map(doc),
    top_writers: writers.rows.map((r) => ({
      id: r.key,
      name: r.name ?? 'Removed agent',
      ...fig(r),
    })),
    stale_documents: stale,
  };
}
