-- Reviews, like a pull request: line comments, suggestions, "request changes",
-- replies from the author (person or agent) and new revisions of the proposal.

ALTER TYPE proposal_status ADD VALUE IF NOT EXISTS 'changes_requested';

ALTER TABLE proposals
  ADD COLUMN revision   int NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE proposals SET updated_at = COALESCE(reviewed_at, created_at);

-- Every version of a proposal's text. Revision 1 is what was first proposed.
CREATE TABLE proposal_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL DEFAULT openpurpose_group() REFERENCES groups(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  revision    int NOT NULL,
  heading     text NOT NULL DEFAULT '',
  body        text NOT NULL,
  note        text NOT NULL DEFAULT '',
  actor_id    uuid REFERENCES actors(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, revision)
);
INSERT INTO proposal_revisions (group_id, proposal_id, revision, heading, body, actor_id, created_at)
SELECT group_id, id, 1, heading, body, created_by, created_at FROM proposals;

-- What happened, in order: the timeline of a review.
CREATE TYPE review_event_kind AS ENUM ('proposed', 'revised', 'changes_requested', 'approved', 'rejected', 'commented');
CREATE TABLE proposal_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL DEFAULT openpurpose_group() REFERENCES groups(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  kind        review_event_kind NOT NULL,
  revision    int NOT NULL DEFAULT 1,
  note        text NOT NULL DEFAULT '',
  actor_id    uuid REFERENCES actors(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposal_events_idx ON proposal_events (proposal_id, created_at);
INSERT INTO proposal_events (group_id, proposal_id, kind, actor_id, created_at)
SELECT group_id, id, 'proposed', created_by, created_at FROM proposals;
INSERT INTO proposal_events (group_id, proposal_id, kind, note, actor_id, created_at)
SELECT group_id, id, status::text::review_event_kind, review_note, reviewed_by, reviewed_at
  FROM proposals WHERE status IN ('approved', 'rejected');

-- A conversation, either about specific lines of a revision or about the whole proposal.
CREATE TABLE review_threads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL DEFAULT openpurpose_group() REFERENCES groups(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  revision    int NOT NULL,
  line_start  int,
  line_end    int,
  -- The commented lines as they were, so the thread still makes sense after the text changes.
  anchor      text NOT NULL DEFAULT '',
  resolved_at timestamptz,
  resolved_by uuid REFERENCES actors(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES actors(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((line_start IS NULL) = (line_end IS NULL)),
  CHECK (line_start IS NULL OR (line_start >= 1 AND line_end >= line_start))
);
CREATE INDEX review_threads_idx ON review_threads (proposal_id, created_at);

CREATE TABLE review_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL DEFAULT openpurpose_group() REFERENCES groups(id) ON DELETE CASCADE,
  thread_id   uuid NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES actors(id) ON DELETE SET NULL,
  body        text NOT NULL DEFAULT '',
  -- Replacement text for the thread's lines, applied with one click.
  suggestion  text,
  applied_at  timestamptz,
  applied_by  uuid REFERENCES actors(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_comments_idx ON review_comments (thread_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['proposal_revisions', 'proposal_events', 'review_threads', 'review_comments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY group_isolation ON %I USING (openpurpose_bypass() OR group_id = openpurpose_group())
                    WITH CHECK (openpurpose_bypass() OR group_id = openpurpose_group())', t);
  END LOOP;
END $$;
