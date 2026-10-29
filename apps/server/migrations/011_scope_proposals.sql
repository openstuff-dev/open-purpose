-- Scope proposals: an agent suggests a new scope (a part of a project, or a kind of
-- code across an organization) and a person creates it by approving the proposal.
--
-- heading holds the scope's name and body its description, so revisions, review
-- threads and suggestions work as for sections. scope_spec holds the rest:
-- {"slug": "...", "path_globs": [...], "stacks": [...], "repository_ids": [...]}.

ALTER TYPE proposal_kind ADD VALUE 'new_scope';

ALTER TABLE proposals
  ADD COLUMN scope_spec      jsonb,
  ADD COLUMN result_scope_id uuid REFERENCES scopes(id) ON DELETE SET NULL;
