-- What agents request over MCP, so people can see which rules are used.
--
-- One agent_requests row per tool call by a real agent (agent mode in the UI
-- and people browsing are not counted). section_reads says which sections a
-- read delivered: every section in a get_context, or the one read_section returned.
--
-- Documents can be disabled: they stay in OpenPurpose with their history, but
-- agents no longer get them. Useful for rules nobody requests any more.

CREATE TABLE agent_requests (
  id              bigserial PRIMARY KEY,
  group_id        uuid NOT NULL DEFAULT openpurpose_group() REFERENCES groups(id) ON DELETE CASCADE,
  -- The agent's own organization.
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id        uuid REFERENCES actors(id) ON DELETE SET NULL,
  tool            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('read', 'write')),
  -- The project the call was about, when one was resolved.
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  -- The document a write changed or proposed to change.
  document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_requests_org_idx ON agent_requests (organization_id, created_at DESC);
CREATE INDEX agent_requests_group_idx ON agent_requests (group_id, created_at);

CREATE TABLE section_reads (
  request_id  bigint NOT NULL REFERENCES agent_requests(id) ON DELETE CASCADE,
  group_id    uuid NOT NULL DEFAULT openpurpose_group() REFERENCES groups(id) ON DELETE CASCADE,
  section_id  uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, section_id)
);
CREATE INDEX section_reads_section_idx ON section_reads (section_id, created_at DESC);
CREATE INDEX section_reads_document_idx ON section_reads (document_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_requests', 'section_reads']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY group_isolation ON %I USING (openpurpose_bypass() OR group_id = openpurpose_group())
                    WITH CHECK (openpurpose_bypass() OR group_id = openpurpose_group())', t);
  END LOOP;
END $$;

ALTER TABLE documents
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_by uuid REFERENCES actors(id) ON DELETE SET NULL;
