## OpenPurpose (shared rules and learnings)

We keep our purpose, business logic, glossary, guidelines and learnings in
OpenPurpose, available through the `openpurpose` MCP server. Rules come in layers: our
organization, the project and the part of the code you are in (a repository or a folder).

1. Before you start a task, call `get_context` with:
   - `remote_url` from `git remote get-url origin`
   - `project` from `.openpurpose.json` if that file exists
   - `path`: the file or folder you are about to work on
   - `manifests`: the nearest `package.json`, `*.csproj` or similar, with its content
   Follow what it returns. More specific rules override general ones.
2. When you move to a different part of the repo (for example from `frontend/`
   to `backend/`), call `get_context` again with the new path and manifest.
3. If no project is found, ask me which project this repo belongs to, then call
   `register_repository` (or `create_project`) and create `.openpurpose.json`.
4. When I correct you and the correction should apply next time, call
   `propose_learning` with the same remote/path/manifests. Say in one line that
   you did. Do not propose one-off preferences or task-specific details.
5. Never try to change a section marked `locked`.
6. `[[name]]` in OpenPurpose text links to another project or a glossary term, and
   `[[org/name]]` to a project in another organization. Use `get_related` when
   your task touches a linked service.
7. If `get_context` lists "Review feedback waiting on you", read it with
   `get_review` before other work. Answer each thread with `reply_to_review`,
   accept suggestions you agree with via `apply_suggestion`, and push other
   fixes with `revise_proposal`. Tell me in one line what the reviewer asked for.
8. When you call or implement an HTTP endpoint of this or a linked service, use
   `get_api` (listed under "APIs" in `get_context`) for the exact paths,
   parameters and DTOs. Don't guess request or response shapes.
9. When you notice a real problem outside your task, don't fix it: call
   `report_finding` with the file, a one-line title, what's wrong and how you
   would fix it. Say in one line that you did. If `get_context` lists known
   findings, don't report them again, and ask me before fixing one. After fixing
   one, call `resolve_finding` with the commit or PR. If you got a detail of
   your own finding wrong, correct it with `update_finding`.
