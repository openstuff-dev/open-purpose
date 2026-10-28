import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Button } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { Repository, ScopeDetail } from '../core/models';
import { Session, provideHere } from '../core/session';
import { DocList } from '../shared/doc-list';
import { Notices } from '../shared/notice';
import { Icon } from '../shared/icon';
import { RepoPicker } from '../shared/repo-picker';
import { repoName, splitList } from '../shared/scope-list';
import { SlugRenameField } from '../shared/slug-rename';

@Component({
  selector: 'app-scope',
  imports: [DocList, FormsModule, RouterLink, SlugRenameField, Icon, RepoPicker, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (scope(); as s) {
      <header class="page-head">
        <nav class="crumbs" aria-label="Breadcrumb">
          @if (session.groupShown()) {
            <a routerLink="/group">{{ session.group()?.name }}</a>
          }
          @if (s.organization; as o) {
            <a routerLink="/organization">{{ o.name }}</a>
          }
          @if (s.project; as p) {
            <a [routerLink]="['/projects', p.id]">{{ p.name }}</a>
          }
        </nav>
        <h1>{{ s.name }}</h1>
        <p class="lede">
          {{
            s.description ||
              (s.project
                ? 'Rules for one part of ' + s.project.name + '.'
                : s.organization
                  ? 'Rules for a kind of code across ' + s.organization.name + '.'
                  : 'Rules for a kind of code in every organization.')
          }}
        </p>
      </header>

      <section class="block">
        <h2>When this applies</h2>
        @if (editing()) {
          <form class="inline-form" (ngSubmit)="save()">
            <label class="grow">Name <input name="name" [(ngModel)]="draft.name" required /></label>
            <label class="full"
              >Description
              <textarea name="description" rows="3" [(ngModel)]="draft.description"></textarea>
            </label>
            @if (s.project; as p) {
              <app-repo-picker
                class="full"
                [projectId]="p.id"
                [(repositories)]="repos"
                [(selected)]="repositoryIds"
              />
            }
            <label class="full"
              >Paths
              <input name="globs" class="mono" [(ngModel)]="draft.globs" placeholder="frontend/**"
            /></label>
            <label class="full"
              >Stacks <input name="stacks" [(ngModel)]="draft.stacks" placeholder="angular"
            /></label>
            <div class="form-actions full">
              <button os-button variant="primary" type="submit">Save</button>
              <button os-button type="button" (click)="editing.set(false)">Cancel</button>
            </div>
          </form>
        } @else {
          <dl class="facts">
            @if (s.project) {
              <dt>Repositories</dt>
              <dd>
                @for (r of boundRepos(s); track r.id) {
                  <span class="chip repo" [title]="r.remote_key"
                    ><app-icon name="branch" [size]="11" />{{ repoName(r.remote_key) }}</span
                  >
                } @empty {
                  <span class="quiet">Any of {{ s.project.name }}'s repositories</span>
                }
              </dd>
            }
            <dt>Paths</dt>
            <dd>
              @for (g of s.path_globs; track g) {
                <code class="chip path">{{ g }}</code>
              } @empty {
                <span class="quiet">Any path</span>
              }
            </dd>
            <dt>Stacks</dt>
            <dd>
              @for (t of s.stacks; track t) {
                <span class="chip stack">{{ t }}</span>
              } @empty {
                <span class="quiet">Any stack</span>
              }
            </dd>
          </dl>
          <p class="quiet">{{ explain(s) }}</p>
          @if (s.can_edit) {
            <div class="form-actions">
              <button os-button type="button" (click)="startEdit()">Edit matching</button>
              <button os-button variant="danger" type="button" (click)="remove()">
                Delete scope
              </button>
            </div>
          }
        }
        <app-slug-rename
          kind="scope"
          [id]="s.id"
          [slug]="s.slug"
          [name]="s.name"
          [aliases]="s.aliases"
          [canEdit]="s.can_edit"
          (changed)="reload()"
        />
      </section>

      <section class="block">
        <h2>Documents</h2>
        <app-doc-list
          [organizationId]="s.organization_id"
          [projectId]="s.project_id"
          [scopeId]="s.id"
          [canEdit]="s.can_edit"
          emptyText="No documents yet. Approved learnings for this scope will appear in a Learnings document here."
        />
      </section>
    }
  `,
})
export class ScopePage {
  readonly id = input.required<string>();
  readonly session = inject(Session);
  private api = inject(Api);
  private router = inject(Router);
  private notices = inject(Notices);
  readonly scope = signal<ScopeDetail | null>(null);
  readonly editing = signal(false);
  draft = { name: '', description: '', globs: '', stacks: '' };
  readonly repos = signal<Repository[]>([]);
  readonly repositoryIds = signal<string[]>([]);
  readonly repoName = repoName;

  boundRepos(s: ScopeDetail): Repository[] {
    return s.repositories.filter((r) => s.repository_ids.includes(r.id));
  }

  explain(s: ScopeDetail): string {
    const bound = s.repository_ids.length > 0;
    const narrowed = s.path_globs.length > 0 || s.stacks.length > 0;
    if (bound && !narrowed) return 'Applies to everything an agent does in these repositories.';
    if (bound)
      return 'Applies inside these repositories when an agent works on a file matching any path, or in code whose manifest has any of these stacks.';
    return 'Applies when an agent works on a file matching any path, or in code whose manifest has any of these stacks.';
  }

  constructor() {
    effect(() => void this.load(this.id()));
    provideHere(() => {
      const x = this.scope();
      return x ? { project: x.project, organization: x.organization } : null;
    });
  }

  reload(): void {
    void this.load(this.id());
  }

  private async load(id: string): Promise<void> {
    try {
      this.scope.set(await this.api.scope(id));
    } catch (e) {
      this.notices.error(e);
    }
  }

  startEdit(): void {
    const s = this.scope()!;
    this.draft = {
      name: s.name,
      description: s.description,
      globs: s.path_globs.join(', '),
      stacks: s.stacks.join(', '),
    };
    this.repos.set(s.repositories);
    this.repositoryIds.set(s.repository_ids);
    this.editing.set(true);
  }

  async save(): Promise<void> {
    try {
      await this.api.updateScope(this.id(), {
        name: this.draft.name,
        description: this.draft.description,
        path_globs: splitList(this.draft.globs),
        stacks: splitList(this.draft.stacks),
        ...(this.scope()!.project ? { repository_ids: this.repositoryIds() } : {}),
      });
      this.editing.set(false);
      this.notices.ok('Saved scope');
      await this.load(this.id());
    } catch (e) {
      this.notices.error(e);
    }
  }

  async remove(): Promise<void> {
    const s = this.scope()!;
    if (!confirm(`Delete the ${s.name} scope and its documents and learnings?`)) return;
    try {
      await this.api.deleteScope(s.id);
      this.notices.ok(`Deleted ${s.name}`);
      await this.router.navigate(
        s.project ? ['/projects', s.project.id] : s.organization ? ['/organization'] : ['/group'],
      );
    } catch (e) {
      this.notices.error(e);
    }
  }
}
