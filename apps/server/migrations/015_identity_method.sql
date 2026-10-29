-- How someone proved who they are at the provider, e.g. 'github' or 'email' through Supabase.
-- The sign-ups list shows it, because the provider alone ('supabase') says little. NULL when
-- the provider doesn't say.

ALTER TABLE identities ADD COLUMN method text;
