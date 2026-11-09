import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Control,
  Field,
  SectionHeader,
  SettingCard,
  SettingItem,
  SettingRow,
} from '@openstuff-dev/ui-angular';
import { Api } from '../../core/api';
import type { Organization } from '../../core/models';
import { Session, claimingOldSlug } from '../../core/session';
import { initials } from '../../core/theme';
import { Icon } from '../../shared/icon';
import { Notices } from '../../shared/notice';
import { SlugRenameField } from '../../shared/slug-rename';

@Component({
  selector: 'app-settings-organizations',
  imports: [
    Badge,
    Button,
    Checkbox,
    Control,
    Field,
    FormsModule,
    Icon,
    SectionHeader,
    SettingCard,
    SettingItem,
    SettingRow,
    SlugRenameField,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'settings-tab' },
  template: `
    @if (session.canAdmin(null) && session.groupShown()) {
      <section>
        <header
          os-section-header
          title="Workspace"
          description="The workspace holds your organizations. Its rules apply to every project in them."
        ></header>
        <div os-setting-card>
          <os-setting-row
            label="Workspace name"
            description="Shown to everyone in {{
              session.group()?.name
            }}, and to agents as the top layer of their context."
          >
            <form class="setting-save" (ngSubmit)="renameGroup()">
              <input os-input name="gname" [(ngModel)]="groupName" required />
              <button
                os-button
                type="submit"
                [disabled]="!groupName.trim() || groupName.trim() === session.group()?.name"
              >
                Save
              </button>
            </form>
          </os-setting-row>
          <os-setting-row
            label="Context budget"
            description="Largest context an agent gets from get_context, in every organization. Over it, the most general sections are cut to their first sentence, and agents read the rest with read_section. Leave empty for no limit."
          >
            <form class="setting-save" (ngSubmit)="saveGroupBudget()">
              <input
                os-input
                name="gbudget"
                type="number"
                min="1000"
                step="1000"
                inputmode="numeric"
                placeholder="No limit"
                [(ngModel)]="groupBudget"
              />
              <button
                os-button
                type="submit"
                [disabled]="budgetValue(groupBudget) === session.group()?.context_max_tokens"
              >
                Save
              </button>
            </form>
          </os-setting-row>
        </div>
      </section>
    }

    <section>
      <header
        os-section-header
        title="Organizations"
        [description]="
          session.groupShown()
            ? 'Each keeps its own rules, projects and inbox, and is private to its members unless shared below.'
            : 'Most teams need just one. Add another for a separate company or division with its own rules, projects and people.'
        "
      ></header>
      <div os-setting-card>
        @for (o of manageableOrgs(); track o.id) {
          @if (editingOrg() === o.id) {
            <div class="setting-card-form">
              <form class="inline-form" (ngSubmit)="saveOrg(o)">
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
                      >Over it, <code>get_context</code> cuts the most general sections to their
                      first sentence. Leave empty for no limit.</span
                    >
                  </label>
                }
                <div class="form-actions full">
                  <button os-button variant="primary" type="submit">Save</button>
                  <button os-button type="button" (click)="editingOrg.set(null)">Cancel</button>
                </div>
              </form>
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
            <os-setting-item [title]="o.name" [archived]="!!o.archived_at">
              <span
                os-setting-item-tag
                class="badge setting-item-lead"
                [style.background]="session.orgColor(o.id)"
                >{{ initials(o.name) }}</span
              >
              <code os-setting-item-tag class="quiet">{{ o.slug }}</code>
              @if (o.archived_at) {
                <span os-setting-item-tag os-badge>Archived</span>
              }
              <p os-setting-item-meta class="os-setting-item-meta multiline">
                {{ o.summary || 'No summary' }}
              </p>
              @if (!session.groupShown()) {
                <p os-setting-item-meta class="os-setting-item-meta">
                  {{
                    o.context_max_tokens === null
                      ? 'No context budget'
                      : 'Context budget: ' +
                        o.context_max_tokens.toLocaleString('en-US') +
                        ' tokens'
                  }}
                </p>
              }
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
            </os-setting-item>
          }
        }
        @if (session.canAdmin(null)) {
          <div class="setting-card-form">
            @if (addingOrg()) {
              <form class="inline-form" (ngSubmit)="createOrg()">
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
                    With a second organization, {{ session.org()?.name }} becomes one of several in
                    a workspace. The workspace gets its own rules that reach every organization, and
                    a page under this name.
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
                  <button os-button type="button" (click)="addingOrg.set(false)">Cancel</button>
                </div>
              </form>
            } @else {
              <div>
                <button os-button type="button" (click)="addingOrg.set(true)">
                  <app-icon name="plus" />{{
                    session.groupShown() ? 'New organization' : 'Add a second organization'
                  }}
                </button>
              </div>
            }
          </div>
        }
      </div>
    </section>

    @if (session.canAdmin(null) && activeOrgs().length > 1) {
      <section>
        <header
          os-section-header
          title="Who can read what"
          description="Tick a box to let members and agents of the organization on the left read the one at the top. Reading only: agents never write outside their own organization. People with a role in the workspace read everything."
        ></header>
        <div os-setting-card>
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
  `,
})
export class OrganizationsTab {
  readonly session = inject(Session);
  private readonly confirmDialog = inject(ConfirmDialog);
  private api = inject(Api);
  private notices = inject(Notices);
  readonly initials = initials;

  readonly editingOrg = signal<string | null>(null);
  readonly addingOrg = signal(false);
  readonly manageableOrgs = computed(() =>
    (this.session.me()?.organizations ?? []).filter((o) => this.session.canAdmin(o.id)),
  );

  readonly activeOrgs = computed(() => this.session.orgs());
  groupName = '';
  groupBudget: number | null = null;
  orgDraft: { name: string; summary: string; budget: number | null } = {
    name: '',
    summary: '',
    budget: null,
  };

  newOrg = { name: '', slug: '', summary: '' };

  constructor() {
    effect(() => {
      const me = this.session.me();
      if (me) {
        this.groupName = me.group.name;
        this.groupBudget = me.group.context_max_tokens;
      }
    });
  }

  async reloadMe(): Promise<void> {
    this.session.me.set(await this.api.me());
  }

  async renameGroup(): Promise<void> {
    await this.run(async () => {
      await this.api.updateGroup({ name: this.groupName.trim() });
      await this.reloadMe();
    }, 'Renamed workspace');
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

  private async run(fn: () => Promise<unknown>, ok: string): Promise<void> {
    try {
      await fn();
      this.notices.ok(ok);
    } catch (e) {
      this.notices.error(e);
    }
  }
}
