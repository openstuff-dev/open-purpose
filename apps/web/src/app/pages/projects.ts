import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Badge, Button, Check, Checkbox, Chip, Control, Field } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { Project } from '../core/models';
import { Session, claimingOldSlug } from '../core/session';
import { Notices } from '../shared/notice';
import { Icon } from '../shared/icon';

@Component({
  selector: 'app-projects',
  imports: [RouterLink, FormsModule, Icon, Button, Field, Control, Check, Checkbox, Badge, Chip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <div class="title-row">
        <h1>Projects</h1>
        @if (session.org() && session.canEdit(session.orgId())) {
          <button os-button variant="primary" type="button" (click)="adding.set(!adding())">
            <app-icon name="plus" />New project
          </button>
        }
      </div>
      <p class="lede">
        A project is one product. It can span several repositories, such as a frontend repo and an
        API repo.
      </p>
    </header>

    <div class="tabs" role="tablist" aria-label="Which organizations">
      @if (session.org(); as org) {
        <button type="button" role="tab" [attr.aria-selected]="!all()" (click)="setAll(false)">
          {{ org.name }}
        </button>
      }
      <button
        type="button"
        role="tab"
        [attr.aria-selected]="all() || !session.org()"
        (click)="setAll(true)"
      >
        Every organization {{ session.agentView() ? 'the agent' : 'I' }} can read
      </button>
    </div>

    <div class="toolbar">
      <input
        os-input
        type="search"
        class="search"
        placeholder="Search by name, slug or repository"
        aria-label="Search projects"
        [ngModel]="q()"
        (ngModelChange)="search($event)"
      />
      <label os-check
        ><input
          os-checkbox
          type="checkbox"
          [ngModel]="onlyReview()"
          (ngModelChange)="onlyReview.set($event)"
        />
        Needs review</label
      >
    </div>

    @if (adding()) {
      <form class="inline-form panel" (ngSubmit)="create()">
        <p class="full" style="margin:0">
          <strong>New project in {{ session.org()?.name }}</strong>
        </p>
        <os-field label="Name" class="grow"
          ><input
            os-input
            name="name"
            [(ngModel)]="draft.name"
            required
            placeholder="Customer Portal"
        /></os-field>
        <os-field label="Slug"
          ><input
            os-input
            name="slug"
            class="mono"
            [(ngModel)]="draft.slug"
            placeholder="customer-portal"
        /></os-field>
        <label class="os-field full"
          ><span class="os-label"
            >Repository <span class="quiet">(optional, the git remote URL)</span></span
          ><input
            os-input
            name="remote"
            class="mono"
            [(ngModel)]="draft.remote_url"
            placeholder="https://dev.azure.com/org/project/_git/repo"
        /></label>
        <os-field label="Purpose" class="full">
          <textarea
            os-textarea
            name="purpose"
            rows="3"
            [(ngModel)]="draft.purpose"
            placeholder="What it does, who uses it, and what good looks like."
          ></textarea>
        </os-field>
        <div class="form-actions full">
          <button os-button variant="primary" type="submit" [disabled]="!draft.name.trim()">
            Create project
          </button>
          <button os-button type="button" (click)="adding.set(false)">Cancel</button>
        </div>
      </form>
    }

    @if (visible().length) {
      <ul class="project-list">
        @for (p of visible(); track p.id) {
          <li>
            <a [routerLink]="['/projects', p.id]">
              <span class="project-id">
                <span class="project-name"
                  >{{ p.name }}
                  @if (showOrg()) {
                    <span os-chip
                      ><i class="dot" [style.background]="session.orgColor(p.organization_id)"></i
                      >{{ p.organization_name }}</span
                    >
                  }
                  @if (!p.reviewed) {
                    <span os-badge tone="warning">Needs review</span>
                  }
                </span>
                <code class="project-slug">{{ p.organization_slug }}/{{ p.slug }}</code>
              </span>
              <span class="project-summary">{{ p.summary || 'No summary yet' }}</span>
              <span class="project-stats">
                @if (p.pending_proposals) {
                  <span class="pending">{{ p.pending_proposals }} to review</span>
                }
                <span title="Repositories"
                  ><app-icon name="branch" [size]="12" /> {{ p.repository_count }}</span
                >
              </span>
            </a>
          </li>
        }
      </ul>
    } @else if (loaded()) {
      <p class="empty">
        @if (q() || onlyReview()) {
          No projects match.
        } @else {
          No projects yet. Create the first one, or let an agent create it from a repository; it
          will show up here for review.
        }
      </p>
    }
  `,
})
export class ProjectsPage {
  readonly session = inject(Session);
  private api = inject(Api);
  private router = inject(Router);
  private notices = inject(Notices);
  readonly projects = signal<Project[]>([]);
  readonly loaded = signal(false);
  readonly q = signal('');
  readonly onlyReview = signal(false);
  readonly adding = signal(false);
  readonly all = signal(false);
  readonly showOrg = computed(() => this.all() || !this.session.org());
  readonly visible = computed(() =>
    this.projects().filter((p) => !this.onlyReview() || !p.reviewed),
  );
  draft = { name: '', slug: '', remote_url: '', purpose: '' };
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    void this.load();
  }

  search(q: string): void {
    this.q.set(q);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(), 200);
  }

  setAll(all: boolean): void {
    this.all.set(all);
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const orgId = this.all() ? null : this.session.orgId();
      this.projects.set(await this.api.projects({ q: this.q(), organizationId: orgId }));
    } catch (e) {
      this.notices.error(e);
    }
    this.loaded.set(true);
  }

  async create(): Promise<void> {
    try {
      const p = await claimingOldSlug((take_alias) =>
        this.api.createProject({
          organization_id: this.session.orgId(),
          name: this.draft.name.trim(),
          slug: this.draft.slug.trim() || undefined,
          remote_url: this.draft.remote_url.trim() || undefined,
          purpose: this.draft.purpose.trim() || undefined,
          summary: this.draft.purpose.trim().split('\n')[0].slice(0, 200) || undefined,
          take_alias,
        }),
      );
      if (!p) return;
      this.notices.ok(`Created ${p.name}`);
      await this.router.navigate(['/projects', p.id]);
    } catch (e) {
      this.notices.error(e);
    }
  }
}
