import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  Breadcrumbs,
  Button,
  Chip,
  ConfirmDialog,
  Control,
  EmptyState,
  Field,
} from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { Repository, ScopeDetail } from '../core/models';
import { Session, provideHere } from '../core/session';
import { AgentView } from '../shared/agent-view';
import { DocList } from '../shared/doc-list';
import { Notices } from '../shared/notice';
import { Icon } from '../shared/icon';
import { RepoPicker } from '../shared/repo-picker';
import { repoName, splitList } from '../shared/scope-list';
import { PageSkeleton } from '../shared/list-skeleton';
import { SlugRenameField } from '../shared/slug-rename';

type Tab = 'documents' | 'agents' | 'settings';
const TABS: Tab[] = ['documents', 'agents', 'settings'];

@Component({
  selector: 'app-scope',
  imports: [
    PageSkeleton,
    Breadcrumbs,
    EmptyState,
    AgentView,
    DocList,
    FormsModule,
    RouterLink,
    SlugRenameField,
    Icon,
    RepoPicker,
    Button,
    Field,
    Control,
    Chip,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (scope(); as s) {
      <header class="os-page-header project-head" data-align="start">
        <div>
          <nav os-breadcrumbs>
            <ol>
              @if (session.groupShown()) {
                <li>
                  <a routerLink="/workspace">{{ session.group()?.name }}</a>
                </li>
              }
              @if (s.organization; as o) {
                <li>
                  <a routerLink="/organization">{{ o.name }}</a>
                </li>
              }
              @if (s.project; as p) {
                <li>
                  <a [routerLink]="['/projects', p.id]" [queryParams]="{ tab: 'scopes' }">{{
                    p.name
                  }}</a>
                </li>
              }
            </ol>
          </nav>
          <h1 class="os-page-title">{{ s.name }}</h1>
          <p class="os-page-description">{{ s.description || fallback(s) }}</p>
          <p class="meta">
            <code>{{ fullSlug(s) }}</code>
          </p>
        </div>
        <div class="os-page-actions">
          @if (s.project; as p) {
            <a os-button [routerLink]="['/map']" [queryParams]="{ focus: p.id }"
              ><app-icon name="map" />Map</a
            >
          }
          @if (s.can_edit) {
            <a os-button [routerLink]="[]" [queryParams]="{ tab: 'settings' }" replaceUrl
              ><app-icon name="pencil" />Edit</a
            >
          }
        </div>
      </header>

      <ol class="layer-path" aria-label="Where this scope's rules sit">
        @if (session.groupShown()) {
          <li>
            <a routerLink="/workspace"
              ><span class="lp-kind">Workspace</span
              ><span class="lp-name">{{ session.group()?.name }}</span></a
            >
          </li>
        }
        @if (s.organization; as o) {
          <li>
            <a routerLink="/organization"
              ><span class="lp-kind">Organization</span>
              <span class="lp-name"
                ><i class="dot" [style.background]="session.orgColor(o.id)"></i>{{ o.name }}</span
              ></a
            >
          </li>
        }
        @if (s.project; as p) {
          <li>
            <a [routerLink]="['/projects', p.id]"
              ><span class="lp-kind">Project</span><span class="lp-name">{{ p.name }}</span></a
            >
          </li>
        }
        <li class="current" aria-current="page">
          <a [routerLink]="[]" [queryParams]="{ tab: null }"
            ><span class="lp-kind">Scope</span><span class="lp-name">{{ s.name }}</span></a
          >
        </li>
      </ol>

      <dl class="scope-applies" aria-label="When this scope applies">
        @if (s.project) {
          <div>
            <dt><app-icon name="branch" [size]="13" />Repositories</dt>
            <dd>
              @for (r of boundRepos(s); track r.id) {
                <span os-chip tone="brand" class="mono" [title]="r.remote_key">{{
                  repoName(r.remote_key)
                }}</span>
              } @empty {
                <span class="quiet">Any of {{ s.project.name }}'s</span>
              }
            </dd>
          </div>
        }
        <div>
          <dt><app-icon name="file" [size]="13" />Paths</dt>
          <dd>
            @for (g of s.path_globs; track g) {
              <code os-chip tone="brand">{{ g }}</code>
            } @empty {
              <span class="quiet">Any path</span>
            }
          </dd>
        </div>
        <div>
          <dt><app-icon name="layers" [size]="13" />Stacks</dt>
          <dd>
            @for (t of s.stacks; track t) {
              <span os-chip>{{ t }}</span>
            } @empty {
              <span class="quiet">Any stack</span>
            }
          </dd>
        </div>
      </dl>
      <p class="layer-hint quiet">
        {{ explain(s) }} Agents get the rules of every layer from left to right; the most specific
        wins.
      </p>

      <nav class="os-tab-list page-tabs" aria-label="Scope sections">
        @for (t of tabs(); track t.key) {
          <a
            class="os-tab"
            [routerLink]="[]"
            [queryParams]="{ tab: t.key === 'documents' ? null : t.key }"
            replaceUrl
            [attr.aria-current]="current() === t.key ? 'page' : null"
          >
            <app-icon [name]="t.icon" [size]="15" />{{ t.label }}
            @if (t.count !== null) {
              <span class="tab-count">{{ t.count }}</span>
            }
          </a>
        }
      </nav>

      <div class="tab-panel">
        @switch (current()) {
          @case ('documents') {
            <div class="panel-head">
              <h2>Scope documents</h2>
              <p class="quiet">
                Rules that reach only this part of the code, after the
                {{
                  s.project ? s.project.name : s.organization ? s.organization.name : 'workspace'
                }}
                rules. Approved learnings filed under {{ s.name }} land here too.
              </p>
            </div>
            <app-doc-list
              [organizationId]="s.organization_id"
              [projectId]="s.project_id"
              [scopeId]="s.id"
              [canEdit]="s.can_edit"
              [items]="s.documents"
              emptyText="Approved learnings for this scope will appear in a Learnings document here."
            />
          }
          @case ('agents') {
            @if (s.project; as p) {
              <div class="panel-head">
                <h2>What agents see</h2>
                <p class="quiet">
                  The exact context an agent gets when it works in {{ s.name }}, layer by layer,
                  general first. Switch to another part of {{ p.name }} to compare.
                </p>
              </div>
              <app-agent-view [project]="p.id" [scopes]="[s]" [initial]="s.id" />
            }
          }
          @case ('settings') {
            <div class="panel-head">
              <h2>Scope details</h2>
              <p class="quiet">
                The name and description show on the project page and to agents. Paths and stacks
                decide which code gets this scope's documents.
              </p>
            </div>
            <form class="inline-form settings-form" (ngSubmit)="save()">
              <os-field label="Name" class="grow"
                ><input os-input name="name" [(ngModel)]="draft.name" required
              /></os-field>
              <os-field label="Description" class="full">
                <textarea
                  os-textarea
                  name="description"
                  rows="3"
                  [(ngModel)]="draft.description"
                ></textarea>
              </os-field>
              @if (s.project; as p) {
                <app-repo-picker
                  class="full"
                  [projectId]="p.id"
                  [(repositories)]="repos"
                  [(selected)]="repositoryIds"
                />
              }
              <os-field label="Paths" class="full"
                ><input
                  os-input
                  name="globs"
                  class="mono"
                  [(ngModel)]="draft.globs"
                  placeholder="frontend/**"
              /></os-field>
              <os-field label="Stacks" class="full"
                ><input os-input name="stacks" [(ngModel)]="draft.stacks" placeholder="angular"
              /></os-field>
              <div class="form-actions full">
                <button os-button variant="primary" type="submit">Save</button>
                <button os-button type="button" (click)="resetDraft()">Reset</button>
              </div>
            </form>
            <section class="slug-section">
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
            <section class="danger-zone">
              <h2>Delete scope</h2>
              <p class="quiet">Deletes its documents and learnings too.</p>
              <div class="form-actions">
                <button os-button variant="danger" type="button" (click)="remove()">
                  Delete scope
                </button>
              </div>
            </section>
          }
        }
      </div>
    } @else if (failed()) {
      <os-empty-state title="Scope not found" level="1">
        That scope doesn't exist or you can't read it.
        <a os-button os-actions routerLink="/projects">See projects</a>
      </os-empty-state>
    } @else {
      <app-page-skeleton />
    }
  `,
})
export class ScopePage {
  readonly id = input.required<string>();
  /** From the ?tab= query parameter. */
  readonly tab = input<string | undefined>();
  readonly session = inject(Session);
  private readonly confirmDialog = inject(ConfirmDialog);
  private api = inject(Api);
  private router = inject(Router);
  private notices = inject(Notices);
  readonly scope = signal<ScopeDetail | null>(null);
  readonly failed = signal(false);
  draft = { name: '', description: '', globs: '', stacks: '' };
  readonly repos = signal<Repository[]>([]);
  readonly repositoryIds = signal<string[]>([]);
  readonly repoName = repoName;

  readonly current = computed<Tab>(() => {
    const t = this.tab() as Tab | undefined;
    const s = this.scope();
    if (!t || !TABS.includes(t)) return 'documents';
    if (t === 'settings' && !s?.can_edit) return 'documents';
    if (t === 'agents' && !s?.project) return 'documents';
    return t;
  });

  readonly tabs = computed(() => {
    const s = this.scope();
    if (!s) return [];
    const all: { key: Tab; label: string; icon: string; count: number | null }[] = [
      { key: 'documents', label: 'Documents', icon: 'file', count: s.documents.length },
    ];
    if (s.project) all.push({ key: 'agents', label: 'What agents see', icon: 'bot', count: null });
    if (s.can_edit) all.push({ key: 'settings', label: 'Settings', icon: 'settings', count: null });
    return all;
  });

  constructor() {
    effect(() => void this.load(this.id()));
    provideHere(() => {
      const x = this.scope();
      return x ? { project: x.project, organization: x.organization } : null;
    });
  }

  boundRepos(s: ScopeDetail): Repository[] {
    return s.repositories.filter((r) => s.repository_ids.includes(r.id));
  }

  fallback(s: ScopeDetail): string {
    if (s.project) return 'Rules for one part of ' + s.project.name + '.';
    if (s.organization) return 'Rules for a kind of code across ' + s.organization.name + '.';
    return 'Rules for a kind of code in every organization.';
  }

  /** "openstuff/open-purpose/web", as far up as the scope reaches. */
  fullSlug(s: ScopeDetail): string {
    return [s.organization?.slug, s.project?.slug, s.slug].filter(Boolean).join('/');
  }

  explain(s: ScopeDetail): string {
    const bound = s.repository_ids.length > 0;
    const narrowed = s.path_globs.length > 0 || s.stacks.length > 0;
    if (bound && !narrowed) return 'Applies to everything an agent does in these repositories.';
    if (bound)
      return 'Applies inside these repositories when an agent works on a file matching any path, or in code whose manifest has any of these stacks.';
    return 'Applies when an agent works on a file matching any path, or in code whose manifest has any of these stacks.';
  }

  reload(): void {
    void this.load(this.id());
  }

  private async load(id: string): Promise<void> {
    try {
      const s = await this.api.scope(id);
      const old = this.scope();
      // Keep what someone is typing in Settings when the scope loads again.
      const edited =
        old?.id === s.id &&
        (this.draft.name !== old.name ||
          this.draft.description !== old.description ||
          this.draft.globs !== old.path_globs.join(', ') ||
          this.draft.stacks !== old.stacks.join(', '));
      this.scope.set(s);
      this.failed.set(false);
      if (!edited) this.resetDraft();
    } catch (e) {
      this.failed.set(true);
      this.notices.error(e);
    }
  }

  resetDraft(): void {
    const s = this.scope();
    if (!s) return;
    this.draft = {
      name: s.name,
      description: s.description,
      globs: s.path_globs.join(', '),
      stacks: s.stacks.join(', '),
    };
    this.repos.set(s.repositories);
    this.repositoryIds.set(s.repository_ids);
  }

  async save(): Promise<void> {
    const s = this.scope();
    if (!s) return;
    try {
      await this.api.updateScope(this.id(), {
        name: this.draft.name,
        description: this.draft.description,
        path_globs: splitList(this.draft.globs),
        stacks: splitList(this.draft.stacks),
        ...(s.project ? { repository_ids: this.repositoryIds() } : {}),
      });
      this.notices.ok('Saved scope');
      await this.load(this.id());
      this.resetDraft();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async remove(): Promise<void> {
    const s = this.scope();
    if (!s) return;
    const remove = await this.confirmDialog.confirm({
      title: `Delete the ${s.name} scope?`,
      message: 'Its documents and learnings are deleted too.',
      confirmLabel: 'Delete scope',
      danger: true,
    });
    if (!remove) return;
    try {
      await this.api.deleteScope(s.id);
      this.notices.ok(`Deleted ${s.name}`);
      await this.router.navigate(
        s.project ? ['/projects', s.project.id] : s.organization ? ['/organization'] : ['/workspace'],
        s.project ? { queryParams: { tab: 'scopes' } } : {},
      );
    } catch (e) {
      this.notices.error(e);
    }
  }
}
