import type { Queryable } from '../db.js';

/** Remember the stacks an agent reported for one of a project's repositories. */
export async function recordStacks(
  db: Queryable,
  projectId: string,
  remoteKey: string,
  stacks: string[],
): Promise<void> {
  if (!stacks.length) return;
  await db.query(
    `INSERT INTO repository_stacks (repository_id, stack)
     SELECT r.id, s FROM repositories r, unnest($3::text[]) AS s
      WHERE r.project_id = $1 AND r.remote_key = $2
     ON CONFLICT (repository_id, stack) DO UPDATE SET seen_at = now()`,
    [projectId, remoteKey, stacks],
  );
}

export interface OrganizationStack {
  stack: string;
  /** Slugs of the organization's projects that use it. */
  projects: string[];
  /** Slugs of the organization and workspace scopes that match it. */
  scopes: string[];
}

/** The stacks the organization's projects use, most shared first, and the scopes covering them. */
export async function stacksOfOrganization(
  db: Queryable,
  organizationId: string,
): Promise<OrganizationStack[]> {
  const { rows } = await db.query<OrganizationStack>(
    `SELECT rs.stack,
            array_agg(DISTINCT p.slug ORDER BY p.slug) AS projects,
            ARRAY(SELECT sc.slug FROM scopes sc
                   WHERE sc.project_id IS NULL AND rs.stack = ANY(sc.stacks)
                     AND (sc.organization_id = $1 OR sc.organization_id IS NULL)
                   ORDER BY sc.slug) AS scopes
       FROM repository_stacks rs
       JOIN repositories r ON r.id = rs.repository_id
       JOIN projects p ON p.id = r.project_id
      WHERE p.organization_id = $1 AND p.archived_at IS NULL
      GROUP BY rs.stack
      ORDER BY count(DISTINCT p.id) DESC, rs.stack`,
    [organizationId],
  );
  return rows;
}
