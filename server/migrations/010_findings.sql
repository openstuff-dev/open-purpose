-- Findings: problems an agent noticed outside its task and didn't fix.
--
-- A finding names a file, says what's wrong and how to fix it, and is filed
-- under the most specific matching scope of a project, like a learning. People
-- sort it (to do, ask me later, dismissed); an agent marks it solved when it
-- fixes it. Findings are not rules: they never become sections.

CREATE TYPE finding_status AS ENUM ('new', 'todo', 'ask_later', 'dismissed', 'solved');

CREATE TABLE findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        uuid NOT NULL DEFAULT openpurpose_group() REFERENCES groups(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_id        uuid REFERENCES scopes(id) ON DELETE SET NULL,
  status          finding_status NOT NULL DEFAULT 'new',
  -- Repo-relative path, and the lines when the agent gave them.
  file            text NOT NULL,
  line_start      int,
  line_end        int,
  title           text NOT NULL,
  problem         text NOT NULL DEFAULT '',
  proposed_fix    text NOT NULL DEFAULT '',
  -- The commit the agent was on, so whoever fixes it can see what changed since.
  commit_sha      text,
  -- Normalized remote key of the repository it was found in.
  remote          text,
  context         jsonb NOT NULL DEFAULT '{}',
  -- Ask me later: don't bring it up before this day.
  remind_after    date,
  -- The commit or PR that solved it.
  solved_ref      text,
  created_by      uuid REFERENCES actors(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  status_by       uuid REFERENCES actors(id) ON DELETE SET NULL,
  status_at       timestamptz,
  status_note     text NOT NULL DEFAULT '',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  search          tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || problem)) STORED
);
CREATE INDEX findings_project_idx ON findings (project_id, status, updated_at DESC);
CREATE INDEX findings_file_idx ON findings (project_id, file);
CREATE INDEX findings_org_idx ON findings (group_id, organization_id, status);
CREATE INDEX findings_search_idx ON findings USING gin(search);

ALTER TABLE findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings FORCE ROW LEVEL SECURITY;
CREATE POLICY group_isolation ON findings USING (openpurpose_bypass() OR group_id = openpurpose_group())
  WITH CHECK (openpurpose_bypass() OR group_id = openpurpose_group());
