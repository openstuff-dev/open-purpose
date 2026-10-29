# Changelog

Each release is a Docker image at `ghcr.io/openstuff-dev/open-purpose:<version>`.
Migrations run when the new version starts and only move forward, so back up first.

## Unreleased

- Added the `openpurpose-start` skill for a guided first run in your own repository: it
  connects the repository to a project, shows what an agent sees there and turns one rule you
  keep repeating into your first learning. Settings › Connect an agent and the README show how
  to install it.

## 0.3.4

- Pages no longer jump in section by section while they load. The Overview, Projects, Inbox,
  Findings and the project, scope and document pages hold each section's place with placeholder
  rows shaped like the real ones, and the content replaces them in place. On a fast load you
  won't see the placeholders; the space is still kept.

## 0.3.3

- The web app now loads who-am-I (`/api/me`, the heaviest request) only at startup and when you
  change something (switching, settings, import), instead of on every page change. The Inbox
  and Findings badges come from the new, small `GET /api/me/counts`, refreshed at most every
  30 seconds while you move around and right after you decide on a proposal or sort a finding.
  `pending_proposals` and `new_findings` are no longer part of `/api/me`.

## 0.3.2

- Made every request much faster against a remote database such as Supabase: the server keeps
  its database connections open instead of reconnecting after 10 seconds idle, and a request
  now runs in one transaction with 6 round trips instead of three transactions with 16
  (about 130 ms instead of 350 ms at 20 ms per round trip).
- Added loading states to Settings › Export and import: checking a file, updating the preview,
  importing and preparing a download each show that something is happening.

## 0.3.1

- Fixed the first start on Supabase projects with automatic RLS ("new row violates row-level
  security policy for table groups"): tables that got row-level security without a policy now
  get one that lets in only `openpurpose_app`, so Supabase's Data API roles still see nothing.

## 0.3.0

- Added sign-in with GitHub or an email link (Supabase), browser sessions that expire, and
  sign-up behind approval (`OPENPURPOSE_SIGNUP=approval`): server admins approve each person
  under Settings › Server. Access tokens still work as before.
- Added agent permissions: per agent, follow edit modes, always propose, or approve its
  proposals automatically.
- Renamed "group" to "workspace" in everything people read. The workspace page moved to
  `/workspace` and its settings to `/settings/workspace`; the old addresses redirect. The
  database, API, headers and export CLI still say group.
- Made the server drop to `openpurpose_app` when its database user has `BYPASSRLS` (as on
  Supabase), and refuse to start when it can't.
- Added published images: tags `v*` push `:<version>`, `:<major>.<minor>` and `:latest`, and
  every push to master pushes `:edge`.

## 0.2.0

- Workspaces with several organizations, read access between them, scopes bound to
  repositories, context budgets, findings, agent activity, and export and import.
