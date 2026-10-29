-- Agent permissions: admins decide, per agent, how much review its writes get.
--
-- review: edit_modes (default) follows each section's edit mode; always_propose
-- turns edits to open sections into proposals too; auto_approve approves the
-- agent's proposals in its own organization as soon as they arrive.
-- accept_findings files the agent's findings as to do instead of new.
-- permissions_by and permissions_at say who last changed them.
--
-- proposals.auto_approved marks what nobody reviewed, so people can find it later.

CREATE TYPE agent_review AS ENUM ('edit_modes', 'always_propose', 'auto_approve');

ALTER TABLE actors
  ADD COLUMN review          agent_review NOT NULL DEFAULT 'edit_modes',
  ADD COLUMN accept_findings boolean NOT NULL DEFAULT false,
  ADD COLUMN permissions_by  uuid REFERENCES actors(id) ON DELETE SET NULL,
  ADD COLUMN permissions_at  timestamptz;

ALTER TABLE proposals ADD COLUMN auto_approved boolean NOT NULL DEFAULT false;
