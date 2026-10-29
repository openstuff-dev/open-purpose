import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Badge, Button, Control, Field, Callout } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { GroupRow } from '../core/models';
import { Session } from '../core/session';
import { ContextSwitch } from '../core/switch';
import { Notices } from '../shared/notice';
import { Icon } from '../shared/icon';
import { initials } from '../core/theme';

/** Server admins: every group (tenant) on this OpenPurpose server. */
@Component({
  selector: 'app-groups',
  imports: [Callout, FormsModule, DatePipe, Icon, Button, Field, Control, Badge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h2>All groups</h2>
      <p class="quiet">
        Each group is walled off from the others in the database: its people, agents and rules never
        see another group's. Use one per company or client. A group starts as one organization; its
        admins can add more later. Export downloads a full backup of a group, people included;
        restore one under Settings › Export and import.
      </p>
    </section>

    @if (created(); as c) {
      <os-callout tone="success" role="alert" title="{{ c.name }} is ready" level="2">
        @if (c.token) {
          <p>Give this token to {{ c.admin }}, the group's first admin. It is not shown again.</p>
          <pre><code>{{ c.token }}</code></pre>
        } @else {
          <p>You are its first admin. Switch to it to add organizations, people and agents.</p>
        }
        <div class="form-actions">
          <button os-button variant="primary" type="button" (click)="open(c.id)">
            Open {{ c.name }}
          </button>
          <button os-button type="button" (click)="created.set(null)">Done</button>
        </div>
      </os-callout>
    }

    <ul class="group-list">
      @for (g of groups(); track g.id) {
        <li>
          <span class="group-name"
            ><span class="badge sm group">{{ initials(g.name) }}</span
            ><strong>{{ g.name }}</strong> <code class="quiet">{{ g.slug }}</code></span
          >
          <button os-button size="sm" type="button" (click)="exportGroup(g)">
            <app-icon name="download" />Export
          </button>
          @if (g.id !== session.group()?.id) {
            <button os-button size="sm" type="button" (click)="open(g.id)">Switch to it</button>
          } @else {
            <span os-badge>Current</span>
          }
          <span class="quiet"
            >{{ g.organizations }} {{ g.organizations === 1 ? 'organization' : 'organizations' }},
            {{ g.members }} {{ g.members === 1 ? 'member' : 'members' }}, created
            {{ g.created_at | date: 'd MMM y' }}</span
          >
        </li>
      }
    </ul>

    <section>
      <h3 class="list-label">New group</h3>
      <form class="inline-form os-panel os-panel-body" (ngSubmit)="create()">
        <os-field label="Company or client" class="grow"
          ><input os-input name="name" [(ngModel)]="draft.name" required placeholder="Contoso"
        /></os-field>
        <label class="os-field grow"
          ><span class="os-label"
            >First organization <span class="quiet">(if not the same)</span></span
          ><input
            os-input
            name="org"
            [(ngModel)]="draft.organization_name"
            [placeholder]="draft.name || 'Contoso Retail'"
        /></label>
        <label class="os-field full"
          ><span class="os-label"
            >First admin <span class="quiet">(leave empty to be the admin yourself)</span></span
          ><input
            os-input
            name="admin"
            [(ngModel)]="draft.admin_name"
            placeholder="Name of the person who will run it"
        /></label>
        <div class="form-actions full">
          <button os-button variant="primary" type="submit" [disabled]="!draft.name.trim()">
            <app-icon name="plus" />Create group
          </button>
        </div>
      </form>
    </section>
  `,
})
export class GroupsPage {
  readonly session = inject(Session);
  private api = inject(Api);
  private switcher = inject(ContextSwitch);
  private router = inject(Router);
  private notices = inject(Notices);
  readonly groups = signal<GroupRow[]>([]);
  readonly initials = initials;
  readonly created = signal<{ id: string; name: string; admin: string; token?: string } | null>(
    null,
  );

  draft = { name: '', organization_name: '', admin_name: '' };

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      this.groups.set(await this.api.groups());
    } catch (e) {
      this.notices.error(e);
    }
  }

  async create(): Promise<void> {
    try {
      const r = await this.api.createGroup({
        name: this.draft.name.trim(),
        organization_name: this.draft.organization_name.trim() || undefined,
        admin_name: this.draft.admin_name.trim() || undefined,
      });
      this.created.set({
        id: r.group.id,
        name: r.group.name,
        admin: this.draft.admin_name.trim(),
        token: r.token,
      });
      this.draft = { name: '', organization_name: '', admin_name: '' };
      await this.load();
    } catch (e) {
      this.notices.error(e);
    }
  }

  /** Everything in the group, as a backup: the same file as Settings › Export and import. */
  async exportGroup(g: GroupRow): Promise<void> {
    try {
      const { blob, name } = await this.api.exportFile({
        organizationId: null,
        format: 'json',
        groupId: g.id,
        includes: { history: true, proposals: true, api_specs: true, findings: true, people: true },
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async open(id: string): Promise<void> {
    try {
      await this.switcher.group(id);
      await this.router.navigate(['/group']);
    } catch (e) {
      this.notices.error(e);
    }
  }
}
