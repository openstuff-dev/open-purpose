import type { Access } from '../auth.js';
import type { Queryable } from '../db.js';
import type { AgentReview } from '@openpurpose/contracts';

export interface AgentRules {
  review: AgentReview;
  accept_findings: boolean;
  /** Who turned the current permissions on, for the notes left on what skipped review. */
  set_by_name: string | null;
}

const DEFAULT: AgentRules = { review: 'edit_modes', accept_findings: false, set_by_name: null };

/** What an admin lets this agent do without review. People always get the defaults. */
export async function agentRules(db: Queryable, a: Access): Promise<AgentRules> {
  if (!a.isAgent) return DEFAULT;
  const { rows } = await db.query<AgentRules>(
    `SELECT a.review, a.accept_findings, pb.name AS set_by_name
       FROM actors a LEFT JOIN actors pb ON pb.id = a.permissions_by WHERE a.id = $1`,
    [a.actor.id],
  );
  return rows.at(0) ?? DEFAULT;
}

/**
 * Auto-approval covers the agent's own organization only: group-wide proposals still need a
 * group editor, whoever set the agent's permissions.
 */
export function autoApproves(a: Access, rules: AgentRules, orgId: string | null): boolean {
  return rules.review === 'auto_approve' && orgId !== null && a.canAgentWrite(orgId);
}
