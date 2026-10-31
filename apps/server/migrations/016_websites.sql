-- Websites on organizations and projects: labelled URLs such as "Staging" or "Production",
-- shown under the page header and sent to agents in get_context. A JSON array of
-- { label, url } keeps the order people chose; the whole list is replaced on save.
-- Both tables already have row-level security, so no new policy is needed.

ALTER TABLE organizations ADD COLUMN websites jsonb NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN websites jsonb NOT NULL DEFAULT '[]';
