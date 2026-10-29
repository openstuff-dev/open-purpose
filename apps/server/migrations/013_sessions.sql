-- Browser sessions: a session is an api_tokens row with kind = 'session' that expires.
-- Token lists leave sessions out; people and agents keep using kind = 'api' tokens.
--
-- auth_codes passes a new session from the sign-in callback to the web app without
-- putting the token in a URL: the callback redirects with a one-time code (60 s),
-- and the app swaps it for the token. Like api_tokens, both are global (no row-level security).

ALTER TABLE api_tokens
  ADD COLUMN kind       text NOT NULL DEFAULT 'api' CHECK (kind IN ('api', 'session')),
  ADD COLUMN expires_at timestamptz;

CREATE TABLE auth_codes (
  code_hash  text PRIMARY KEY,
  actor_id   uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
