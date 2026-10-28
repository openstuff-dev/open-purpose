import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Control,
  Field,
  Callout, PageHeader } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { Organization, TokenRow } from '../core/models';
import { Session, claimingOldSlug } from '../core/session';
import { Theme, initials, type ThemeChoice } from '../core/theme';
import { Icon } from '../shared/icon';
import { Notices } from '../shared/notice';
import { SlugRenameField } from '../shared/slug-rename';
import { GroupsPage } from './groups';
import { PeoplePage } from './people';
import { PreviewPage } from './preview';
import { TransferPage } from './transfer';

type Tab =
  'account' | 'appearance' | 'connect' | 'test' | 'group' | 'people' | 'transfer' | 'server';

const AGENTS_SNIPPET = `## OpenPurpose (shared rules and learnings)

We keep our purpose, business logic, glossary, guidelines and learnings in
OpenPurpose, available through the \`openpurpose\` MCP server. Rules come in layers: our
organization, the project and the part of the code you are in (a repository or a folder).

1. Before you start a task, call \`get_context\` with:
   - \`remote_url\` from \`git remote get-url origin\`
   - \`project\` from \`.openpurpose.json\` if that file exists
   - \`path\`: the file or folder you are about to work on
   - \`manifests\`: the nearest \`package.json\`, \`*.csproj\` or similar, with its content
   Follow what it returns. More specific rules override general ones.
2. When you move to a different part of the repo (for example from \`frontend/\`
   to \`backend/\`), call \`get_context\` again with the new path and manifest.
3. If no project is found, ask me which project this repo belongs to, then call
   \`register_repository\` (or \`create_project\`) and create \`.openpurpose.json\`.
4. When I correct you and the correction should apply next time, call
   \`propose_learning\` with the same remote/path/manifests. Say in one line that
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
   one, call \`resolve_finding\` with the commit or PR. If you got a detail of
   your own finding wrong, correct it with \`update_finding\`.`;

@Component({
  selector: 'app-settings',
  imports: [
    PageHeader,
    Callout,
    FormsModule,
    DatePipe,
    RouterLink,
    RouterLinkActive,
    Icon,
    PeoplePage,
    GroupsPage,
    PreviewPage,
    SlugRenameField,
    TransferPage,
    Button,
    Field,
    Control,
    Checkbox,
    Badge,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header os-page-header title="Settings"></header>

    <div class="settings">
      <nav class="settings-nav" aria-label="Settings">
        <div class="nav-label">You</div>
        <a routerLink="/settings/account" routerLinkActive="active"
          ><app-icon name="user" />Account and tokens</a
        >
        <a routerLink="/settings/appearance" routerLinkActive="active"
          ><app-icon name="palette" />Appearance</a
        >
        <a routerLink="/settings/connect" routerLinkActive="active"
          ><app-icon name="plug" />Connect an agent</a
        >
        <a routerLink="/settings/test" routerLinkActive="active"
          ><app-icon name="eye" />Test a repository</a
        >
        @if (session.adminsAnything) {
          <div class="nav-label">
            {{ session.groupShown() ? session.group()?.name : session.org()?.name }}
          </div>
          <a routerLink="/settings/group" routerLinkActive="active"
            ><app-icon name="building" />Organizations</a
          >
          <a routerLink="/settings/people" routerLinkActive="active"
            ><app-icon name="users" />People and agents</a
          >
          <a routerLink="/settings/transfer" routerLinkActive="active"
            ><app-icon name="transfer" />Export and import</a
          >
        }
        @if (session.isSuperadmin) {
          <div class="nav-label">Server</div>
          <a routerLink="/settings/server" routerLinkActive="active"
            ><app-icon name="server" />All groups</a
          >
        }
      </nav>

      <div class="settings-body">
        @switch (current()) {
          @case ('account') {
            <section>
              <h2>Account</h2>
              <div class="os-setting-card">
                <div class="os-setting-row" data-inline>
                  <div class="os-setting-text">
                    <h3>Name</h3>
                    <p>Shown in history, the inbox and on proposals your agents make.</p>
                  </div>
                  <form (ngSubmit)="saveName()">
                    <input
                      os-input
                      name="name"
                      [(ngModel)]="name"
                      aria-label="Your name"
                      required
                    />
                    <button
                      os-button
                      type="submit"
                      [disabled]="!name.trim() || name.trim() === session.me()?.actor?.name"
                    >
                      Save
                    </button>
                  </form>
                </div>
                <div class="os-setting-row" data-inline>
                  <div class="os-setting-text">
                    <h3>Your access</h3>
                    <p>{{ accessLine() }}</p>
                  </div>
                </div>
              </div>
            </section>

            <section>
              <h2>Personal tokens</h2>
              <p class="quiet">
                Use one per device. A personal token also works over MCP, for scripts or an agent
                that acts as you.
              </p>
              @if (freshToken(); as t) {
                <os-callout
                  tone="success"
                  title="Copy your new token now. It is not shown again."
                  role="alert"
                >
                  <div class="copy-block wide">
                    <pre><code>{{ t }}</code></pre>
                    <button os-button size="sm" type="button" (click)="copy(t)">
                      <app-icon name="copy" [size]="13" />Copy
                    </button>
                  </div>
                  <button
                    os-button
                    os-actions
                    variant="link"
                    size="sm"
                    type="button"
                    (click)="freshToken.set(null)"
                  >
                    Done
                  </button>
                </os-callout>
              }
              <div class="os-setting-card">
                @for (t of tokens(); track t.id) {
                  <div class="os-setting-row" data-inline [style.opacity]="t.revoked_at ? 0.55 : 1">
                    <div class="os-setting-text">
                      <h3>
                        <app-icon name="key" [size]="14" /> {{ t.label }}
                        <code class="quiet">{{ t.prefix }}…</code>
                      </h3>
                      <p>
                        Created {{ t.created_at | date: 'd MMM y' }} ·
                        @if (t.revoked_at) {
                          revoked {{ t.revoked_at | date: 'd MMM y' }}
                        } @else if (t.last_used_at) {
                          last used {{ t.last_used_at | date: 'd MMM y, HH:mm' }}
                        } @else {
                          never used
                        }
                        @if (isCurrent(t)) {
                          · <strong>this browser</strong>
                        }
                      </p>
                    </div>
                    @if (!t.revoked_at) {
                      <button
                        os-button
                        variant="danger"
                        size="sm"
                        type="button"
                        (click)="revoke(t)"
                      >
                        Revoke
                      </button>
                    }
                  </div>
                }
                <div class="os-setting-row" data-inline>
                  <form (ngSubmit)="newToken()">
                    <input
                      os-input
                      name="label"
                      [(ngModel)]="tokenLabel"
                      placeholder="Label, e.g. work laptop"
                      aria-label="Token label"
                    />
                    <button os-button type="submit"><app-icon name="plus" />Create token</button>
                  </form>
                </div>
              </div>
            </section>
          }

          @case ('appearance') {
            <section>
              <h2>Appearance</h2>
              <p class="quiet">Stored in this browser only.</p>
              <div class="os-setting-card">
                <div class="os-setting-row stack">
                  <div class="os-setting-text"><h3>Theme</h3></div>
                  <div class="theme-options" role="radiogroup" aria-label="Theme">
                    @for (o of themes; track o.value) {
                      <button
                        type="button"
                        class="theme-option"
                        role="radio"
                        [attr.aria-checked]="theme.choice() === o.value"
                        (click)="theme.set(o.value)"
                      >
                        <div class="theme-swatch" [class]="'theme-swatch ' + o.value">
                          <i></i><i></i>
                        </div>
                        <span><app-icon [name]="o.icon" [size]="14" />{{ o.label }}</span>
                      </button>
                    }
                  </div>
                </div>
              </div>
            </section>
          }

          @case ('connect') {
            <section>
              <h2>Connect an agent</h2>
              <p class="quiet">
                Any MCP client that supports streamable HTTP works: Claude Code, Cursor, VS Code,
                Codex and others.
              </p>
              <ol class="steps">
                <li>
                  <div>
                    <h3>Get an agent token</h3>
                    @if (session.adminsAnything) {
                      <p>
                        Create one agent per developer and tool under
                        <a routerLink="/settings/people">People and agents</a>. The token decides
                        which organization the agent works in.
                      </p>
                    } @else {
                      <p>
                        Ask an admin of {{ session.org()?.name ?? 'your organization' }} for an
                        agent token. One per developer and tool keeps history readable.
                      </p>
                    }
                  </div>
                </li>
                <li>
                  <div>
                    <h3>Add the server to your client</h3>
                    <p>Claude Code:</p>
                    <div class="copy-block">
                      <pre><code>{{ claudeCommand }}</code></pre>
                      <button os-button size="sm" type="button" (click)="copy(claudeCommand)">
                        <app-icon name="copy" [size]="13" />Copy
                      </button>
                    </div>
                    <p>Other clients (mcp.json):</p>
                    <div class="copy-block">
                      <pre><code>{{ mcpJson }}</code></pre>
                      <button os-button size="sm" type="button" (click)="copy(mcpJson)">
                        <app-icon name="copy" [size]="13" />Copy
                      </button>
                    </div>
                  </div>
                </li>
                <li>
                  <div>
                    <h3>Tell agents to use it</h3>
                    <p>
                      Agents follow the server's instructions more reliably when the repository says
                      so too. Add this to <code>AGENTS.md</code> or <code>CLAUDE.md</code>.
                    </p>
                    <div class="copy-block">
                      <pre><code>{{ agentsSnippet }}</code></pre>
                      <button os-button size="sm" type="button" (click)="copy(agentsSnippet)">
                        <app-icon name="copy" [size]="13" />Copy
                      </button>
                    </div>
                  </div>
                </li>
                <li>
                  <div>
                    <h3>Optional: pin a repository to a project</h3>
                    <p>
                      OpenPurpose finds the project from the git remote. To override that, for
                      example in a fork, add <code>.openpurpose.json</code> to the repository root.
                      Each project page shows its own.
                    </p>
                    <pre><code>{{ agentContext }}</code></pre>
                    <p>
                      <a routerLink="/settings/test">Test a repository</a> to check what an agent
                      there will get.
                    </p>
                  </div>
                </li>
              </ol>
            </section>
          }

          @case ('group') {
            @if (session.canAdmin(null) && session.groupShown()) {
              <section>
                <h2>Group</h2>
                <div class="os-setting-card">
                  <div class="os-setting-row" data-inline>
                    <div class="os-setting-text">
                      <h3>Group name</h3>
                      <p>
                        Shown to everyone in {{ session.group()?.name }}, and to agents as the top
                        layer of their context.
                      </p>
                    </div>
                    <form (ngSubmit)="renameGroup()">
                      <input
                        os-input
                        name="gname"
                        [(ngModel)]="groupName"
                        aria-label="Group name"
                        required
                      />
                      <button
                        os-button
                        type="submit"
                        [disabled]="!groupName.trim() || groupName.trim() === session.group()?.name"
                      >
                        Save
                      </button>
                    </form>
                  </div>
                  <div class="os-setting-row" data-inline>
                    <div class="os-setting-text">
                      <h3>Context budget</h3>
                      <p>
                        Largest context an agent gets from <code>get_context</code>, in every
                        organization. Over it, the most general sections are cut to their first
                        sentence, and agents read the rest with <code>read_section</code>. Leave
                        empty for no limit.
                      </p>
                    </div>
                    <form (ngSubmit)="saveGroupBudget()">
                      <input
                        os-input
                        name="gbudget"
                        type="number"
                        min="1000"
                        step="1000"
                        inputmode="numeric"
                        placeholder="No limit"
                        [(ngModel)]="groupBudget"
                        aria-label="Context budget in tokens"
                      />
                      <button
                        os-button
                        type="submit"
                        [disabled]="
                          budgetValue(groupBudget) === session.group()?.context_max_tokens
                        "
                      >
                        Save
                      </button>
                    </form>
                  </div>
                </div>
              </section>
            }

            <section>
              <div class="block-head">
                <div>
                  <h2>Organizations</h2>
                  <p class="quiet">
                    {{
                      session.groupShown()
                        ? 'Each keeps its own rules, projects and inbox, and is private to its members unless shared below.'
                        : 'Most teams need just one. Add another for a separate company or division with its own rules, projects and people.'
                    }}
                  </p>
                </div>
              </div>
              <div class="os-setting-card">
                @for (o of manageableOrgs(); track o.id) {
                  <div class="os-setting-row" data-inline [style.opacity]="o.archived_at ? 0.6 : 1">
                    @if (editingOrg() === o.id) {
                      <form class="inline-form full-row" (ngSubmit)="saveOrg(o)">
                        <os-field label="Name" class="grow"
                          ><input os-input name="oname" [(ngModel)]="orgDraft.name" required
                        /></os-field>
                        <os-field label="Summary" class="full">
                          <textarea
                            os-textarea
                            name="osum"
                            rows="3"
                            [(ngModel)]="orgDraft.summary"
                          ></textarea>
                        </os-field>
                        @if (!session.groupShown()) {
                          <label class="os-field full"
                            ><span class="os-label">Context budget (tokens)</span
                            ><input
                              os-input
                              name="obudget"
                              type="number"
                              min="1000"
                              step="1000"
                              inputmode="numeric"
                              placeholder="No limit"
                              [(ngModel)]="orgDraft.budget"
                            />
                            <span class="quiet"
                              >Over it, <code>get_context</code> cuts the most general sections to
                              their first sentence. Leave empty for no limit.</span
                            >
                          </label>
                        }
                        <div class="form-actions full">
                          <button os-button variant="primary" type="submit">Save</button>
                          <button os-button type="button" (click)="editingOrg.set(null)">
                            Cancel
                          </button>
                        </div>
                      </form>
                      <div class="full-row">
                        <app-slug-rename
                          kind="organization"
                          [id]="o.id"
                          [slug]="o.slug"
                          [name]="o.name"
                          [aliases]="o.aliases"
                          [canEdit]="session.canAdmin(null)"
                          (changed)="reloadMe()"
                        />
                      </div>
                    } @else {
                      <div class="org-row">
                        <span class="badge" [style.background]="session.orgColor(o.id)">{{
                          initials(o.name)
                        }}</span>
                        <div class="os-setting-text">
                          <h3>
                            {{ o.name }} <code class="quiet">{{ o.slug }}</code>
                            @if (o.archived_at) {
                              <span os-badge>Archived</span>
                            }
                          </h3>
                          <p class="multiline">{{ o.summary || 'No summary' }}</p>
                          @if (!session.groupShown()) {
                            <p class="quiet">
                              {{
                                o.context_max_tokens === null
                                  ? 'No context budget'
                                  : 'Context budget: ' +
                                    o.context_max_tokens.toLocaleString('en-US') +
                                    ' tokens'
                              }}
                            </p>
                          }
                        </div>
                      </div>
                      <div class="form-actions">
                        <button os-button size="sm" type="button" (click)="editOrg(o)">
                          <app-icon name="pencil" [size]="13" />Edit
                        </button>
                        @if (session.canAdmin(null)) {
                          <button
                            os-button
                            variant="ghost"
                            size="sm"
                            type="button"
                            (click)="toggleArchive(o)"
                          >
                            {{ o.archived_at ? 'Restore' : 'Archive' }}
                          </button>
                        }
                      </div>
                    }
                  </div>
                }
                @if (session.canAdmin(null)) {
                  <div class="os-setting-row" data-inline>
                    @if (addingOrg()) {
                      <form class="inline-form full-row" (ngSubmit)="createOrg()">
                        <os-field label="Name" class="grow"
                          ><input
                            os-input
                            name="nname"
                            [(ngModel)]="newOrg.name"
                            required
                            placeholder="Acme Payments"
                        /></os-field>
                        <os-field label="Slug"
                          ><input
                            os-input
                            name="nslug"
                            class="mono"
                            [(ngModel)]="newOrg.slug"
                            placeholder="payments"
                        /></os-field>
                        <os-field label="Summary" class="full">
                          <textarea
                            os-textarea
                            name="nsum"
                            rows="3"
                            [(ngModel)]="newOrg.summary"
                          ></textarea>
                        </os-field>
                        @if (!session.groupShown()) {
                          <os-field label="Name for both organizations together" class="full"
                            ><input
                              os-input
                              name="ngroup"
                              [(ngModel)]="groupName"
                              required
                              placeholder="Acme Group"
                          /></os-field>
                          <p class="quiet full">
                            With a second organization, {{ session.org()?.name }} becomes one of
                            several in a group. The group gets its own rules that reach every
                            organization, and a page under this name.
                          </p>
                        }
                        <p class="quiet full">
                          The slug is what people write in links to its projects, like
                          <code>[[payments/payment-gateway]]</code>.
                        </p>
                        <div class="form-actions full">
                          <button
                            os-button
                            variant="primary"
                            type="submit"
                            [disabled]="!newOrg.name.trim() || !groupName.trim()"
                          >
                            Create organization
                          </button>
                          <button os-button type="button" (click)="addingOrg.set(false)">
                            Cancel
                          </button>
                        </div>
                      </form>
                    } @else {
                      <button os-button type="button" (click)="addingOrg.set(true)">
                        <app-icon name="plus" />{{
                          session.groupShown() ? 'New organization' : 'Add a second organization'
                        }}
                      </button>
                    }
                  </div>
                }
              </div>
            </section>

            @if (session.canAdmin(null) && activeOrgs().length > 1) {
              <section>
                <h2>Who can read what</h2>
                <p class="quiet">
                  Tick a box to let members and agents of the organization on the left read the one
                  at the top. Reading only: agents never write outside their own organization.
                  People with a role in the group read everything.
                </p>
                <div class="os-setting-card">
                  <table class="matrix">
                    <thead>
                      <tr>
                        <th scope="col">Members of…</th>
                        @for (t of activeOrgs(); track t.id) {
                          <th scope="col">may read {{ t.name }}</th>
                        }
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of activeOrgs(); track r.id) {
                        <tr>
                          <th scope="row">
                            <span class="badge sm" [style.background]="session.orgColor(r.id)">{{
                              initials(r.name)
                            }}</span
                            >{{ r.name }}
                          </th>
                          @for (t of activeOrgs(); track t.id) {
                            <td>
                              @if (r.id === t.id) {
                                <span class="self" title="Always">—</span>
                              } @else {
                                <input
                                  os-checkbox
                                  type="checkbox"
                                  [checked]="t.readers.includes(r.id)"
                                  (change)="share(t, r, $any($event.target).checked)"
                                  [attr.aria-label]="r.name + ' may read ' + t.name"
                                />
                              }
                            </td>
                          }
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </section>
            }
          }

          @case ('test') {
            <app-preview />
          }
          @case ('people') {
            <app-people />
          }
          @case ('transfer') {
            <app-transfer />
          }
          @case ('server') {
            <app-groups />
          }
        }
      </div>
    </div>
  `,
})
export class SettingsPage {
  readonly tab = input<string | undefined>();
  readonly session = inject(Session);
  private readonly confirmDialog = inject(ConfirmDialog);
  readonly theme = inject(Theme);
  private api = inject(Api);
  private notices = inject(Notices);
  private router = inject(Router);
  readonly initials = initials;

  readonly current = computed<Tab>(() => {
    const t = (this.tab() ?? 'account') as Tab;
    const allowed: Tab[] = ['account', 'appearance', 'connect', 'test'];
    if (this.session.adminsAnything) allowed.push('group', 'people', 'transfer');
    if (this.session.isSuperadmin) allowed.push('server');
    return allowed.includes(t) ? t : 'account';
  });

  readonly themes: { value: ThemeChoice; label: string; icon: string }[] = [
    { value: 'system', label: 'System', icon: 'monitor' },
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' },
  ];

  readonly tokens = signal<TokenRow[]>([]);
  readonly freshToken = signal<string | null>(null);
  readonly editingOrg = signal<string | null>(null);
  readonly addingOrg = signal(false);
  readonly manageableOrgs = computed(() =>
    (this.session.me()?.organizations ?? []).filter((o) => this.session.canAdmin(o.id)),
  );

  readonly activeOrgs = computed(() => this.session.orgs());
  name = '';
  tokenLabel = '';
  groupName = '';
  groupBudget: number | null = null;
  orgDraft: { name: string; summary: string; budget: number | null } = {
    name: '',
    summary: '',
    budget: null,
  };

  newOrg = { name: '', slug: '', summary: '' };

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

  constructor() {
    effect(() => {
      const me = this.session.me();
      if (me) {
        this.name = me.actor.name;
        this.groupName = me.group.name;
        this.groupBudget = me.group.context_max_tokens;
      }
    });
    effect(() => {
      if (this.current() === 'account') void this.loadTokens();
    });
    effect(() => {
      if (this.tab() && this.tab() !== this.current())
        void this.router.navigate(['/settings', this.current()], { replaceUrl: true });
    });
  }

  accessLine(): string {
    const me = this.session.me();
    if (!me) return '';
    const parts: string[] = [];
    if (me.actor.is_superadmin) parts.push('server admin');
    if (me.group.role) parts.push(`${me.group.role} of ${me.group.name} (every organization)`);
    for (const o of me.organizations) {
      if (o.role && !me.group.role) parts.push(`${o.role} in ${o.name}`);
    }
    const shared = me.organizations.filter((o) => o.readable && !o.role).map((o) => o.name);
    if (shared.length) parts.push(`can read ${shared.join(', ')}`);
    const s = parts.join('; ');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) + '.' : 'No roles yet.';
  }

  isCurrent(t: TokenRow): boolean {
    return !!this.session.token()?.startsWith(t.prefix);
  }

  private async loadTokens(): Promise<void> {
    try {
      this.tokens.set(await this.api.myTokens());
    } catch (e) {
      this.notices.error(e);
    }
  }

  async reloadMe(): Promise<void> {
    this.session.me.set(await this.api.me());
  }

  async saveName(): Promise<void> {
    await this.run(async () => {
      await this.api.renameMe(this.name.trim());
      await this.reloadMe();
    }, 'Saved your name');
  }

  async newToken(): Promise<void> {
    try {
      const r = await this.api.createMyToken(this.tokenLabel.trim());
      this.freshToken.set(r.token);
      this.tokenLabel = '';
      await this.loadTokens();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async revoke(t: TokenRow): Promise<void> {
    const current = this.isCurrent(t);
    const revoke = await this.confirmDialog.confirm(
      current
        ? {
            title: 'Revoke the token you are signed in with?',
            message: 'You are signed out, and anything else using it stops working.',
            confirmLabel: 'Revoke and sign out',
            danger: true,
          }
        : {
            title: `Revoke ${t.label}?`,
            message: 'Anything using it stops working immediately.',
            confirmLabel: 'Revoke token',
            danger: true,
          },
    );
    if (!revoke) return;
    try {
      await this.api.revokeMyToken(t.id);
      if (current) {
        this.session.setToken(null);
        return;
      }
      this.notices.ok('Revoked token');
      await this.loadTokens();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async renameGroup(): Promise<void> {
    await this.run(async () => {
      await this.api.updateGroup({ name: this.groupName.trim() });
      await this.reloadMe();
    }, 'Renamed group');
  }

  /** An empty number input gives null or ''; both mean no limit. */
  budgetValue(v: number | string | null): number | null {
    return v === null || v === '' ? null : Number(v);
  }

  async saveGroupBudget(): Promise<void> {
    await this.run(async () => {
      await this.api.updateGroup({ context_max_tokens: this.budgetValue(this.groupBudget) });
      await this.reloadMe();
    }, 'Saved context budget');
  }

  editOrg(o: Organization): void {
    this.orgDraft = { name: o.name, summary: o.summary, budget: o.context_max_tokens };
    this.editingOrg.set(o.id);
  }

  async saveOrg(o: Organization): Promise<void> {
    await this.run(async () => {
      await this.api.updateOrganization(o.id, {
        name: this.orgDraft.name.trim(),
        summary: this.orgDraft.summary,
        ...(this.session.groupShown()
          ? {}
          : { context_max_tokens: this.budgetValue(this.orgDraft.budget) }),
      });
      this.editingOrg.set(null);
      await this.reloadMe();
    }, `Saved ${this.orgDraft.name.trim()}`);
  }

  async toggleArchive(o: Organization): Promise<void> {
    const archive = !o.archived_at;
    if (
      archive &&
      !(await this.confirmDialog.confirm({
        title: `Archive ${o.name}?`,
        message:
          'It disappears from menus, lists and the map. Its content stays, and you can restore it.',
        confirmLabel: 'Archive',
      }))
    )
      return;
    await this.run(
      async () => {
        await this.api.updateOrganization(o.id, { archived: archive });
        await this.reloadMe();
      },
      archive ? `Archived ${o.name}` : `Restored ${o.name}`,
    );
  }

  async createOrg(): Promise<void> {
    try {
      const body = {
        name: this.newOrg.name.trim(),
        slug: this.newOrg.slug.trim() || undefined,
        summary: this.newOrg.summary.trim() || undefined,
      };
      const naming =
        !this.session.groupShown() && this.groupName.trim() !== this.session.group()?.name;
      if (
        !(await claimingOldSlug(this.confirmDialog, (take_alias) =>
          this.api.createOrganization({ ...body, take_alias }),
        ))
      )
        return;
      if (naming) await this.api.updateGroup({ name: this.groupName.trim() });
      this.newOrg = { name: '', slug: '', summary: '' };
      this.addingOrg.set(false);
      await this.reloadMe();
      this.notices.ok('Created organization. Add people and agents to it under People and agents.');
    } catch (e) {
      this.notices.error(e);
    }
  }

  async share(target: Organization, reader: Organization, allowed: boolean): Promise<void> {
    await this.run(
      async () => {
        await this.api.setReader(target.id, reader.id, allowed);
        await this.reloadMe();
      },
      allowed
        ? `${reader.name} can now read ${target.name}`
        : `${reader.name} can no longer read ${target.name}`,
    );
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.notices.ok('Copied');
    } catch {
      this.notices.error('Copying is blocked in this browser. Select the text instead.');
    }
  }

  private async run(fn: () => Promise<unknown>, ok: string): Promise<void> {
    try {
      await fn();
      this.notices.ok(ok);
    } catch (e) {
      this.notices.error(e);
    }
  }
}
