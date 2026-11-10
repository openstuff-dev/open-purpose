-- The stacks seen in each repository, so list_scopes can tell an agent which stacks the projects of
-- an organization share and which of those no organization scope covers yet.
--
-- get_context records them whenever an agent sends a manifest or stacks for a repository that is
-- mapped to a project. A stack stays until its repository is removed; seen_at says when it was last
-- reported.

CREATE TABLE repository_stacks (
  group_id      uuid NOT NULL DEFAULT openpurpose_group() REFERENCES groups(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  stack         text NOT NULL,
  seen_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, stack)
);

ALTER TABLE repository_stacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_stacks FORCE ROW LEVEL SECURITY;
CREATE POLICY group_isolation ON repository_stacks USING (openpurpose_bypass() OR group_id = openpurpose_group())
  WITH CHECK (openpurpose_bypass() OR group_id = openpurpose_group());
