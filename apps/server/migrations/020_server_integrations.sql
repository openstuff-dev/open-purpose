-- Server-wide connections, set by a server admin. Not workspace-scoped, so no row-level security:
-- only the server-admin routes read or write these. Secrets are encrypted and never returned.
CREATE TABLE server_integrations (
  kind                      text PRIMARY KEY CHECK (kind IN ('openversion', 'openannounce')),
  url                       text NOT NULL,
  public_key                text NOT NULL,
  signing_secret_encrypted  text,
  last_test_ok              boolean,
  last_test_message         text,
  last_tested_at            timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- A generated encryption key, kept here only when OPENPURPOSE_SECRET_KEY isn't set.
CREATE TABLE server_settings (
  name  text PRIMARY KEY,
  value text NOT NULL
);
