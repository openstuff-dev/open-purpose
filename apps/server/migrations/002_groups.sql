-- Groups and organizations.
--
--   group (tenant, e.g. "Microsoft")          ← isolation boundary, enforced by row-level security
--     ├─ group-wide documents and scopes       ← reach every organization in the group
--     └─ organizations ("GitHub", "Azure")     ← private to their members unless read access is granted
--          ├─ organization documents and scopes
--          └─ projects → repositories, scopes
--
-- A v1 database is upgraded in place: everything moves into one group with one
-- organization, and the old roles become memberships.

CREATE TABLE groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text NOT NULL,
  summary     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (group_id, slug),
  UNIQUE (group_id, id)
);

-- Roles per level. organization_id NULL = a role in the group itself.
-- Group admins administer every organization; other group roles read every organization
-- and edit group-wide content only (editors). Agents belong to exactly one organization.
CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id        uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  group_id        uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  role            actor_role NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_belong_to_an_organization CHECK (role <> 'agent' OR organization_id IS NOT NULL)
);
CREATE UNIQUE INDEX memberships_unique
  ON memberships (actor_id, group_id, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX memberships_group_idx ON memberships (group_id);

-- Members (people and agents) of reader_org may read target_org's content.
CREATE TABLE org_read_grants (
  group_id      uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  reader_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reader_org_id, target_org_id),
  CHECK (reader_org_id <> target_org_id)
);

ALTER TABLE actors ADD COLUMN is_superadmin boolean NOT NULL DEFAULT false;

-- ───────────────────────── new columns ─────────────────────────
ALTER TABLE projects     ADD COLUMN group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
                         ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE repositories ADD COLUMN group_id uuid REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE scopes       ADD COLUMN group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
                         ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE documents    ADD COLUMN group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
                         ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE sections         ADD COLUMN group_id uuid REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE section_versions ADD COLUMN group_id uuid REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE section_links    ADD COLUMN group_id uuid REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE proposals        ADD COLUMN group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
                             ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

-- ───────────────────────── upgrade v1 data ─────────────────────────
DO $$
DECLARE
  g uuid;
  o uuid;
  org_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM actors) AND NOT EXISTS (SELECT 1 FROM documents) THEN
    RETURN;
  END IF;
  org_name := COALESCE((SELECT value #>> '{}' FROM settings WHERE key = 'org_name'), 'Our organization');
  INSERT INTO groups (slug, name) VALUES ('default', org_name) RETURNING id INTO g;
  INSERT INTO organizations (group_id, slug, name) VALUES (g, 'main', org_name) RETURNING id INTO o;

  UPDATE projects     SET group_id = g, organization_id = o;
  UPDATE repositories SET group_id = g;
  UPDATE scopes       SET group_id = g, organization_id = o;   -- v1 "organization-wide" scopes stay in that organization
  UPDATE documents    SET group_id = g, organization_id = o;
  UPDATE sections         SET group_id = g;
  UPDATE section_versions SET group_id = g;
  UPDATE section_links    SET group_id = g;
  UPDATE proposals        SET group_id = g, organization_id = o;

  -- v1 admins administer the whole group and the server; editors and viewers keep their role in the organization.
  INSERT INTO memberships (actor_id, group_id, organization_id, role)
  SELECT id, g, CASE WHEN role = 'admin' THEN NULL ELSE o END, role FROM actors;
  UPDATE actors SET is_superadmin = true WHERE role = 'admin';
END $$;

DELETE FROM settings WHERE key = 'org_name';

ALTER TABLE actors DROP CONSTRAINT agent_role_matches_kind;
ALTER TABLE actors DROP COLUMN role;

ALTER TABLE projects     ALTER COLUMN group_id SET NOT NULL, ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE repositories ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE scopes       ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE documents    ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE sections         ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE section_versions ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE section_links    ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE proposals        ALTER COLUMN group_id SET NOT NULL;

-- A project's scopes and documents always sit in the project's organization.
ALTER TABLE scopes    ADD CONSTRAINT scope_project_needs_org CHECK (project_id IS NULL OR organization_id IS NOT NULL);
ALTER TABLE documents ADD CONSTRAINT document_project_needs_org CHECK (project_id IS NULL OR organization_id IS NOT NULL);

-- Uniqueness is now per group / per organization.
ALTER TABLE projects DROP CONSTRAINT projects_slug_key;
CREATE UNIQUE INDEX projects_slug_unique ON projects (organization_id, slug);
CREATE INDEX projects_group_idx ON projects (group_id);

ALTER TABLE repositories DROP CONSTRAINT repositories_remote_key_key;
CREATE UNIQUE INDEX repositories_remote_unique ON repositories (group_id, remote_key);

DROP INDEX scopes_slug_unique;
CREATE UNIQUE INDEX scopes_slug_unique ON scopes (
  group_id,
  COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(project_id,      '00000000-0000-0000-0000-000000000000'::uuid),
  slug
);

DROP INDEX documents_slug_unique;
CREATE UNIQUE INDEX documents_slug_unique ON documents (
  group_id,
  COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(project_id,      '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(scope_id,        '00000000-0000-0000-0000-000000000000'::uuid),
  slug
);
CREATE INDEX documents_level_idx ON documents (group_id, organization_id, project_id, scope_id);
CREATE INDEX proposals_org_idx ON proposals (group_id, organization_id, status);

-- ───────────────────────── row-level security ─────────────────────────
-- Every request runs in a transaction that sets openpurpose.group_id. Rows of other
-- groups are invisible, even to a query that forgets its WHERE clause.
-- openpurpose.bypass is only set by migrations, bootstrap and server-admin operations.
CREATE FUNCTION openpurpose_group() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('openpurpose.group_id', true), '')::uuid $$;
CREATE FUNCTION openpurpose_bypass() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('openpurpose.bypass', true), '') = 'on' $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations', 'memberships', 'org_read_grants', 'projects', 'repositories',
                           'scopes', 'documents', 'sections', 'section_versions', 'section_links', 'proposals']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN group_id SET DEFAULT openpurpose_group()', t);
    EXECUTE format('CREATE POLICY group_isolation ON %I USING (openpurpose_bypass() OR group_id = openpurpose_group())
                    WITH CHECK (openpurpose_bypass() OR group_id = openpurpose_group())', t);
  END LOOP;
END $$;

-- Superusers ignore row-level security, so when OpenPurpose connects as one (the
-- default in Docker), it switches to this role on every connection.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpurpose_app')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolcreaterole)) THEN
    CREATE ROLE openpurpose_app NOLOGIN;
  END IF;
END $$;
