-- Archiving and moving sections.
--
-- An archived section stays in its document, with its history, but agents no longer get it: it is
-- left out of get_context, search and links until a person restores it. Only archived sections can
-- be deleted for good.
--
-- archive_section and move_section proposals point at the section (section_id) and its document
-- (document_id); heading and body hold a copy of the section for review. A move also names the
-- document it goes to (target_document_id) and, optionally, its position there.

ALTER TYPE proposal_kind ADD VALUE 'archive_section';
ALTER TYPE proposal_kind ADD VALUE 'move_section';

ALTER TABLE sections
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by uuid REFERENCES actors(id) ON DELETE SET NULL;

ALTER TABLE proposals
  ADD COLUMN target_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN target_position int;
