-- Charter: shared, scoped context for humans and coding agents.
--
-- Hierarchy:  organization (implicit, one per instance)
--               └─ scopes with project_id IS NULL      (org-wide, e.g. "all .NET code")
--               └─ projects                            (a logical product, may span many repos)
--                    ├─ repositories                   (git remotes mapped to the project)
--                    └─ scopes                         (path globs / stack tags inside the project)
--
-- Documents hang off one level (org, project or scope) and are split into sections.
-- Every section has an edit mode that decides what agents may do with it.

CREATE TYPE actor_kind AS ENUM ('human', 'agent');
CREATE TYPE actor_role AS ENUM ('admin', 'editor', 'viewer', 'agent');
CREATE TYPE edit_mode AS ENUM ('locked', 'propose', 'open');
CREATE TYPE doc_kind AS ENUM ('purpose', 'business_logic', 'glossary', 'guidelines', 'reference', 'learnings');
CREATE TYPE proposal_kind AS ENUM ('edit_section', 'new_section', 'learning');
CREATE TYPE proposal_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE actors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        actor_kind NOT NULL,
  role        actor_role NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT agent_role_matches_kind CHECK ((kind = 'agent') = (role = 'agent'))
);

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  label        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text NOT NULL,
  summary     text NOT NULL DEFAULT '',
  reviewed    boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES actors(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE repositories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  remote_key  text NOT NULL UNIQUE,
  remote_url  text NOT NULL,
  created_by  uuid REFERENCES actors(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX repositories_project_idx ON repositories(project_id);

CREATE TABLE scopes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  path_globs  text[] NOT NULL DEFAULT '{}',
  stacks      text[] NOT NULL DEFAULT '{}',
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scopes_slug_unique
  ON scopes (COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  scope_id    uuid REFERENCES scopes(id) ON DELETE CASCADE,
  kind        doc_kind NOT NULL,
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  title       text NOT NULL,
  mode        edit_mode NOT NULL DEFAULT 'propose',
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX documents_slug_unique ON documents (
  COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(scope_id,   '00000000-0000-0000-0000-000000000000'::uuid),
  slug
);

CREATE TABLE sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  heading     text NOT NULL,
  body        text NOT NULL DEFAULT '',
  mode        edit_mode NOT NULL,
  position    int NOT NULL DEFAULT 0,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES actors(id) ON DELETE SET NULL,
  search      tsvector GENERATED ALWAYS AS (to_tsvector('simple', heading || ' ' || body)) STORED
);
CREATE INDEX sections_document_idx ON sections(document_id, position);
CREATE INDEX sections_search_idx ON sections USING gin(search);

CREATE TABLE section_versions (
  id          bigserial PRIMARY KEY,
  section_id  uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  version     int NOT NULL,
  heading     text NOT NULL,
  body        text NOT NULL,
  mode        edit_mode NOT NULL,
  actor_id    uuid REFERENCES actors(id) ON DELETE SET NULL,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (section_id, version)
);

CREATE TABLE proposals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              proposal_kind NOT NULL,
  status            proposal_status NOT NULL DEFAULT 'pending',
  project_id        uuid REFERENCES projects(id) ON DELETE CASCADE,
  scope_id          uuid REFERENCES scopes(id) ON DELETE SET NULL,
  document_id       uuid REFERENCES documents(id) ON DELETE CASCADE,
  section_id        uuid REFERENCES sections(id) ON DELETE CASCADE,
  base_version      int,
  heading           text NOT NULL DEFAULT '',
  body              text NOT NULL,
  rationale         text NOT NULL DEFAULT '',
  context           jsonb NOT NULL DEFAULT '{}',
  created_by        uuid REFERENCES actors(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  reviewed_by       uuid REFERENCES actors(id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  review_note       text NOT NULL DEFAULT '',
  result_section_id uuid REFERENCES sections(id) ON DELETE SET NULL
);
CREATE INDEX proposals_status_idx ON proposals(status, created_at DESC);

-- Obsidian-style [[wikilinks]] found in section bodies. Targets are stored as
-- written (normalised) and resolved at read time, so a link to a project or
-- term that does not exist yet starts working as soon as it is created.
--   target_kind: 'project' ([[project:x]]), 'term' ([[term:x]]) or 'any' ([[x]])
CREATE TABLE section_links (
  section_id  uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('project', 'term', 'any')),
  target      text NOT NULL,
  label       text NOT NULL DEFAULT '',
  PRIMARY KEY (section_id, target_kind, target)
);
CREATE INDEX section_links_target_idx ON section_links(target);
