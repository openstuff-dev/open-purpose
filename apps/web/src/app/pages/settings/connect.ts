import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeBlock, SectionHeader } from '@openstuff-dev/ui-angular';
import { Session } from '../../core/session';

const AGENTS_SNIPPET = `## OpenPurpose (shared rules and learnings)

We keep our purpose, business logic, glossary, guidelines and learnings in
OpenPurpose, available through the \`openpurpose\` MCP server. Rules come in layers: our
organization, the project and the part of the code you are in (a repository or a folder).

1. Before you start a task, call \`get_context\` with:
   - \`remote_url\` from \`git remote get-url origin\`
   - \`project\` from \`.openpurpose.json\` if that file exists
   - \`path\`: the file or folder you are about to work on
   - \`manifests\`: the nearest \`package.json\`, \`*.csproj\` or similar: its path and
     dependency names, not the whole file
   Follow what it returns. More specific rules override general ones.
2. When you move to a different part of the repo (for example from \`frontend/\`
   to \`backend/\`), call \`get_context\` again with the new path and manifest. For
   the same path, send the \`stacks\` it returned instead of the manifest.
3. If no project is found, ask me which project this repo belongs to, then call
   \`register_repository\` (or \`create_project\`) and create \`.openpurpose.json\`.
   \`get_context\` shows each document's id as \`[d:…]\`: add sections with
   \`add_section\`. When a document is missing (a new project often has no
   glossary or business logic yet), call \`propose_document\` with its first
   sections and tell me in one line that you proposed it. When a section is
   outdated or repeats another, call \`archive_section\`; when it belongs in
   another document, call \`move_section\`. Give the reason and tell me in one
   line what you archived or moved.
4. When I correct you and the correction should apply next time, call
   \`propose_learning\` with the same remote/path and stacks. Say in one line that
   you did. Do not propose one-off preferences or task-specific details.
5. Never try to change a section marked \`locked\`.
6. \`[[name]]\` in OpenPurpose text links to another project or a glossary term, and
   \`[[org/name]]\` to a project in another organization. Use \`get_related\` when
   your task touches a linked service.
7. If \`get_context\` lists "Review feedback waiting on you", read it with
   \`get_review\` before other work. Answer each thread with \`reply_to_review\`,
   accept suggestions you agree with via \`apply_suggestion\`, and push other
   fixes with \`revise_proposal\`. Tell me in one line what the reviewer asked for.
8. When you call or implement an HTTP endpoint of this or a linked service, use
   \`get_api\` (listed under "APIs" in \`get_context\`) for the exact paths,
   parameters and DTOs. Don't guess request or response shapes.
9. When you notice a real problem outside your task, don't fix it: call
   \`report_finding\` with the file, a one-line title, what's wrong and how you
   would fix it. Say in one line that you did. If \`get_context\` lists known
   findings, don't report them again, and ask me before fixing one. After fixing
   one, call \`resolve_finding\` with the commit or PR. If one isn't a real
   problem and I agree, call \`dismiss_finding\` with the reason. If you got a
   detail of your own finding wrong, correct it with \`update_finding\`.`;

@Component({
  selector: 'app-settings-connect',
  imports: [CodeBlock, RouterLink, SectionHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'settings-tab' },
  template: `
    <section>
      <header
        os-section-header
        title="Connect an agent"
        description="Any MCP client that supports streamable HTTP works: Claude Code, Cursor, VS Code, Codex and others."
      ></header>
      <ol class="steps">
        <li>
          <div>
            <h3>Get an agent token</h3>
            @if (session.adminsAnything) {
              <p>
                Create one agent per developer and tool under
                <a routerLink="/settings/people">People and agents</a>. The token decides which
                organization the agent works in.
              </p>
            } @else {
              <p>
                Ask an admin of {{ session.org()?.name ?? 'your organization' }} for an agent token.
                One per developer and tool keeps history readable.
              </p>
            }
          </div>
        </li>
        <li>
          <div>
            <h3>Add the server to your client</h3>
            <p>Claude Code:</p>
            <os-code-block [code]="claudeCommand" what="command" />
            <p>Other clients (mcp.json):</p>
            <os-code-block [code]="mcpJson" what="MCP config" />
          </div>
        </li>
        <li>
          <div>
            <h3>Tell agents to use it</h3>
            <p>
              Agents follow the server's instructions more reliably when the repository says so too.
              Add this to <code>AGENTS.md</code> or <code>CLAUDE.md</code>.
            </p>
            <os-code-block [code]="agentsSnippet" what="text for AGENTS.md" />
          </div>
        </li>
        <li>
          <div>
            <h3>Optional: take the guided first run</h3>
            <p>
              Ask your agent to <q>set up OpenPurpose in this repository</q>. It fetches the
              <code>init-openpurpose</code> skill from this server (<code>list_skills</code>,
              <code>get_skill</code>) and walks you through it: it connects the repository to a
              project, shows what an agent sees there and turns one rule you keep repeating into
              your first learning.
            </p>
          </div>
        </li>
        <li>
          <div>
            <h3>Optional: pin a repository to a project</h3>
            <p>
              OpenPurpose finds the project from the git remote. To override that, for example in a
              fork, add <code>.openpurpose.json</code> to the repository root. Each project page
              shows its own.
            </p>
            <os-code-block [code]="agentContext" what=".openpurpose.json" />
            <p>
              <a routerLink="/settings/test">Test a repository</a> to check what an agent there will
              get.
            </p>
          </div>
        </li>
      </ol>
    </section>
  `,
})
export class ConnectTab {
  protected readonly session = inject(Session);

  private readonly base = this.session.me()?.public_url ?? location.origin;
  readonly claudeCommand = `claude mcp add --transport http openpurpose ${this.base}/mcp \\\n  --header "Authorization: Bearer <agent token>"`;
  readonly mcpJson = JSON.stringify(
    {
      mcpServers: {
        openpurpose: {
          type: 'http',
          url: `${this.base}/mcp`,
          headers: { Authorization: 'Bearer <agent token>' },
        },
      },
    },
    null,
    2,
  );

  readonly agentsSnippet = AGENTS_SNIPPET;

  readonly agentContext = JSON.stringify(
    { project: `${this.session.org()?.slug ?? 'org'}/project-slug` },
    null,
    2,
  );
}
