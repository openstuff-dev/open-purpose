-- Document proposals: an agent suggests a new document, with its first sections, and a person
-- creates it by approving the proposal.
--
-- heading holds the document's title and body its sections as markdown, one "## Heading" line
-- per section, so revisions, review threads and suggestions work as for sections.
-- document_spec holds the rest: {"kind": "glossary", "slug": "glossary"}. On approval,
-- document_id points at the document it created.

ALTER TYPE proposal_kind ADD VALUE 'new_document';

ALTER TABLE proposals ADD COLUMN document_spec jsonb;
