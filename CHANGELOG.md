# Changelog

Each release is a Docker image at `ghcr.io/openstuff-dev/open-purpose:<version>`.
Migrations run when the new version starts and only move forward, so back up first.

## Unreleased

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
