-- A project scope can be bound to some of the project's repositories, e.g.
-- "Frontend" = the Angular repository and ".NET" = the API repository. Bound
-- scopes only apply in those repositories; their paths and stacks, if any,
-- narrow them further. Unbound scopes match paths and stacks in any repository
-- (the monorepo case).

CREATE TABLE scope_repositories (
  group_id      uuid NOT NULL DEFAULT openpurpose_group() REFERENCES groups(id) ON DELETE CASCADE,
  scope_id      uuid NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, repository_id)
);
CREATE INDEX scope_repositories_repository_idx ON scope_repositories (repository_id);

ALTER TABLE scope_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY group_isolation ON scope_repositories USING (openpurpose_bypass() OR group_id = openpurpose_group())
  WITH CHECK (openpurpose_bypass() OR group_id = openpurpose_group());
