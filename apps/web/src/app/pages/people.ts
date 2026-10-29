import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Badge,
  Button,
  Chip,
  ConfirmDialog,
  Control,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Fieldset,
  Callout,
  Check,
  Checkbox,
  EmptyState,
  Radio,
} from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import { ROLE_LABEL, type AgentReview, type Member, type Role } from '../core/models';
import { Session } from '../core/session';
import { Notices } from '../shared/notice';
import { Icon } from '../shared/icon';

interface NewToken {
  actor: string;
  kind: 'human' | 'agent';
  token: string;
  where: string;
}

const GROUP = 'group';

const REVIEW_OPTIONS: { value: AgentReview; label: string; hint: string }[] = [
  {
    value: 'edit_modes',
    label: 'Follow edit modes',
    hint: 'Open sections change right away; propose sections become proposals in the inbox.',
  },
  {
    value: 'always_propose',
    label: 'Always propose',
    hint: 'Every change goes to the inbox, even in open sections and documents.',
  },
  {
    value: 'auto_approve',
    label: 'Approve automatically',
    hint: 'Proposals are approved the moment they arrive. Nobody reviews them.',
  },
];

@Component({
  selector: 'app-people',
  imports: [
    EmptyState,
    Callout,
    FormsModule,
    DatePipe,
    NgTemplateOutlet,
    Icon,
    Button,
    Field,
    Fieldset,
    Check,
    Checkbox,
    Radio,
    Control,
    Badge,
    Chip,
    Dialog,
    DialogHeader,
    DialogTitle,
    DialogBody,
    DialogFooter,
    DialogClose,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h2>People and agents</h2>
      <p class="quiet">
        Everyone who reads or writes {{ session.group()?.name }} has a token. People sign in here;
        agents send theirs to the MCP endpoint and work in one organization.
      </p>
    </section>

    @if (fresh(); as t) {
      <os-callout tone="success" role="alert" title="Token for {{ t.actor }}" level="2">
        <p>Copy it now. It is not shown again.</p>
        <pre><code>{{ t.token }}</code></pre>
        @if (t.kind === 'agent') {
          <p>This agent works in {{ t.where }}. Connect Claude Code:</p>
          <pre><code>{{ claudeCommand(t.token) }}</code></pre>
          <p>Or add to any MCP client's config:</p>
          <pre><code>{{ mcpJson(t.token) }}</code></pre>
        }
        <div class="form-actions">
          <button os-button type="button" (click)="copy(t.token)">Copy token</button>
          <button os-button type="button" (click)="fresh.set(null)">Done</button>
        </div>
      </os-callout>
    }

    <section>
      <form class="inline-form os-panel os-panel-body" (ngSubmit)="create()">
        <os-field label="Name" class="grow"
          ><input
            os-input
            name="name"
            [(ngModel)]="name"
            required
            [placeholder]="kind === 'agent' ? 'Claude Code, Jonas' : 'Jonas Hansen'"
        /></os-field>
        <os-field label="Kind"
          ><select os-select name="kind" [(ngModel)]="kind" (ngModelChange)="fixLevel()">
            <option value="human">Person</option>
            <option value="agent">Agent</option>
          </select></os-field
        >
        <label class="os-field"
          ><span class="os-label">{{ kind === 'agent' ? 'Works in' : 'Role in' }}</span
          ><select os-select name="level" [(ngModel)]="level">
            @for (l of levels(); track l.id) {
              @if (kind === 'human' || l.id !== GROUP) {
                <option [value]="l.id">{{ l.name }}</option>
              }
            }
          </select>
        </label>
        @if (kind === 'human') {
          <os-field label="Role"
            ><select os-select name="role" [(ngModel)]="role">
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </select></os-field
          >
        }
        <p class="quiet full">
          @if (kind === 'agent') {
            One agent per developer and tool makes history readable: you see whose agent proposed
            what. It can read the workspace, its own organization and organizations shared with it,
            and write only to its own.
          } @else {
            Editors change rules and review the inbox; viewers read; admins also manage people. A
            role in the workspace reaches every organization: admins administer all of them, editors
            and viewers read all of them and edit workspace-wide rules.
          }
        </p>
        <div class="form-actions full">
          <button os-button variant="primary" type="submit" [disabled]="!name.trim() || !level">
            <app-icon name="plus" />Add and create token
          </button>
        </div>
      </form>
    </section>

    <section>
      <h3 class="list-label">People</h3>
      <ul class="actor-list">
        @for (m of people(); track m.id) {
          <ng-container *ngTemplateOutlet="row; context: { $implicit: m }" />
        }
      </ul>
      <h3 class="list-label">Agents</h3>
      @if (agents().length) {
        <ul class="actor-list">
          @for (m of agents(); track m.id) {
            <ng-container *ngTemplateOutlet="row; context: { $implicit: m }" />
          }
        </ul>
      } @else {
        <os-empty-state title="No agents yet" level="4" bordered>
          Add one above to get a token for Claude Code or another MCP client.
        </os-empty-state>
      }
    </section>

    <ng-template #row let-m>
      <li [class.disabled]="m.disabled_at">
        <div class="actor-main">
          <span class="actor-avatar"
            ><app-icon [name]="m.kind === 'agent' ? 'bot' : 'user'" [size]="15"
          /></span>
          <strong>{{ m.name }}</strong>
          @if (m.is_superadmin) {
            <span os-chip>Server admin</span>
          }
          @if (m.disabled_at) {
            <span os-badge tone="warning">Disabled</span>
          }
          @if (m.permissions?.review === 'auto_approve') {
            <span os-badge tone="danger">Approves automatically</span>
          } @else if (m.permissions?.review === 'always_propose') {
            <span os-chip>Always proposes</span>
          }
          @if (m.permissions?.accept_findings) {
            <span os-badge tone="warning">Accepts findings</span>
          }
          @if (m.manageable) {
            <span class="actor-actions">
              @if (m.kind === 'agent') {
                <button
                  os-button
                  variant="ghost"
                  size="sm"
                  type="button"
                  (click)="startPermissions(m)"
                >
                  <app-icon name="shield" [size]="13" />Permissions
                </button>
              }
              <button os-button variant="ghost" size="sm" type="button" (click)="issuing.set(m)">
                <app-icon name="key" [size]="13" />New token
              </button>
              @if (m.id !== session.me()?.actor?.id) {
                <button
                  os-button
                  variant="ghost"
                  size="sm"
                  type="button"
                  (click)="toggleDisabled(m)"
                >
                  {{ m.disabled_at ? 'Enable' : 'Disable' }}
                </button>
              }
            </span>
          }
        </div>
        <div class="memberships">
          @for (ms of m.memberships; track ms.id) {
            <span class="membership">
              <i
                class="dot"
                [style.background]="
                  ms.organization_id ? session.orgColor(ms.organization_id) : 'var(--ink)'
                "
              ></i>
              {{ session.orgName(ms.organization_id) }}
              @if (ms.role === 'agent') {
                <span class="quiet">agent</span>
              } @else if (session.canAdmin(ms.organization_id)) {
                <select
                  os-select
                  [ngModel]="ms.role"
                  (ngModelChange)="setRole(ms.id, $event)"
                  [attr.aria-label]="
                    'Role for ' + m.name + ' in ' + session.orgName(ms.organization_id)
                  "
                >
                  <option value="admin">Admin</option>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                @if (m.memberships.length > 1 || m.id !== session.me()?.actor?.id) {
                  <button
                    os-button
                    variant="link"
                    size="sm"
                    tone="danger"
                    type="button"
                    (click)="removeRole(m, ms)"
                    [attr.aria-label]="
                      'Remove ' + m.name + ' from ' + session.orgName(ms.organization_id)
                    "
                  >
                    Remove
                  </button>
                }
              } @else {
                <span class="quiet">{{ roleName(ms.role) }}</span>
              }
            </span>
          }
          @if (m.kind === 'human' && addable(m).length) {
            @if (adding() === m.id) {
              <span class="membership">
                <select os-select [(ngModel)]="addLevel" aria-label="Where">
                  @for (l of addable(m); track l.id) {
                    <option [value]="l.id">{{ l.name }}</option>
                  }
                </select>
                <select os-select [(ngModel)]="addRole" aria-label="Role">
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </select>
                <button os-button variant="link" size="sm" type="button" (click)="addRoleTo(m)">
                  Add
                </button>
                <button os-button variant="link" size="sm" type="button" (click)="adding.set(null)">
                  Cancel
                </button>
              </span>
            } @else {
              <button os-button variant="link" size="sm" type="button" (click)="startAdd(m)">
                Add a role
              </button>
            }
          }
        </div>
        @if (m.manageable) {
          <ul class="tokens">
            @for (t of m.tokens; track t.id) {
              <li [class.revoked]="t.revoked_at">
                <code>{{ t.prefix }}…</code> <span>{{ t.label }}</span>
                <span class="quiet">
                  @if (t.revoked_at) {
                    revoked {{ t.revoked_at | date: 'd MMM y' }}
                  } @else if (t.last_used_at) {
                    last used {{ t.last_used_at | date: 'd MMM y, HH:mm' }}
                  } @else {
                    never used
                  }
                </span>
                @if (!t.revoked_at) {
                  <button
                    os-button
                    variant="link"
                    size="sm"
                    tone="danger"
                    type="button"
                    (click)="revoke(t.id)"
                  >
                    Revoke
                  </button>
                }
              </li>
            }
          </ul>
        } @else {
          <p class="quiet">Also belongs elsewhere; a server admin manages their tokens.</p>
        }
      </li>
    </ng-template>

    <dialog os-dialog size="sm" [open]="!!issuing()" (openChange)="$event || issuing.set(null)">
      @if (issuing(); as m) {
        <form (ngSubmit)="issue(m)">
          <header os-dialog-header>
            <h2 os-dialog-title>New token for {{ m.name }}</h2>
          </header>
          <div os-dialog-body>
            <os-field label="Label" hint="Where it's used, for example work laptop.">
              <input os-input name="label" [(ngModel)]="tokenLabel" />
            </os-field>
          </div>
          <footer os-dialog-footer>
            <button os-button type="button" os-dialog-close>Cancel</button>
            <button os-button variant="primary" type="submit">Create token</button>
          </footer>
        </form>
      }
    </dialog>

    <dialog os-dialog [open]="!!permitting()" (openChange)="$event || permitting.set(null)">
      @if (permitting(); as m) {
        <form (ngSubmit)="savePermissions(m)">
          <header os-dialog-header>
            <h2 os-dialog-title>Permissions for {{ m.name }}</h2>
          </header>
          <div os-dialog-body class="permissions">
            <p class="quiet">
              What {{ m.name }} may do in {{ agentOrgName(m) }} without a person's review. Locked
              sections stay locked, and workspace-wide changes always wait for a workspace editor.
            </p>
            <fieldset os-fieldset>
              <legend class="os-label">Changes this agent makes</legend>
              @for (o of reviewOptions; track o.value) {
                <label os-check
                  ><input
                    os-radio
                    type="radio"
                    name="review"
                    [value]="o.value"
                    [(ngModel)]="review"
                  />
                  <span class="permission-option"
                    ><span>{{ o.label }}</span
                    ><span class="os-hint">{{ o.hint }}</span></span
                  ></label
                >
              }
            </fieldset>
            @if (review === 'auto_approve') {
              <os-callout
                tone="danger"
                role="alert"
                title="Nobody reviews what this agent writes"
                level="3"
              >
                <p>
                  Normally a learning never reaches another agent before a person approves it. With
                  this on, {{ m.name }}'s learnings, section edits, new sections and scopes reach
                  every agent in {{ agentOrgName(m) }} the moment they arrive.
                </p>
                <ul>
                  <li>
                    A misread correction becomes a rule, and other agents follow it until someone
                    notices.
                  </li>
                  <li>
                    If its token leaks, whoever holds it can rewrite every section that isn't
                    locked.
                  </li>
                  <li>
                    Lock the sections that must never change this way. Every change is marked
                    "Approved automatically" in History, where you can restore the old version.
                  </li>
                </ul>
              </os-callout>
            }
            <fieldset os-fieldset>
              <legend class="os-label">Findings</legend>
              <label os-check
                ><input os-checkbox type="checkbox" name="accept" [(ngModel)]="acceptFindings" />
                <span class="permission-option"
                  ><span>Accept findings automatically</span
                  ><span class="os-hint">File them as To do instead of New.</span></span
                ></label
              >
            </fieldset>
            @if (acceptFindings) {
              <os-callout tone="warning" role="alert" title="Findings skip sorting" level="3">
                <p>
                  {{ m.name }}'s findings land in To do, where agents may pick them up and fix them
                  when someone asks, including ones a person would have dismissed.
                </p>
              </os-callout>
            }
            @if (m.permissions; as perm) {
              @if (perm.set_at) {
                <p class="quiet">
                  Last changed by {{ perm.set_by_name ?? 'someone' }} on
                  {{ perm.set_at | date: 'd MMM y' }}.
                </p>
              }
            }
          </div>
          <footer os-dialog-footer>
            <button os-button type="button" os-dialog-close>Cancel</button>
            <button os-button variant="primary" type="submit">Save permissions</button>
          </footer>
        </form>
      }
    </dialog>
  `,
})
export class PeoplePage {
  readonly session = inject(Session);
  private readonly confirmDialog = inject(ConfirmDialog);
  private api = inject(Api);
  private notices = inject(Notices);
  readonly GROUP = GROUP;
  readonly roleLabel = ROLE_LABEL;
  readonly members = signal<Member[]>([]);
  readonly people = computed(() => this.members().filter((m) => m.kind === 'human'));
  readonly agents = computed(() => this.members().filter((m) => m.kind === 'agent'));
  readonly fresh = signal<NewToken | null>(null);
  /** Whose new token is being labelled. */
  readonly issuing = signal<Member | null>(null);
  tokenLabel = 'laptop';
  /** Whose permissions are being changed. */
  readonly permitting = signal<Member | null>(null);
  readonly reviewOptions = REVIEW_OPTIONS;
  review: AgentReview = 'edit_modes';
  acceptFindings = false;
  readonly adding = signal<string | null>(null);
  /** Levels this admin manages: the group (group admins) and each organization they administer. */
  readonly levels = computed(() => {
    const out: { id: string; name: string }[] = [];
    if (this.session.canAdmin(null))
      out.push({ id: GROUP, name: `${this.session.group()?.name} (every organization)` });
    for (const o of this.session.orgs())
      if (this.session.canAdmin(o.id)) out.push({ id: o.id, name: o.name });
    return out;
  });

  name = '';
  kind: 'human' | 'agent' = 'agent';
  role: Role = 'editor';
  level = '';
  addLevel = '';
  addRole: Role = 'viewer';

  constructor() {
    void this.load();
    this.fixLevel();
  }

  fixLevel(): void {
    const options = this.levels().filter((l) => this.kind === 'human' || l.id !== GROUP);
    if (!options.some((l) => l.id === this.level)) {
      this.level = options.find((l) => l.id === this.session.orgId())?.id ?? options.at(0)?.id ?? '';
    }
  }

  roleName(role: string): string {
    return (ROLE_LABEL as Partial<Record<string, string>>)[role] ?? role;
  }

  private orgOf(level: string): string | null {
    return level === GROUP ? null : level;
  }

  addable(m: Member): { id: string; name: string }[] {
    const have = new Set(m.memberships.map((x) => x.organization_id ?? GROUP));
    return this.levels().filter((l) => !have.has(l.id));
  }

  private async load(): Promise<void> {
    try {
      this.members.set(await this.api.members());
      this.fixLevel();
    } catch (e) {
      this.notices.error(e);
    }
  }

  private get base(): string {
    return this.session.me()?.public_url ?? location.origin;
  }

  claudeCommand(token: string): string {
    return `claude mcp add --transport http openpurpose ${this.base}/mcp \\\n  --header "Authorization: Bearer ${token}"`;
  }

  mcpJson(token: string): string {
    return JSON.stringify(
      {
        mcpServers: {
          openpurpose: {
            type: 'http',
            url: `${this.base}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2,
    );
  }

  async create(): Promise<void> {
    try {
      const orgId = this.orgOf(this.level);
      const r = await this.api.createMember({
        name: this.name.trim(),
        kind: this.kind,
        organization_id: orgId,
        role: this.kind === 'human' ? this.role : undefined,
      });
      this.fresh.set({
        actor: r.actor.name,
        kind: r.actor.kind,
        token: r.token,
        where: this.session.orgName(orgId),
      });
      this.name = '';
      await this.load();
    } catch (e) {
      this.notices.error(e);
    }
  }

  startAdd(m: Member): void {
    this.addLevel = this.addable(m)[0]?.id ?? '';
    this.addRole = 'viewer';
    this.adding.set(m.id);
  }

  async addRoleTo(m: Member): Promise<void> {
    const orgId = this.orgOf(this.addLevel);
    await this.run(
      () => this.api.addMembership(m.id, { organization_id: orgId, role: this.addRole }),
      `${m.name} is now ${ROLE_LABEL[this.addRole].toLowerCase()} in ${this.session.orgName(orgId)}`,
    );
    this.adding.set(null);
  }

  async setRole(membershipId: string, role: Role): Promise<void> {
    await this.run(() => this.api.updateMembership(membershipId, role), 'Changed role');
  }

  async removeRole(m: Member, ms: Member['memberships'][number]): Promise<void> {
    const where = this.session.orgName(ms.organization_id);
    const remove = await this.confirmDialog.confirm({
      title: `Remove ${m.name} from ${where}?`,
      message: `They lose their role in ${where}.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!remove) return;
    await this.run(() => this.api.removeMembership(ms.id), `Removed ${m.name} from ${where}`);
  }

  async issue(m: Member): Promise<void> {
    const label = this.tokenLabel.trim();
    this.issuing.set(null);
    this.tokenLabel = 'laptop';
    try {
      const r = await this.api.issueToken(m.id, label);
      const org = m.memberships.find((x) => x.organization_id)?.organization_id ?? null;
      this.fresh.set({
        actor: m.name,
        kind: m.kind,
        token: r.token,
        where: this.session.orgName(org),
      });
      await this.load();
    } catch (e) {
      this.notices.error(e);
    }
  }

  agentOrgName(m: Member): string {
    const own = m.memberships.find((x) => x.organization_id);
    return this.session.orgName(own?.organization_id ?? null);
  }

  startPermissions(m: Member): void {
    this.review = m.permissions?.review ?? 'edit_modes';
    this.acceptFindings = m.permissions?.accept_findings ?? false;
    this.permitting.set(m);
  }

  async savePermissions(m: Member): Promise<void> {
    const review = this.review;
    const acceptFindings = this.acceptFindings;
    if (review === 'auto_approve' && m.permissions?.review !== 'auto_approve') {
      const sure = await this.confirmDialog.confirm({
        title: `Approve everything ${m.name} proposes?`,
        message: `Its changes reach every agent in ${this.agentOrgName(m)} without review. You can turn this off again at any time.`,
        confirmLabel: 'Approve automatically',
        danger: true,
      });
      if (!sure) return;
    }
    this.permitting.set(null);
    await this.run(
      () => this.api.updateMember(m.id, { review, accept_findings: acceptFindings }),
      `Saved permissions for ${m.name}`,
    );
  }

  async revoke(id: string): Promise<void> {
    const revoke = await this.confirmDialog.confirm({
      title: 'Revoke this token?',
      message: 'Anything using it stops working immediately.',
      confirmLabel: 'Revoke token',
      danger: true,
    });
    if (!revoke) return;
    await this.run(() => this.api.revokeToken(id), 'Revoked token');
  }

  async toggleDisabled(m: Member): Promise<void> {
    await this.run(
      () => this.api.updateMember(m.id, { disabled: !m.disabled_at }),
      m.disabled_at ? `Enabled ${m.name}` : `Disabled ${m.name}`,
    );
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.notices.ok('Copied token');
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
    await this.load();
  }
}
