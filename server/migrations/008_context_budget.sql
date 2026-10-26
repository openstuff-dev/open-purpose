-- How large get_context may get for agents, in tokens (estimated as characters
-- / 4). Over it, the most general sections are cut to their first sentence.
-- A group with several organizations sets it for all of them; a group with one
-- organization is just that organization, so the organization's applies.
-- NULL = no limit, the default: budgets are opt-in.
ALTER TABLE groups
  ADD COLUMN context_max_tokens integer
  CHECK (context_max_tokens IS NULL OR context_max_tokens >= 1000);
ALTER TABLE organizations
  ADD COLUMN context_max_tokens integer
  CHECK (context_max_tokens IS NULL OR context_max_tokens >= 1000);
