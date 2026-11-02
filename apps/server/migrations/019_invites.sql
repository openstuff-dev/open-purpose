-- Adding people by email.
--
-- An admin adds someone by email address, and the provider sends them a magic link. When they
-- sign in, their verified email links the new identity to that person (see actorForIdentity),
-- so this index makes that lookup fast. actors.email isn't unique: older databases can hold
-- the same address twice.
--
-- invite_links keeps the PKCE verifier of such a link. The person opens it in their own
-- browser, which has no verifier cookie; the link's ?invite= id finds the verifier instead.
-- Like auth_codes, it is global (no row-level security).

CREATE INDEX actors_email_idx ON actors (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE invite_links (
  id_hash    text PRIMARY KEY,
  verifier   text NOT NULL,
  expires_at timestamptz NOT NULL
);
