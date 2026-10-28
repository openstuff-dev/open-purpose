-- A group with one organization is just that organization: its group layer is
-- hidden, and group documents are only created once a second organization
-- joins. Remove the placeholders earlier versions created, as long as nobody
-- has written in them or proposed anything for them.

DELETE FROM documents d
 WHERE d.organization_id IS NULL AND d.project_id IS NULL AND d.scope_id IS NULL
   AND d.slug IN ('purpose', 'guidelines')
   AND (SELECT count(*) FROM organizations o WHERE o.group_id = d.group_id) <= 1
   AND NOT EXISTS (
     SELECT 1 FROM sections s WHERE s.document_id = d.id
        AND NOT (s.version = 1 AND s.body = '_Rules every organization in the group follows: security, legal, privacy, brand._'))
   AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.document_id = d.id);
