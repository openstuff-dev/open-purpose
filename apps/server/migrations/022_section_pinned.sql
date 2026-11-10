-- Pinned sections reach agents in full, always.
--
-- get_context sends background (purpose, glossary, organization-wide guidelines, ...) as its first
-- sentence. An editor pins the few sections that must never be skipped, such as "never edit
-- generated files": those go in full whatever the task, and the size budget doesn't shorten them.

ALTER TABLE sections ADD COLUMN pinned boolean NOT NULL DEFAULT false;
