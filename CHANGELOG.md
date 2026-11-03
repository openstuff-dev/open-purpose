# Changelog

Each release is a Docker image at `ghcr.io/openstuff-dev/open-purpose:<version>`.
Migrations run when the new version starts and only move forward, so back up first.

## 0.4.2

No migrations.

### Web app

- On the map, every link to or from a term is now faint and dashed with a smaller arrow, not
  only links between two terms. Solid lines are left for links between projects.
- Organizations on the map are rings in their colour, so they no longer look like their
  projects. The legend shows which is which.

## 0.4.1

Adds migration `019_invites.sql`.

**Upgrading (Supabase sign-in):** add `**` to the end of the redirect URL in Supabase, so
`<OPENPURPOSE_PUBLIC_URL>/api/auth/callback**`. Without it, the links sent to people an admin
adds by email are refused. Leave **Allow new users to sign up** on in Supabase, even with
`OPENPURPOSE_SIGNUP=off`, so Supabase can send someone their first link.

### People

- Admins can add people by email under **Settings → People and agents**: pick **Person**, fill
  in their email, and they get a role at once and a sign-in link by email. Someone who already
  has an account just gets the new role.
- A verified email now links a new sign-in to the person who already has it, so signing in with
  the link, another link or GitHub lands in the same account instead of creating a second one.
- The invite email can say who added someone, where and with which role: the server sets
  `invited_by`, `invited_to` and `invited_role` on the new Supabase user for the **Confirm
  signup** template. The README has an example, and the setup wizard's emails fit people an
  admin added.

### Web app

- Pages you visited in the last minute open from memory without asking the server again.
  After that, they show what was loaded before at once and reload it behind the scenes, and
  coming back to the tab after a while does the same. Findings, the Inbox, the Overview's
  activity, People, your tokens and the workspace list are now kept too. Any change you make
  still reloads everything.
- The Inbox and Findings badges refresh at most once a minute instead of every 30 seconds.
- On the map, links between terms are faint and dashed with a smaller arrow, so a large
  glossary no longer hides everything else. They still light up when you select a term.

## 0.4.0

Adds migrations `017_document_proposals.sql` and `018_section_archive_move.sql`. Agents need to
reconnect to see the new tools.

**Upgrading:** the server no longer fetches API specs from private network addresses
(localhost, `10.x`, `192.168.x`, cloud metadata, Docker service names), checked again on every
redirect. If your specs live on your own network, list those hosts in
`OPENPURPOSE_API_FETCH_ALLOW` (`specs.internal,192.168.1.20,10.0.0.0/8`).

### Agents

- Added `archive_section` and `move_section`. They follow the edit modes like `update_section`:
  an open section changes right away, a propose section becomes an **Archive** or **Move**
  proposal in the Inbox, and a locked one is refused. Sections move only within one
  organization and keep their id, history, review threads and open proposals. Archived
  sections stay in their document but are left out of `get_context`, search and links.
- Added `propose_document`, so an agent can suggest a missing document with its first sections
  for a person to approve. `get_context` shows each document's `[d:…]` id and lists empty
  documents, so agents can add sections to them.
- Added `dismiss_finding`: an agent dismisses a finding that isn't a real problem once you
  agree, with a reason that people see and can reopen it from.
- `get_context` lists the known findings on files without an extension, like a `Dockerfile`.
- Agents can no longer manage their own account: they can't issue themselves tokens, rename
  themselves or change their own review and findings permissions. Only admins of the agent's
  organization can.

### Web app

- On the document page, **Archive** replaces Delete, and **Move to…** moves a section to
  another document. Archived sections are listed at the bottom with **Restore** and **Delete
  for good**; only archived sections can be deleted.
- The finding drawer has a **Fixed in** field for the commit or pull request that solved it.
- Pages you visited before show at once and reload behind the scenes. A project page opens
  with one request instead of three, and the Inbox shows its table without first fetching
  scopes for every learning.
- The map lays itself out once when resizing stops, and the site's header no longer jumps
  while the stylesheet loads.

### Server

- Every API request costs one database round trip instead of four, and the project, document,
  review and activity pages each load in one or two. `get_context` and `get_related` no longer
  build the whole workspace graph.
- Answers over 1 KB are compressed with brotli or gzip and carry weak ETags, so a repeated GET
  gets 304. MCP is never compressed.
- The sign-in rate limiter counts IPv6 addresses per /64 and keeps at most 50,000 keys.
- The server warns at startup when `OPENPURPOSE_TRUST_PROXY` is `true`; list the proxy's own
  addresses instead.
- Two people signing up with the same name at the same moment both get a workspace.
- Importing the same export twice no longer adds every finding again, and findings filed under
  an organization scope import.

## 0.3.11

- Added websites to every project and organization: links such as Staging, Production or an
  internal dashboard, each with a label of your own. They show under the page header with a link
  icon and the label as a badge. Editors add them in place; **Edit** and **Remove** show when you
  hover over or tab to a row. Only `http://` and `https://` addresses are accepted, up to 20 each.
- `get_context` lists the organization's and the project's websites under **Websites**, so agents
  know where the code runs. Exports include them; older export files import with none.

## 0.3.10

- The line under the Inbox and Findings drawers' header lines up with the topbar's line again.
  The header is now exactly as tall as the topbar instead of taking its height from its buttons.

## 0.3.9

- The browser tab shows the OpenPurpose icon again. The server sent the favicons as cacheable
  for a year, so browsers kept the old icon even after a hard reload. Files without a content
  hash in their name (`index.html`, the favicons) are now checked on every load, and the icon
  links changed so browsers fetch the new one.
- The sidebar, logo row, topbar and narrow-window menu now come from the shared OpenStuff
  toolkit (`.os-shell` in `@openstuff-dev/ui` 0.1.3). They look the same as in 0.3.8.

## 0.3.8

- The topbar's bottom line now runs on under the logo in the sidebar, so the logo sits in the
  bar instead of floating above the menu.
- On the overview, the agent activity period and chart switchers sit at the end of their row,
  and an empty list of organization-wide scopes or documents keeps a gap above its add button.
- The scope page looks like the rest of the app: **Edit** in the header, the matching rules in a
  panel, the documents with a description, the slug under Details and **Delete scope** in its
  own danger zone.

## 0.3.7

- The web app has the new OpenStuff logo: a ring with a triangle. It replaces the old document
  mark in the sidebar, the agent bar and the sign-in screens, and in the browser tab icon.

## 0.3.6

- Agents can now fetch guides from the server: `list_skills` shows each skill's name and
  description, and `get_skill` returns one in full. The server's instructions point agents at
  them, so "set up OpenPurpose in this repository" works without installing anything. Both are
  read tools, so agent mode shows them too. The image ships the skills; `OPENPURPOSE_SKILLS_DIR`
  overrides where the server reads them from.
- Renamed the `openpurpose-start` skill to `init-openpurpose`. Settings › Connect an agent and the
  README now say to ask your agent instead of copying a `curl` command, which would have shadowed
  Claude Code's own `/init`.
- Added the `describe-organization` skill: it interviews you about what your organization does
  (and reads your website if you give it a link), then hands you an Organization purpose text to
  paste into OpenPurpose.

## 0.3.5

- Added the `openpurpose-start` skill for a guided first run in your own repository: it
  connects the repository to a project, shows what an agent sees there and turns one rule you
  keep repeating into your first learning. Settings › Connect an agent and the README show how
  to install it.
- Organization dots in the map legend, project rows, findings, the inbox and people chips are
  round again; the activity grid's square cells were overriding them.
- `get_review`, `reply_to_review` and `revise_proposal` accept the 8-character proposal id that
  `add_section`, `update_section` and `propose_learning` answer with. An unknown id now answers
  "Proposal not found" instead of a database error.
- The README says which Node version you need (22.22.3+ or 24.15+), the repository pins Node 24
  in `.nvmrc`, and npm warns on older versions. The README also says that lint problems fail CI.

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
