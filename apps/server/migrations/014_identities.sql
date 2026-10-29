-- Sign-in through an external provider (Supabase, later others) and self sign-up.
--
-- identities links a provider's account (provider + its user id, the subject) to an actor.
-- One actor can have several, e.g. GitHub and a magic link.
--
-- actors.signup is NULL for people an admin added. People who sign up themselves start as
-- 'pending' (OPENPURPOSE_SIGNUP=approval) until a server admin approves them, which gives them
-- their own workspace, or rejects them. Like actors, both are global (no row-level security).

CREATE TYPE signup_status AS ENUM ('pending', 'approved', 'rejected');

ALTER TABLE actors
  ADD COLUMN email     text,
  ADD COLUMN signup    signup_status,
  ADD COLUMN signup_at timestamptz;

CREATE INDEX actors_signup_idx ON actors (signup, signup_at) WHERE signup IS NOT NULL;

CREATE TABLE identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id        uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  subject         text NOT NULL,
  email           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz,
  UNIQUE (provider, subject)
);
CREATE INDEX identities_actor_idx ON identities (actor_id);
