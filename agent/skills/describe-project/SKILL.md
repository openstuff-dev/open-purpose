---
name: describe-project
description: Map a repository into OpenPurpose, with a scope and its first rules for each part of the code that has rules of its own, and organization scopes for stacks several projects share. Use when someone asks to populate, describe, document or set up a project in OpenPurpose, or to add scopes.
---

# Describe the project

The goal: an agent working anywhere in this repository gets the rules for that part of the code, and rules that several projects share live once, at the organization. A scope without rules changes nothing, so every scope you suggest comes with its first rules.

Work from the code. Ask the person only what the code can't tell you. Show your plan before you write anything.

## 1. See what is there

Call `get_context` with `remote_url`, `project` from `.openpurpose.json` if it exists, `path: "."`, the root manifest (its path and dependency names) and `task: "describe the project"`. Note what is empty or thin: the project purpose, the guidelines, a glossary.

Call `list_scopes` with the project. Note the scopes that exist, `stacks_in_organization` and `next`.

If no project is found, follow the server's instructions to register the repository first.

## 2. Map the code

Find the parts of the repository with rules of their own. Good candidates:

- every folder with its own manifest (`package.json`, `*.csproj`, `go.mod`, `pyproject.toml`, ...),
- `apps/*`, `packages/*`, `services/*`, `site/`, `infra/`, `docs/`,
- tests, migrations, generated code.

For each part, call `get_context` with its path and manifest to get its stacks. Then read what makes it different: its lint, build and test config, its README, and two or three typical files. A rule belongs to a part when it holds there and not elsewhere ("pages are MDX", "migrations are never edited once merged", "components take signals as inputs").

Rules that hold across the whole repository go in the project's Guidelines instead. Skip parts with nothing of their own, and say that you did.

## 3. Show the plan

Show one short table: scope name, paths or stacks, and the headings of its two to five first rules. Below it, list what goes at the project level: the purpose if it is empty, repository-wide guidelines, glossary terms, business logic.

Ask: "Anything wrong or missing?" Wait for the answer.

## 4. Write it

- **Each scope**: one `create_scope` call with `paths` and/or `stacks`, a `description` (what this part is, and which rules belong here and not elsewhere) and its rules as `sections`. One rule per section: the heading states the rule in one line, the body says what to do and why, with a short example from the code. When the project has several repositories and the paths could match in another one, pass `this_repository_only: true`.
- **The project**: fill an empty purpose with `update_section` or `add_section`, add repository-wide rules to the project's Guidelines with `add_section`, and propose a missing glossary or business logic with `propose_document`.
- Link projects and domain terms with `[[...]]`.

Write only rules you saw in the code or heard from the person. Don't invent best practices.

## 5. Look across the organization

Some of the rules you found are not about this project but about how the organization builds a kind of code ("Angular apps use signals", ".NET services log with Serilog").

1. Call `list_scopes` again. `stacks_in_organization` shows which projects use each stack and which scopes cover it. `next` names the shared stacks no scope covers.
2. For such a stack, read two of the other projects with `get_context(project="<org>/<slug>", path=".")`. The rules they share with this project belong to the organization: suggest them with `create_scope`, `level: "organization"`, the stack in `stacks` and those rules as `sections`. Rules only this project follows stay in its own scope.
3. When only this project has reported the stack so far, ask the person: "These look like how you build every Angular app here, not just this one. Should they apply to the whole organization?" Other projects report their stacks when their agents call `get_context`.

## 6. Check and wrap up

Call `get_context` for one file in each new scope, with its manifest. Check that the scope applies (or, for a proposal, that it is waiting in the Inbox).

Tell the person in a few lines what was created right away, what waits for approval in the **Inbox**, and which parts you skipped and why.

Done when every part with rules of its own has a scope with its first rules, created or proposed, and the person knows where to approve them.
