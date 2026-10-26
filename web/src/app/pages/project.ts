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
import { Api } from '../core/api';
import type { Graph, GraphNode, LinkRef, ProjectDetail } from '../core/models';
import { Session } from '../core/session';
import { ContextSwitch } from '../core/switch';
import { DocList } from '../shared/doc-list';
import { Notices } from '../shared/notice';
import { Icon } from '../shared/icon';
import { AgentView } from '../shared/agent-view';
import { ApiSpecs } from '../shared/api-specs';
import { ScopeList } from '../shared/scope-list';
import { SlugRenameField } from '../shared/slug-rename';

interface Connection {
  node: GraphNode;
  refs: LinkRef[];
}

type Tab = 'documents' | 'scopes' | 'apis' | 'agents' | 'connections' | 'repositories' | 'settings';
const TABS: Tab[] = [
  'documents',
  'scopes',
  'apis',
  'agents',
  'connections',
  'repositories',
  'settings',
];

@Component({
  selector: 'app-project',
  imports: [
    DocList,
    ScopeList,
    FormsModule,
    RouterLink,
    Icon,
    AgentView,
    ApiSpecs,
    SlugRenameField,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (project(); as p) {
      <header class="page-head project-head">
        <nav class="crumbs" aria-label="Breadcrumb">
          @if (session.groupShown()) {
            <a routerLink="/group">{{ session.group()?.name }}</a>
          }
          <a routerLink="/organization" (click)="openOrg(p.organization.id, $event)">{{
            p.organization.name
          }}</a>
          <a routerLink="/projects">Projects</a>
        </nav>
        <div class="title-row">
          <h1>{{ p.name }}</h1>
          @if (p.archived_at) {
            <span class="flag muted">Archived</span>
          }
          <a class="btn" [routerLink]="['/map']" [queryParams]="{ focus: p.id }"
            ><app-icon name="map" />Map</a
          >
          @if (p.can_edit) {
            <a class="btn" [routerLink]="[]" [queryParams]="{ tab: 'settings' }" replaceUrl
              ><app-icon name="pencil" />Edit</a
            >
          }
        </div>
        <p class="lede">{{ p.summary || 'No summary yet.' }}</p>
        <p class="meta">
          <code>{{ p.organization.slug }}/{{ p.slug }}</code>
        </p>
        @if (!p.reviewed) {
          <div class="callout">
            <p>An agent created this project. Check the name and purpose, then mark it reviewed.</p>
            @if (p.can_edit) {
              <button class="btn primary" type="button" (click)="markReviewed()">
                Mark reviewed
              </button>
            }
          </div>
        }
      </header>

      <ol class="layer-path" aria-label="Where this project's rules sit">
        @if (session.groupShown()) {
          <li>
            <a routerLink="/group"
              ><span class="lp-kind">Group</span
              ><span class="lp-name">{{ session.group()?.name }}</span></a
            >
          </li>
        }
        <li>
          <a routerLink="/organization" (click)="openOrg(p.organization.id, $event)"
            ><span class="lp-kind">Organization</span>
            <span class="lp-name"
              ><i class="dot" [style.background]="session.orgColor(p.organization_id)"></i
              >{{ p.organization.name }}</span
            ></a
          >
        </li>
        <li class="current" aria-current="page">
          <a [routerLink]="[]" [queryParams]="{ tab: null }"
            ><span class="lp-kind">Project</span><span class="lp-name">{{ p.name }}</span></a
          >
        </li>
        <li>
          <a [routerLink]="[]" [queryParams]="{ tab: 'scopes' }"
            ><span class="lp-kind">Scopes</span>
            <span class="lp-name">{{ p.scopes.length ? scopeNames(p) : 'None yet' }}</span></a
          >
        </li>
      </ol>
      <p class="layer-hint quiet">
        Agents get the rules of every layer from left to right; the most specific wins. Documents
        here reach all of {{ p.name }}; a scope's documents reach only its part of the code.
      </p>

      <nav class="page-tabs" aria-label="Project sections">
        @for (t of tabs(); track t.key) {
          <a
            [routerLink]="[]"
            [queryParams]="{ tab: t.key === 'documents' ? null : t.key }"
            replaceUrl
            [class.active]="current() === t.key"
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
              <h2>Project documents</h2>
              <p class="quiet">
                Purpose, business logic, glossary and learnings for the whole of {{ p.name }}, in
                every repository and every part of the code. Rules for one part only belong in a
                <a [routerLink]="[]" [queryParams]="{ tab: 'scopes' }">scope</a>.
              </p>
            </div>
            <app-doc-list
              [organizationId]="p.organization_id"
              [projectId]="p.id"
              [canEdit]="p.can_edit"
            />
          }
          @case ('scopes') {
            <div class="panel-head">
              <h2>Scopes</h2>
              <p class="quiet">
                Parts of the project with their own rules: one or more of its repositories, folders
                in them, or a stack. A rule in the Frontend scope never reaches backend code. Open a
                scope to see and edit its documents.
              </p>
            </div>
            <app-scope-list
              [organizationId]="p.organization_id"
              [projectId]="p.id"
              [canEdit]="p.can_edit"
              [repositories]="p.repositories"
              (repositoryAdded)="reload()"
              emptyText="No scopes yet. Add one per part with its own conventions, such as Frontend (the Angular repository, or frontend/** in a monorepo) and API (src/Api/**)."
            />
          }
          @case ('apis') {
            <div class="panel-head">
              <h2>API</h2>
              <p class="quiet">
                OpenAPI or Swagger specs for {{ p.name }}'s endpoints and DTOs. Agents look them up
                with <code>get_api</code>, both here and in every project that links to
                {{ p.name }}, so they call the API with the right shapes instead of guessing.
              </p>
            </div>
            <app-api-specs
              [projectId]="p.id"
              [specs]="p.apis"
              [canEdit]="p.can_edit"
              (changed)="reload()"
            />
          }
          @case ('agents') {
            <div class="panel-head">
              <h2>What agents see</h2>
              <p class="quiet">
                The exact context an agent gets when it works in {{ p.name }}, layer by layer,
                general first. Pick a part of the code to check that its rules, and only its rules,
                reach it.
              </p>
            </div>
            <app-agent-view [project]="p.id" [scopes]="p.scopes" />
          }
          @case ('connections') {
            <div class="panel-head panel-head-row">
              <div>
                <h2>Connections</h2>
                <p class="quiet">
                  From [[links]] in documents anywhere you can read. Agents get these as related
                  projects.
                </p>
              </div>
              <a class="btn sm" [routerLink]="['/map']" [queryParams]="{ focus: p.id }"
                ><app-icon name="map" [size]="14" />Open on the map</a
              >
            </div>
            <div class="two-col">
              <div class="conn-card">
                <h3>
                  Uses or refers to <span class="tab-count">{{ uses().length }}</span>
                </h3>
                @for (c of uses(); track c.node.id) {
                  <p class="conn">
                    @if (c.node.restricted) {
                      <span>{{ c.node.label }}</span>
                    } @else {
                      <a [routerLink]="linkFor(c.node)">{{ c.node.label }}</a>
                    }
                    @if (c.node.type === 'term') {
                      <span class="chip">Term</span>
                    }
                    @if (c.node.organization_id && c.node.organization_id !== p.organization_id) {
                      <span class="chip">{{ session.orgName(c.node.organization_id) }}</span>
                    }
                    @if (c.node.restricted) {
                      <span class="flag muted">No access</span>
                    }
                    <span class="quiet">in {{ refsText(c.refs) }}</span>
                  </p>
                } @empty {
                  <p class="empty">
                    Nothing yet. Link another project with [[its-slug]] in a document here.
                  </p>
                }
              </div>
              <div class="conn-card">
                <h3>
                  Referenced by <span class="tab-count">{{ usedBy().length }}</span>
                </h3>
                @for (c of usedBy(); track c.node.id) {
                  <p class="conn">
                    <a [routerLink]="linkFor(c.node)">{{ c.node.label }}</a>
                    @if (c.node.organization_id && c.node.organization_id !== p.organization_id) {
                      <span class="chip">{{ session.orgName(c.node.organization_id) }}</span>
                    }
                    <span class="quiet">in {{ refsText(c.refs) }}</span>
                  </p>
                } @empty {
                  <p class="empty">No other project links here yet.</p>
                }
              </div>
            </div>
          }
          @case ('repositories') {
            <div class="panel-head">
              <h2>Repositories</h2>
              <p class="quiet">
                Agents find this project from any of these git remotes. HTTPS and SSH URLs for the
                same repository are treated as one.
              </p>
            </div>
            @if (p.repositories.length) {
              <ul class="repo-list">
                @for (r of p.repositories; track r.id) {
                  <li>
                    <app-icon name="branch" /><code>{{ r.remote_key }}</code>
                    @if (p.can_edit) {
                      <button class="link-btn danger" type="button" (click)="removeRepo(r.id)">
                        Remove
                      </button>
                    }
                  </li>
                }
              </ul>
            } @else {
              <p class="empty">
                No repositories mapped. Agents in an unknown repository ask the user and register it
                here.
              </p>
            }
            @if (p.can_edit) {
              <form class="inline-form" (ngSubmit)="addRepo()">
                <label class="grow"
                  >Git remote URL
                  <input
                    name="remote"
                    class="mono"
                    [(ngModel)]="remote"
                    placeholder="git@ssh.dev.azure.com:v3/org/project/repo"
                /></label>
                <div class="form-actions">
                  <button class="btn" type="submit" [disabled]="!remote.trim()">
                    <app-icon name="plus" />Add repository
                  </button>
                </div>
              </form>
            }
            <details class="snippet">
              <summary>Pin a repository to this project</summary>
              <p class="quiet">
                Optional. Put this file in the repository root to skip remote matching, for example
                in forks or mirrors.
              </p>
              <pre><code>// .agentcontext.json
{{ agentContext() }}</code></pre>
            </details>
          }
          @case ('settings') {
            <div class="panel-head">
              <h2>Project details</h2>
              <p class="quiet">
                The summary is shown in lists and to agents looking at related projects.
              </p>
            </div>
            <form class="inline-form settings-form" (ngSubmit)="save()">
              <label class="grow"
                >Name <input name="name" [(ngModel)]="draft.name" required
              /></label>
              <label class="full"
                >Summary <textarea name="summary" rows="3" [(ngModel)]="draft.summary"></textarea>
              </label>
              @if (movableTo().length) {
                <label class="full"
                  >Organization
                  <select name="org" [(ngModel)]="draft.organization_id">
                    <option [value]="p.organization_id">{{ p.organization.name }}</option>
                    @for (o of movableTo(); track o.id) {
                      <option [value]="o.id">Move to {{ o.name }}</option>
                    }
                  </select>
                </label>
              }
              <div class="form-actions full">
                <button class="btn primary" type="submit">Save</button>
                <button class="btn" type="button" (click)="resetDraft()">Reset</button>
              </div>
            </form>
            <section class="slug-section">
              <app-slug-rename
                kind="project"
                [id]="p.id"
                [slug]="p.slug"
                [name]="p.name"
                [aliases]="p.aliases"
                [prefix]="p.organization.slug + '/'"
                (changed)="reload()"
              />
            </section>
            <section class="danger-zone">
              <h2>Archive or delete</h2>
              <p class="quiet">
                Archived projects stay readable but are hidden from lists and the map. Deleting
                removes every document, scope and learning in the project.
              </p>
              <div class="form-actions">
                <button class="btn" type="button" (click)="toggleArchive()">
                  {{ p.archived_at ? 'Restore project' : 'Archive project' }}
                </button>
                <button class="btn danger" type="button" (click)="remove()">Delete project</button>
              </div>
            </section>
          }
        }
      </div>
    } @else if (missing()) {
      <p class="empty">
        That project doesn't exist or you can't read it. <a routerLink="/projects">See projects</a>
      </p>
    }
  `,
})
export class ProjectPage {
  readonly id = input.required<string>();
  /** From the ?tab= query parameter. */
  readonly tab = input<string | undefined>();
  readonly session = inject(Session);
  private api = inject(Api);
  private router = inject(Router);
  private notices = inject(Notices);
  private switcher = inject(ContextSwitch);
  readonly project = signal<ProjectDetail | null>(null);
  readonly missing = signal(false);
  readonly graph = signal<Graph>({ nodes: [], edges: [], organizations: [] });
  draft = { name: '', summary: '', organization_id: '' };
  remote = '';

  readonly agentContext = computed(() => {
    const p = this.project();
    return JSON.stringify({ project: p ? `${p.organization.slug}/${p.slug}` : '' }, null, 2);
  });
  readonly movableTo = computed(() => {
    const p = this.project();
    if (!p) return [];
    return this.session
      .orgs()
      .filter((o) => o.id !== p.organization_id && this.session.canEdit(o.id));
  });
  private connections(dir: 'out' | 'in'): Connection[] {
    const p = this.project();
    if (!p) return [];
    const self = `project:${p.id}`;
    const nodes = new Map(this.graph().nodes.map((n) => [n.id, n]));
    return this.graph()
      .edges.filter(
        (e) => e.kind === 'link' && (dir === 'out' ? e.source === self : e.target === self),
      )
      .map((e) => ({ node: nodes.get(dir === 'out' ? e.target : e.source)!, refs: e.refs }))
      .filter((c) => c.node);
  }
  readonly uses = computed(() => this.connections('out'));
  readonly usedBy = computed(() => this.connections('in'));

  readonly current = computed<Tab>(() => {
    const t = this.tab() as Tab | undefined;
    if (!t || !TABS.includes(t)) return 'documents';
    if (t === 'settings' && !this.project()?.can_edit) return 'documents';
    return t;
  });

  readonly tabs = computed(() => {
    const p = this.project();
    if (!p) return [];
    const all: Array<{ key: Tab; label: string; icon: string; count: number | null }> = [
      { key: 'documents', label: 'Documents', icon: 'file', count: p.documents.length },
      { key: 'scopes', label: 'Scopes', icon: 'layers', count: p.scopes.length },
      { key: 'apis', label: 'API', icon: 'plug', count: p.apis.length },
      { key: 'agents', label: 'What agents see', icon: 'bot', count: null },
      {
        key: 'connections',
        label: 'Connections',
        icon: 'network',
        count: this.uses().length + this.usedBy().length,
      },
      { key: 'repositories', label: 'Repositories', icon: 'branch', count: p.repositories.length },
    ];
    if (p.can_edit) all.push({ key: 'settings', label: 'Settings', icon: 'settings', count: null });
    return all;
  });

  scopeNames(p: ProjectDetail): string {
    const names = p.scopes.map((s) => s.name);
    return names.length > 3
      ? `${names.slice(0, 3).join(', ')} +${names.length - 3}`
      : names.join(', ');
  }

  constructor() {
    effect(() => void this.load(this.id()));
  }

  async openOrg(id: string, ev: Event): Promise<void> {
    ev.preventDefault();
    await this.switcher.org(id);
    await this.router.navigate(['/organization']);
  }

  reload(): void {
    const p = this.project();
    if (p) void this.load(p.id);
  }

  private async load(id: string): Promise<void> {
    try {
      const p = await this.api.project(id);
      this.project.set(p);
      this.resetDraft();
      this.missing.set(false);
      this.graph.set(await this.api.graph({ focus: p.id, depth: 1 }));
    } catch (e) {
      this.project.set(null);
      this.missing.set(true);
    }
  }

  linkFor(n: GraphNode): unknown[] {
    if (n.type === 'project') return ['/projects', n.project_id];
    if (n.type === 'term') return ['/go', 'term:' + n.label];
    return ['/organization'];
  }

  refsText(refs: LinkRef[]): string {
    return refs.map((r) => `“${r.heading}”`).join(', ');
  }

  resetDraft(): void {
    const p = this.project();
    if (p) this.draft = { name: p.name, summary: p.summary, organization_id: p.organization_id };
  }

  async save(): Promise<void> {
    try {
      const moved = this.draft.organization_id !== this.project()!.organization_id;
      const p = await this.api.updateProject(this.project()!.id, this.draft);
      this.notices.ok(
        moved ? `Moved to ${this.session.orgName(p.organization_id)}` : 'Saved project details',
      );
      await this.load(p.id);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async markReviewed(): Promise<void> {
    await this.run(
      () => this.api.updateProject(this.project()!.id, { reviewed: true }),
      'Marked reviewed',
    );
  }

  async toggleArchive(): Promise<void> {
    const archived = !this.project()!.archived_at;
    await this.run(
      () => this.api.updateProject(this.project()!.id, { archived }),
      archived ? 'Archived project' : 'Restored project',
    );
  }

  async addRepo(): Promise<void> {
    await this.run(
      () => this.api.addRepository(this.project()!.id, this.remote.trim()),
      'Added repository',
    );
    this.remote = '';
  }

  async removeRepo(id: string): Promise<void> {
    await this.run(() => this.api.deleteRepository(id), 'Removed repository');
  }

  async remove(): Promise<void> {
    const p = this.project()!;
    if (
      !confirm(
        `Delete ${p.name} with all its documents, scopes and learnings? This cannot be undone.`,
      )
    )
      return;
    try {
      await this.api.deleteProject(p.id);
      this.notices.ok(`Deleted ${p.name}`);
      await this.router.navigate(['/projects']);
    } catch (e) {
      this.notices.error(e);
    }
  }

  private async run(fn: () => Promise<unknown>, ok: string): Promise<void> {
    try {
      await fn();
      this.notices.ok(ok);
      await this.load(this.project()!.id);
    } catch (e) {
      this.notices.error(e);
    }
  }
}
