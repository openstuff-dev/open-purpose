-- OpenVersion's deploy token, encrypted with the secret key, so the server publishes its own version
-- on start. Never returned by the API and never in an export. The same column every OpenStuff app has.
ALTER TABLE server_integrations ADD COLUMN IF NOT EXISTS deploy_token_encrypted text;
