import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import type { Scope } from '../core/models';
import { Session, claimingOldSlug } from '../core/session';
import { Notices } from './notice';
import { Icon } from './icon';

export const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/** Scopes at the org level (projectId null) or inside a project. */
@Component({
  selector: 'app-scope-list',
  imports: [RouterLink, FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (scopes().length) {
      <ul class="scope-list">
        @for (s of scopes(); track s.id) {
          <li>
            <a [routerLink]="['/scopes', s.id]" class="scope-name">{{ s.name }}</a>
            <span class="scope-match">
              @for (g of s.path_globs; track g) { <code class="chip path">{{ g }}</code> }
              @for (t of s.stacks; track t) { <span class="chip stack">{{ t }}</span> }
              @if (!s.path_globs.length && !s.stacks.length) { <span class="quiet">Matches nothing automatically</span> }
            </span>
            @if (s.description) { <p class="quiet">{{ s.description }}</p> }
          </li>
        }
      </ul>
    } @else if (loaded()) {
      <p class="empty">{{ emptyText() }}</p>
    }
    @if (canEdit()) {
      @if (adding()) {
        <form class="inline-form" (ngSubmit)="create()">
          <label class="grow">Name <input name="name" [(ngModel)]="name" required [placeholder]="projectId() ? 'Frontend' : organizationId() ? 'Angular apps' : 'All .NET code'"></label>
          <label class="full">Paths <span class="quiet">(globs relative to the repo root, comma separated)</span>
            <input name="globs" [(ngModel)]="globs" class="mono" [placeholder]="projectId() ? 'frontend/**, apps/web/**' : ''"></label>
          <label class="full">Stacks <span class="quiet">(tags detected from package.json, .csproj and similar)</span>
            <input name="stacks" [(ngModel)]="stacks" [placeholder]="projectId() ? 'angular' : organizationId() ? 'angular' : 'dotnet'"></label>
          <p class="quiet full">A scope applies when any path or any stack matches the code an agent is working on.</p>
          <div class="form-actions full">
            <button class="btn primary" type="submit" [disabled]="!name.trim()">Create scope</button>
            <button class="btn" type="button" (click)="adding.set(false)">Cancel</button>
          </div>
        </form>
      } @else {
        <button class="btn" type="button" (click)="adding.set(true)"><app-icon name="plus" />New scope</button>
      }
    }
  `,
})
export class ScopeList {
  /** null = group-wide. */
  readonly organizationId = input<string | null>(null);
  readonly projectId = input<string | null>(null);
  readonly canEdit = input(false);
  readonly emptyText = input('No scopes yet.');
  readonly session = inject(Session);
  private api = inject(Api);
  private notices = inject(Notices);
  readonly scopes = signal<Scope[]>([]);
  readonly loaded = signal(false);
  readonly adding = signal(false);
  name = '';
  globs = '';
  stacks = '';

  constructor() {
    effect(() => void this.load(this.organizationId(), this.projectId()));
  }

  private async load(organizationId: string | null, projectId: string | null): Promise<void> {
    try {
      this.scopes.set(await this.api.scopes({ organization_id: organizationId, project_id: projectId }));
    } catch (e) {
      this.notices.error(e);
    }
    this.loaded.set(true);
  }

  async create(): Promise<void> {
    try {
      const created = await claimingOldSlug((take_alias) => this.api.createScope({
        organization_id: this.organizationId(), project_id: this.projectId(), name: this.name.trim(),
        path_globs: splitList(this.globs), stacks: splitList(this.stacks), take_alias,
      }));
      if (!created) return;
      this.notices.ok(`Created scope ${this.name.trim()}`);
      this.name = this.globs = this.stacks = '';
      this.adding.set(false);
      await this.load(this.organizationId(), this.projectId());
    } catch (e) {
      this.notices.error(e);
    }
  }
}
