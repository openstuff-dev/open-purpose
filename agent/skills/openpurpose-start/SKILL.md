---
name: openpurpose-start
description: Guided first run of OpenPurpose in the current repository. Use when someone is new to OpenPurpose, or asks to get started, set it up or try it here.
---

# Get started with OpenPurpose

You are giving someone their first tour of OpenPurpose, in their own repository. The goal: in about five minutes they have the repository connected, have seen the rules an agent gets for it, and have watched one correction become a learning waiting for review. That loop is the point of the product: a correction made once should never have to be made again.

Talk like a guide, not a manual. Before each step, say in one sentence what it does and why. Keep the person's own repository and their own words at the centre; skip anything they already have.

## 1. Check the connection

Call `list_organizations`.

- It works: say which organization the token belongs to. Done.
- The `openpurpose` tools are missing or the call fails with an auth error: the MCP server isn't connected yet. Tell them to open their OpenPurpose server, go to **Settings › Connect an agent**, create an agent token and run the command shown there, e.g. `claude mcp add --transport http openpurpose https://<server>/mcp --header "Authorization: Bearer chr_..."`, then restart the session and run this skill again. Stop here.

## 2. Find the project

Call `get_context` with `remote_url` from `git remote get-url origin`, `project` from `.openpurpose.json` if it exists, `path: "."` and the root manifest (`package.json`, `*.csproj`, `go.mod`, ...) with its content.

- A project is found: name it and move on.
- No project is found: call `list_projects`, show the person the candidates and ask which one this repository belongs to, or whether to create a new one. Then call `register_repository` (existing project) or `create_project` (new one), and write `.openpurpose.json` in the repository root with `{"project": "<slug>"}`. Call `get_context` again.

Done when `get_context` names a project for this repository.

## 3. Tell agents to use it

Look in `AGENTS.md` and `CLAUDE.md` for a section that mentions `get_context`. If neither has one, fetch the snippet from https://raw.githubusercontent.com/openstuff-dev/open-purpose/master/agent/AGENTS.snippet.md, show it, and ask whether to add it to `CLAUDE.md` (or `AGENTS.md` if only that file exists). Explain why: agents follow the server's workflow more reliably when the repository repeats it.

Leave the change uncommitted; the person decides when to commit it.

## 4. Show what an agent sees

Summarize the context from step 2 in a few lines, using the person's own content:

- The layers that applied, general to specific (organization, project, scopes), and that the more specific rule wins.
- Two or three rules that stood out, quoted by heading.
- What is empty or thin, e.g. no project purpose, no glossary, no scopes for a folder that clearly has its own stack.
- Each section's mode: **locked** (agents only read it), **propose** (agent edits become proposals), **open** (agents edit directly).

Point them at the project's **What agents see** tab in the web UI, which shows this same text, and at **Agent mode** in the top bar for exploring as an agent.

## 5. Fill one gap

Pick the most useful gap from step 4. Usually it is the project purpose: draft two or three sentences from the README and the code (what the project does, who uses it, what good looks like) and show the draft. When the person agrees, save it with `update_section` or `add_section`. Say where it went: a direct edit, or a proposal in the **Inbox** if the section or document is in propose mode.

If nothing is missing, skip this step and say so.

## 6. Make the first learning

This is the step that matters most. Ask: "What do you keep telling coding agents in this repo? One rule you're tired of repeating." Offer two examples from what you saw in the code, e.g. a naming convention or a command that must run before committing.

Turn their answer into one rule, stated positively, with the reason, and call `propose_learning` with the same `remote_url`, `path` and `manifests` as in step 2. Tell them:

- where it was filed (organization › project › scope),
- that it waits in the **Inbox** until a person approves it, reviewed like a pull request,
- that from then on every agent working in this code gets it from `get_context`, and the correction never has to be made again.

Done when `propose_learning` has returned and you have told them where to approve it.

## 7. Wrap up

In three short lines, list what is now set up. Then suggest what to try next, picking the two that fit what you saw:

- Approve the learning in the **Inbox**, then ask an agent for a task in this repo and watch it follow the rule.
- Add a scope for a part of the code with its own rules (`frontend/**`, or the `angular` stack).
- Link related projects with `[[project-name]]` so agents learn about the services this one talks to.
- Attach the project's OpenAPI spec on its **API** tab, so agents call endpoints with exact shapes.
- Ask "anything you could fix here?" to see the findings agents have reported.
