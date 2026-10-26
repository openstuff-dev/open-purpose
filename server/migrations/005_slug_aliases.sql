-- Old slugs of renamed organizations, projects and scopes. They keep resolving
-- (.agentcontext.json files, [[links]], get_context's scopes) until someone
-- removes them. A current slug always wins over an alias.

CREATE TABLE slug_aliases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        uuid NOT NULL DEFAULT openpurpose_group() REFERENCES groups(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  scope_id        uuid REFERENCES scopes(id) ON DELETE CASCADE,
  old_slug        text NOT NULL CHECK (old_slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  created_by      uuid REFERENCES actors(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(organization_id, project_id, scope_id) = 1)
);
CREATE UNIQUE INDEX slug_aliases_org_unique ON slug_aliases (organization_id, old_slug) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX slug_aliases_project_unique ON slug_aliases (project_id, old_slug) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX slug_aliases_scope_unique ON slug_aliases (scope_id, old_slug) WHERE scope_id IS NOT NULL;
CREATE INDEX slug_aliases_slug_idx ON slug_aliases (group_id, old_slug);

ALTER TABLE slug_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE slug_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY group_isolation ON slug_aliases USING (openpurpose_bypass() OR group_id = openpurpose_group())
  WITH CHECK (openpurpose_bypass() OR group_id = openpurpose_group());
