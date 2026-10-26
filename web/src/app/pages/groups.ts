import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
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
  imports: [FormsModule, DatePipe, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h2>All groups</h2>
      <p class="quiet">Each group is walled off from the others in the database: its people, agents and rules never see another group's. Use one per company or client. A group starts as one organization; its admins can add more later.</p>
    </section>

    @if (created(); as c) {
      <section class="callout token-callout" role="alert">
        <h2>{{ c.name }} is ready</h2>
        @if (c.token) {
          <p>Give this token to {{ c.admin }}, the group's first admin. It is not shown again.</p>
          <pre><code>{{ c.token }}</code></pre>
        } @else {
          <p>You are its first admin. Switch to it to add organizations, people and agents.</p>
        }
        <div class="form-actions">
          <button class="btn primary" type="button" (click)="open(c.id)">Open {{ c.name }}</button>
          <button class="btn" type="button" (click)="created.set(null)">Done</button>
        </div>
      </section>
    }

    <ul class="group-list">
      @for (g of groups(); track g.id) {
        <li>
          <span style="display:flex;align-items:center;gap:0.6rem"><span class="badge sm group">{{ initials(g.name) }}</span><strong>{{ g.name }}</strong> <code class="quiet">{{ g.slug }}</code></span>
          @if (g.id !== session.group()?.id) { <button class="btn sm" type="button" (click)="open(g.id)">Switch to it</button> } @else { <span class="flag muted">Current</span> }
          <span class="quiet">{{ g.organizations }} {{ g.organizations === 1 ? 'organization' : 'organizations' }}, {{ g.members }} {{ g.members === 1 ? 'member' : 'members' }}, created {{ g.created_at | date: 'd MMM y' }}</span>
        </li>
      }
    </ul>

    <section>
      <h3 class="list-label">New group</h3>
      <form class="inline-form panel" (ngSubmit)="create()">
        <label class="grow">Company or client <input name="name" [(ngModel)]="draft.name" required placeholder="Contoso"></label>
        <label class="grow">First organization <span class="quiet">(if not the same)</span> <input name="org" [(ngModel)]="draft.organization_name" [placeholder]="draft.name || 'Contoso Retail'"></label>
        <label class="full">First admin <span class="quiet">(leave empty to be the admin yourself)</span>
          <input name="admin" [(ngModel)]="draft.admin_name" placeholder="Name of the person who will run it"></label>
        <div class="form-actions full">
          <button class="btn primary" type="submit" [disabled]="!draft.name.trim()"><app-icon name="plus" />Create group</button>
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
  readonly created = signal<{ id: string; name: string; admin: string; token?: string } | null>(null);
  draft = { name: '', organization_name: '', admin_name: '' };

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.groups.set(await this.api.groups());
    } catch (e) {
      this.notices.error(e);
    }
  }

  async create(): Promise<void> {
    try {
      const r = await this.api.createGroup({
        name: this.draft.name.trim(), organization_name: this.draft.organization_name.trim() || undefined,
        admin_name: this.draft.admin_name.trim() || undefined,
      });
      this.created.set({ id: r.group.id, name: r.group.name, admin: this.draft.admin_name.trim(), token: r.token });
      this.draft = { name: '', organization_name: '', admin_name: '' };
      await this.load();
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
