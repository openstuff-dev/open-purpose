# OpenPurpose

Shared, scoped context for people and coding agents.

OpenPurpose holds purpose, business logic, glossary, engineering guidelines and
learnings, in layers. An agent always gets the general rules first and the most
specific ones last:

| Level | Applies to | Example |
|---|---|---|
| Group | every organization in a company group (only once there are several) | "Never log personal data" |
| Organization | every project in one company or division | "Amounts are integer øre, never floats" |
| Project | every repo and folder of one product | "The portal owns no business data" |
| Scope | one part of a project: some of its repositories, some folders, or both; or one kind of code across an organization or the group | "Every user action in the frontend must be undoable" (only the Angular repo, or only `frontend/**`) |

Agents read it over **MCP**; people curate it in an **Angular web UI**. When a
developer corrects an agent, the agent proposes a learning. It is filed under the
most specific scope that matches the code it was working on, and a person approves
it before any other agent sees it. A frontend rule never reaches backend code.

## Groups and organizations

One server hosts any number of **groups** (tenants), for example one per company
or client. Each group is isolated in the database with Postgres row-level
security: every request runs in a transaction that can only see its own group's
rows, so even a query that forgets its `WHERE` clause can't leak another group's
data.

Inside a group, **organizations** (say GitHub and Azure inside Microsoft) are
private to their members by default:

- A **group admin** creates organizations, decides which organizations may read
  which others, and manages everyone in the group.
- People with a **role in the group** read every organization; group editors edit
  group-wide rules and can promote any organization's learning to the whole group.
- People with a **role in an organization** (admin, editor, viewer) work there only.
  One person can have different roles in different organizations.
- **Agents** belong to exactly one organization. They read the group, their
  organization and organizations shared with it, and write only to their own
  organization and to group-wide content (subject to edit modes).
- **Links across organizations** use `[[org/project]]`, e.g. `[[payments/payment-gateway]]`.
  Someone who can't read the target sees its name only, never its content.
- **Glossaries layer.** `[[Customer]]` resolves to the project's glossary first,
  then the organization's, then the group's, so an organization can redefine a
  group-wide term.
- **Server admins** create groups, and can switch between them.

A small company simply has one organization. Its group stays out of sight (no
group page, menu or layer in the agent's context) until a group admin adds a
second organization under Settings › Organizations.

## What else is in it

- **Project identity from the git remote.** All Azure DevOps URL forms (HTTPS,
  SSH, `visualstudio.com`) map to the same key, `azure:{org}/{project}/{repo}`.
  A `.openpurpose.json` with `{"project": "org/slug"}` overrides it. Unknown
  repos make the agent ask the user and register the repo. One project can span
  many repos, and the same repo can belong to projects in different groups.
- **Scopes** match by repository, by path glob (`frontend/**`) or by stack tag
  (`angular`, `dotnet`). A project scope bound to repositories (say "Angular" for
  the web repo and ".NET" for the API repo) only applies inside them; its paths and
  stacks, if any, narrow it further. Unbound scopes work across a monorepo's folders. Tags are detected server-side from the manifest the agent sends
  (`package.json`, `*.csproj`, ...), so every agent tags code the same way.
- **Per-section edit modes.** Each section is **locked** (agents read only),
  **propose** (agent edits become proposals) or **open** (agents edit directly).
  Documents have a mode too, which decides whether agents may add sections.
- **Inbox**: every learning and proposed change in one sortable, filterable table.
  Opening a row shows who proposed it (person or agent), where it applies
  (organization › project › scope), the document and section, the file and
  repository the agent was in, the agent's account of what happened, and a diff.
  Reviewers can re-file a learning anywhere they have edit rights, edit it first,
  approve or reject, and move on with ↑/↓. Each change has its own link.
- **Reviews like a pull request.** Click a line number (shift-click for a range) to
  comment on those lines, optionally with a suggested replacement the author applies
  with one click. Reply, resolve, start a general thread, **request changes**, and
  compare any two revisions. The inbox shows whose move it is ("Waiting on author").
  Agents see the feedback at the top of `get_context`, read it with `get_review`
  (numbered lines), reply, apply suggestions and push a new revision, which hands
  the change back to the reviewers. Threads follow their lines across revisions and
  are marked outdated when the lines are gone.
- **Full history** per section, with author (person or agent), note and one-click restore.
- **Map** of projects and terms, clustered and coloured by organization, with a
  focus mode ("everything within two steps of Order Service"). Agents get the
  same graph: `get_context` lists related projects, and `get_related` returns
  their purpose.
- **Findings.** When an agent notices a real problem outside its task, it doesn't fix
  it and doesn't let it get lost: `report_finding` files the file, a one-line title, what's
  wrong and how to fix it under the most specific matching scope. If open findings look
  like the same problem, nothing is filed until the agent says it checked. On the
  **Findings** page people mark each one **To do**, **Ask me later** (optionally from a
  date) or **Dismissed**. `get_context` lists to-do and ask-me-later findings around the
  path an agent works in, so it doesn't report them again and asks before fixing one; ask
  an agent "anything you could fix here?" and it calls `list_findings`. An agent that fixes
  one calls `resolve_finding` with the commit or PR, and it's hidden until you turn on
  **Solved**. An agent that got a detail of its own finding wrong (the commit, file or
  wording) corrects it with `update_finding` while it's still open. Findings stay out of the team's issue tracker; **Copy as issue** gives you
  Markdown for the rare one that belongs there.
- **API specs per project.** Attach a project's `swagger.json` / `openapi.yaml`
  (OpenAPI 3 or Swagger 2, JSON or YAML) from a link or as a file. Linked specs are
  fetched again in the background when agents read them and they're over an hour old.
  `get_context` lists the APIs of the project and of the projects it links to, and
  `get_api` returns the endpoints one line each, or one endpoint with its parameters,
  responses and every DTO it uses as TypeScript-like interfaces. The project's API
  tab shows exactly that text, endpoint by endpoint.
- **Project pages** split into tabs: Documents, Scopes, API, What agents see,
  Connections, Repositories and Settings, under a strip that shows where the
  project sits (group › organization › project › scopes).
- **Agent mode**, a switch in the top bar: the UI is replaced by a console that
  shows only what an agent in the chosen organization gets back from OpenPurpose.
  You ask like an agent would: `get_context` for a project or git remote, a path
  and stacks, then `get_related`, `get_api`, `read_section`, `search` and the list
  tools. Follow-up calls the output points to are one click away. Each answer is
  the real MCP tool's output, word for word. The server runs the tool as that
  agent, offers only read tools, and only lets a person look through an agent's
  eyes if they can already read everything that agent can.
- **Context budget.** Big rule sets don't flood an agent. When `get_context` would be
  larger than the budget (estimated as characters / 4), the most general sections are
  cut to their heading and first sentence: group first, then organization, project and
  scopes, with learnings and reference before purpose. Each shortened section says how
  much is left and which `read_section` call returns it, so the most specific rules
  always arrive in full. A group admin sets the budget for the whole group; while there
  is only one organization, its admin sets it there. Budgets are opt-in: until one is
  set, every matching section is sent in full.
- **What agents see** on every project: the exact merged context an agent gets
  for each part of the code, layer by layer. **Settings → Test a repository**
  does the same for any git remote, including ones OpenPurpose doesn't know yet.
- Personal and per-agent **tokens** with revocation, and Postgres full-text search.
- **Settings** for your account and personal tokens, light/dark theme, agent setup
  instructions, organizations, read access and context budgets, people and agents, export and import,
  and (for server admins) all groups.
- **Search** is ⌘K / Ctrl+K, anywhere: jump to a page or project, or search rules, terms and
  learnings. What belongs to the project (or organization) on screen comes first; Tab narrows the
  search to just that project or organization.

## Run it

```bash
cp .env.example .env        # set POSTGRES_PASSWORD and OPENPURPOSE_ORG_NAME
docker compose up -d --build
docker compose logs openpurpose | grep "Admin token"
```

Open http://localhost:8080 and sign in with the admin token. Then go to
**Settings → People and agents** and create a token for each person and each agent.

To try it with example data (a group with two organizations, nine linked
services, learnings and pending proposals). This wipes the database:

```bash
docker compose exec openpurpose node dist/seed-demo.js --reset
```

### Upgrading from v0.1

Just start the new version. The migration moves everything into one group with
one organization (both named after your old organization), turns v0.1 admins
into group admins and server admins, and keeps editors, viewers and agents in
that organization.

### Backup, export and import

**Settings → Export and import** downloads the whole group or one organization as
one JSON file: every document and section, projects, repositories, scopes, API specs
and, if you choose, section history, proposals with their reviews, and the names and
roles of people and agents, and findings. Tokens are never exported. A group export is a complete
backup. The Markdown (.zip) format adds a readable `.md` file per document next to
the same JSON (`manifest.json`).

Importing shows a preview first, and then runs in one transaction. Each organization
in the file can be added as a new organization, merged into one that is already here,
or left out. A merge matches projects and scopes by slug (old slugs too), documents by
slug and sections by heading. New content is added. For changed sections you choose
whether they become proposals in the inbox (the default), are updated right away, or
stay as they are. Nothing is deleted unless you tick "Remove what's not in the file".
Server admins can also restore a file as a new group, with its group-wide content.
Imported people arrive disabled and without tokens.

For scheduled backups, run the export on the server:

```bash
docker compose exec openpurpose node dist/export-cli.js --group my-group --out /tmp/backup.json
# Options: --organization <slug>, --zip, --people, --no-history, --no-proposals, --no-api-specs, --no-findings
```

Without Docker, use `npm run -s export -w apps/server -- --group my-group --out backup.json`.
For a backup of the whole server, every group at once, use `pg_dump`.

### Without Docker

Requires Node 22.22+ (or 24.15+) and Postgres 14+. The repository is one npm
workspace, so a single install at the root covers the server, the web app and
the shared types:

```bash
npm ci
npx nx build web
DATABASE_URL=postgres://user:pass@localhost:5432/openpurpose npx nx dev server
```

The server serves the built UI from `apps/web/dist/web/browser`, the API under
`/api` and MCP at `/mcp`.

If the database user is a superuser (the Docker default), OpenPurpose creates a
`openpurpose_app` role and switches to it on every connection, because superusers
ignore row-level security. With a non-superuser owner, row-level security is
forced on the owner instead. Either way works without configuration.

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | `postgres://openpurpose:openpurpose@localhost:5432/openpurpose` | |
| `PORT` | `8080` | |
| `OPENPURPOSE_ORG_NAME` | `Our company` | first organization, created on first boot only |
| `OPENPURPOSE_GROUP_NAME` | the organization's name | the group around it; only shown once it has a second organization |
| `OPENPURPOSE_PUBLIC_URL` | `http://localhost:PORT` | shown in MCP setup snippets |
| `OPENPURPOSE_BOOTSTRAP_TOKEN` | random | first admin's token; otherwise printed once in the log |
| `OPENPURPOSE_API_FETCH` | `on` | `off` stops the server from fetching API spec URLs (uploads still work) |
| `OPENPURPOSE_API_REFRESH_MINUTES` | `60` | re-fetch linked API specs older than this when agents read them; `0` = only on demand |
| `OPENPURPOSE_API_MAX_MB` | `20` | largest API spec accepted |
| `OPENPURPOSE_IMPORT_MAX_MB` | `100` | largest export file accepted by an import |

Migrations run automatically on start.

Linked API specs are fetched by the server, so it must be able to reach those URLs.
Only editors can add a link, and only http(s) URLs without credentials are accepted;
if the server sits next to things editors shouldn't be able to probe, set
`OPENPURPOSE_API_FETCH=off` and upload spec files instead.

## Connect an agent

Create an agent in its organization under **Settings → People and agents**. The
UI shows the setup command (also under **Settings → Connect an agent**), e.g. for Claude Code:

```bash
claude mcp add --transport http openpurpose https://openpurpose.example.com/mcp \
  --header "Authorization: Bearer chr_..."
```

The token decides the group and organization, so there is nothing else to
configure. Any MCP client that supports streamable HTTP works (Cursor, VS Code,
Codex, ...). Personal tokens work over MCP too; if the person belongs to several
organizations, add `--header "X-OpenPurpose-Org: <org-slug>"` (and `X-OpenPurpose-Group`
if they belong to several groups).

The server sends its workflow as MCP instructions, but agents follow it more
reliably when the repo says so too: copy [`agent/AGENTS.snippet.md`](agent/AGENTS.snippet.md)
into your repo's `AGENTS.md` or `CLAUDE.md`.

### MCP tools

| Tool | What it does |
|---|---|
| `get_context` | The rules for a repo + path + manifest, from group to scope, with section ids and modes |
| `propose_learning` | File a correction as a learning under the most specific matching scope (or `level`: project, organization, group) |
| `create_scope` | Suggest a scope for a part of the project (paths, stacks, one repository) or a kind of code across the organization; a person approves it, editors' tokens create it right away |
| `resolve_project`, `register_repository`, `create_project` | Find or register the project for a repo |
| `get_related` | Projects and terms linked to/from a project, with their purpose where readable |
| `search`, `read_section` | Full-text search, read one section with its version |
| `update_section`, `add_section` | Change content, subject to the section's or document's mode |
| `list_projects`, `list_scopes`, `list_organizations` | Discovery |
| `get_api` | Endpoints and DTOs from a project's OpenAPI/Swagger spec: all endpoints, one endpoint in detail, or one DTO |
| `list_my_proposals`, `get_review` | The agent's own proposals and the review feedback on one, with numbered lines |
| `reply_to_review`, `apply_suggestion`, `revise_proposal` | Answer a thread (and resolve it), accept a reviewer's suggestion, push a new revision |
| `report_finding`, `list_findings`, `update_finding`, `resolve_finding` | Record a problem found outside the task, list findings with their proposed fix, correct one you reported while it's open, mark one solved |

## Layout

```
apps/server/          Fastify + TypeScript 7 + pg. REST API, MCP endpoint, migrations, tests
apps/web/             Angular 22 + TypeScript 6 (standalone components, signals)
packages/contracts/   Types the server sends and the web reads, defined once (declarations only)
agent/                Instruction snippet and .openpurpose.json example for repos
```

The repository is an Nx workspace. The projects are `server`, `web` and `contracts`:
`npx nx build web`, `npx nx run-many -t typecheck`, `npx nx affected -t test`. The old
`npm run build`, `npm test`, `npm run typecheck` and `npm run lint` still work and run the
same targets for every project.

The colours, spacing and fonts come from `@openstuff-dev/tokens`, generated from the
`primaryColor` in `apps/web/tokens.config.json` (`npx nx tokens web`, run before every build).
Lint uses `@openstuff-dev/lint` and reports warnings only for now.

Run the tests with a Postgres available at `TEST_DATABASE_URL`
(default `postgres://openpurpose:openpurpose@localhost:5432/openpurpose_test`; the test
wipes that database). They cover group isolation at the database level and the
upgrade from v0.1:

```bash
npm test
```

`npm run typecheck` checks the shared types, the server and the web app. `npm run lint` runs
ESLint and Stylelint.

## Not in this version

- Sign-in through Entra ID / OIDC (tokens only for now)
- Notifications when something lands in the inbox
- Importing edited Markdown (exports include a Markdown copy, but imports read only its `manifest.json`)
- Tracking which tasks agents are working on right now, and sending findings to issue trackers