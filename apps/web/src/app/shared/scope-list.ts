import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Button, Chip, ConfirmDialog, Control, Field } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { Repository, Scope } from '../core/models';
import { Session, claimingOldSlug } from '../core/session';
import { Notices } from './notice';
import { Icon } from './icon';
import { RepoPicker } from './repo-picker';

export const splitList = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** "azure:acme/platform/portal-web" -> "portal-web" */
export const repoName = (key: string) => key.split('/').pop() || key;

/** Scopes at the org level (projectId null) or inside a project. */
@Component({
  selector: 'app-scope-list',
  imports: [RouterLink, FormsModule, Icon, RepoPicker, Button, Field, Control, Chip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (scopes().length) {
      <ul class="scope-list">
        @for (s of scopes(); track s.id) {
          <li>
            <a [routerLink]="['/scopes', s.id]" class="scope-name">{{ s.name }}</a>
            <span class="scope-match">
              @for (id of s.repository_ids; track id) {
                <span os-chip tone="brand" class="mono" [title]="repoKey(id)"
                  ><app-icon name="branch" [size]="11" />{{ repoLabel(id) }}</span
                >
              }
              @for (g of s.path_globs; track g) {
                <code os-chip tone="brand">{{ g }}</code>
              }
              @for (t of s.stacks; track t) {
                <span os-chip>{{ t }}</span>
              }
              @if (!s.repository_ids.length && !s.path_globs.length && !s.stacks.length) {
                <span class="quiet">Matches nothing automatically</span>
              }
            </span>
            @if (s.description) {
              <p class="quiet multiline">{{ s.description }}</p>
            }
          </li>
        }
      </ul>
    } @else if (loaded()) {
      <p class="empty">{{ emptyText() }}</p>
    }
    @if (canEdit()) {
      @if (adding()) {
        <form class="inline-form" (ngSubmit)="create()">
          <os-field label="Name" class="grow"
            ><input
              os-input
              name="name"
              [(ngModel)]="name"
              required
              [placeholder]="
                projectId() ? 'Frontend' : organizationId() ? 'Angular apps' : 'All .NET code'
              "
          /></os-field>
          @if (projectId(); as pid) {
            <app-repo-picker
              class="full"
              [projectId]="pid"
              [(repositories)]="repos"
              [(selected)]="repositoryIds"
              (added)="repositoryAdded.emit($event)"
            />
          }
          <label class="os-field full"
            ><span class="os-label"
              >Paths
              <span class="quiet"
                >(globs relative to the repo root, comma separated{{
                  projectId() ? '; optional with a repository' : ''
                }})</span
              ></span
            ><input
              os-input
              name="globs"
              [(ngModel)]="globs"
              class="mono"
              [placeholder]="projectId() ? 'frontend/**, apps/web/**' : ''"
          /></label>
          <label class="os-field full"
            ><span class="os-label"
              >Stacks
              <span class="quiet"
                >(tags detected from package.json, .csproj and similar)</span
              ></span
            ><input
              os-input
              name="stacks"
              [(ngModel)]="stacks"
              [placeholder]="projectId() ? 'angular' : organizationId() ? 'angular' : 'dotnet'"
          /></label>
          <p class="quiet full">
            {{
              projectId()
                ? 'With repositories ticked, the scope applies only inside them: everywhere, or where a path or stack matches. Without, it applies wherever a path or stack matches.'
                : 'A scope applies when any path or any stack matches the code an agent is working on.'
            }}
          </p>
          <div class="form-actions full">
            <button os-button variant="primary" type="submit" [disabled]="!name.trim()">
              Create scope
            </button>
            <button os-button type="button" (click)="adding.set(false)">Cancel</button>
          </div>
        </form>
      } @else {
        <button os-button type="button" (click)="adding.set(true)">
          <app-icon name="plus" />New scope
        </button>
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
  /** The project's repositories (project scopes only). */
  readonly repositories = input<Repository[]>([]);
  readonly repositoryAdded = output<Repository>();
  readonly session = inject(Session);
  private readonly confirmDialog = inject(ConfirmDialog);
  private api = inject(Api);
  private notices = inject(Notices);
  readonly scopes = signal<Scope[]>([]);
  readonly loaded = signal(false);
  readonly adding = signal(false);
  name = '';
  globs = '';
  stacks = '';
  readonly repos = signal<Repository[]>([]);
  readonly repositoryIds = signal<string[]>([]);

  constructor() {
    effect(() => void this.load(this.organizationId(), this.projectId()));
    effect(() => this.repos.set(this.repositories()));
  }

  repoKey(id: string): string {
    return this.repos().find((r) => r.id === id)?.remote_key ?? 'Unknown repository';
  }

  repoLabel(id: string): string {
    return repoName(this.repoKey(id));
  }

  private async load(organizationId: string | null, projectId: string | null): Promise<void> {
    try {
      this.scopes.set(
        await this.api.scopes({ organization_id: organizationId, project_id: projectId }),
      );
    } catch (e) {
      this.notices.error(e);
    }
    this.loaded.set(true);
  }

  async create(): Promise<void> {
    try {
      const created = await claimingOldSlug(this.confirmDialog, (take_alias) =>
        this.api.createScope({
          organization_id: this.organizationId(),
          project_id: this.projectId(),
          name: this.name.trim(),
          path_globs: splitList(this.globs),
          stacks: splitList(this.stacks),
          take_alias,
          ...(this.projectId() ? { repository_ids: this.repositoryIds() } : {}),
        }),
      );
      if (!created) return;
      this.notices.ok(`Created scope ${this.name.trim()}`);
      this.name = this.globs = this.stacks = '';
      this.repositoryIds.set([]);
      this.adding.set(false);
      await this.load(this.organizationId(), this.projectId());
    } catch (e) {
      this.notices.error(e);
    }
  }
}
