-- API descriptions (OpenAPI 3 / Swagger 2) attached to a project, so agents can
-- look up its endpoints and DTOs. Added from a URL OpenPurpose re-fetches, or as an
-- uploaded file.

CREATE TABLE api_specs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id       uuid NOT NULL DEFAULT openpurpose_group() REFERENCES groups(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Optional label, e.g. "Public API" when a project has several. Defaults to the spec's title.
  name           text NOT NULL DEFAULT '',
  source_url     text,
  filename       text,
  -- json, not jsonb: keeps property order, which is the order DTOs are shown in.
  spec           json NOT NULL,
  source_format  text NOT NULL DEFAULT 'json' CHECK (source_format IN ('json', 'yaml')),
  spec_version   text NOT NULL DEFAULT '',
  title          text NOT NULL DEFAULT '',
  version        text NOT NULL DEFAULT '',
  endpoint_count int NOT NULL DEFAULT 0,
  schema_count   int NOT NULL DEFAULT 0,
  content_hash   text NOT NULL DEFAULT '',
  fetched_at     timestamptz,
  fetch_error    text,
  created_by     uuid REFERENCES actors(id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES actors(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (source_url IS NOT NULL OR filename IS NOT NULL)
);
CREATE INDEX api_specs_project_idx ON api_specs (project_id);

ALTER TABLE api_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_specs FORCE ROW LEVEL SECURITY;
CREATE POLICY group_isolation ON api_specs USING (openpurpose_bypass() OR group_id = openpurpose_group())
  WITH CHECK (openpurpose_bypass() OR group_id = openpurpose_group());
