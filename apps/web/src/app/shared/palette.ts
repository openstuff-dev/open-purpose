import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { Dialog } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { EditMode, Project, ProjectDetail, SearchHit } from '../core/models';
import { Session } from '../core/session';
import { Icon } from './icon';
import { ModeIcon } from './mode';

interface Item {
  group: string;
  icon: string;
  label: string;
  hint?: string;
  /** Search hits: the matching words, ** marks the hits. */
  snippet?: string;
  mode?: EditMode;
  run: () => void;
}

/** Shown before "Show more"; the server returns up to 20. */
const FIRST_HITS = 12;

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * ⌘K: jump to a page or project, or search every rule you can read. What is in
 * the project (or organization) on screen comes first, and Tab narrows to it.
 */
@Component({
  selector: 'app-palette',
  imports: [Icon, ModeIcon, Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- The toolkit's dialog and command-palette look; the search and grouping stay ours. -->
    <dialog
      os-dialog
      class="os-command-palette palette"
      aria-label="Go to or search"
      [open]="true"
      (openChange)="$event || closed.emit()"
    >
      <div class="os-command-search palette-input">
        <app-icon name="search" [size]="18" />
        <input
          #input
          type="text"
          placeholder="Go to a page or project, or search rules…"
          aria-label="Search"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          [attr.aria-activedescendant]="'pi-' + active()"
          [value]="query()"
          (input)="onInput($any($event.target).value)"
          (keydown)="onKey($event)"
        />
        @if (near(); as n) {
          <button
            type="button"
            class="palette-scope"
            [attr.aria-pressed]="narrow()"
            [attr.aria-label]="
              narrow()
                ? 'Searching ' + n.label + ' only. Search everywhere'
                : 'Searching everywhere. Search ' + n.label + ' only'
            "
            (click)="toggleNarrow()"
          >
            @if (narrow()) {
              <app-icon [name]="n.icon" [size]="13" />{{ n.label }}
            } @else {
              Everywhere
            }
          </button>
        }
        <kbd>Esc</kbd>
      </div>
      @if (items().length) {
        <ul class="os-command-list palette-list" id="palette-list" role="listbox">
          @for (it of items(); track $index; let i = $index) {
            @if (i === 0 || items()[i - 1].group !== it.group) {
              <li class="os-command-group-label" role="presentation">{{ it.group }}</li>
            }
            <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -- the search box moves through options with the arrow keys and Enter -->
            <li
              class="os-command-item"
              role="option"
              [id]="'pi-' + i"
              [attr.aria-selected]="i === active()"
              (mousemove)="active.set(i)"
              (click)="pick(it)"
            >
              <app-icon [name]="it.icon" />
              @if (it.snippet !== undefined) {
                <span class="palette-text">
                  <span
                    >{{ it.label }}
                    @if (it.mode && it.mode !== 'open') {
                      <app-mode-icon [mode]="it.mode" />
                    }
                  </span>
                  <span class="palette-snippet" [innerHTML]="marked(it.snippet)"></span>
                </span>
              } @else {
                <span>{{ it.label }}</span>
              }
              @if (it.hint) {
                <small class="os-command-hint">{{ it.hint }}</small>
              }
            </li>
          }
        </ul>
      } @else {
        <p class="os-command-empty">{{ searching() ? 'Searching…' : 'Nothing found.' }}</p>
      }
      <div class="palette-foot">
        <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span>
        @if (near(); as n) {
          <span
            ><kbd>Tab</kbd>
            {{ narrow() ? 'to search everywhere' : 'to search ' + n.label + ' only' }}</span
          >
        }
      </div>
    </dialog>
  `,
})
export class Palette {
  readonly closed = output();
  private api = inject(Api);
  private router = inject(Router);
  private session = inject(Session);
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');

  readonly query = signal('');
  readonly active = signal(0);
  readonly searching = signal(false);
  /** Search only the project or organization on screen. */
  readonly narrow = signal(false);
  private readonly more = signal(false);
  private readonly projects = signal<Project[]>([]);
  private readonly hits = signal<SearchHit[]>([]);
  /** The scopes and documents of the project on screen. */
  private readonly local = signal<ProjectDetail | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** The project on screen, else its (or the current) organization. */
  private readonly here = computed(() => {
    const h = this.session.here();
    const org = h?.organization ?? (h?.project ? null : this.session.org());
    return { project: h?.project ?? null, organization: org };
  });

  /** What Tab narrows to: the project, or the organization when there are others to leave out. */
  readonly near = computed(() => {
    const { project, organization } = this.here();
    if (project)
      return { kind: 'project' as const, id: project.id, label: project.name, icon: 'repo' };
    if (organization && this.session.groupShown())
      return {
        kind: 'organization' as const,
        id: organization.id,
        label: organization.name,
        icon: 'layers',
      };
    return null;
  });

  private go(path: unknown[], extras: Record<string, unknown> = {}): () => void {
    return () => {
      void this.router.navigate(path, extras);
      this.closed.emit();
    };
  }

  private readonly pages = computed<Item[]>(() => {
    const s = this.session;
    const org = s.org();
    // A group with one organization is just that organization: no group page to go to.
    const pages: Item[] = [
      ...(s.groupShown()
        ? [
            {
              group: 'Pages',
              icon: 'building',
              label: s.group()?.name ?? 'Group',
              hint: 'Group overview',
              run: this.go(['/group']),
            },
          ]
        : []),
      ...(org
        ? [
            {
              group: 'Pages',
              icon: 'layers',
              label: org.name,
              hint: 'Organization overview',
              run: this.go(['/organization']),
            },
          ]
        : []),
      { group: 'Pages', icon: 'repo', label: 'Projects', run: this.go(['/projects']) },
      { group: 'Pages', icon: 'map', label: 'Map', run: this.go(['/map']) },
      { group: 'Pages', icon: 'inbox', label: 'Inbox', run: this.go(['/inbox']) },
      {
        group: 'Settings',
        icon: 'eye',
        label: 'Test a repository',
        hint: 'What an agent gets for a git remote',
        run: this.go(['/settings', 'test']),
      },
      {
        group: 'Settings',
        icon: 'user',
        label: 'Account and tokens',
        run: this.go(['/settings', 'account']),
      },
      {
        group: 'Settings',
        icon: 'palette',
        label: 'Appearance',
        run: this.go(['/settings', 'appearance']),
      },
      {
        group: 'Settings',
        icon: 'plug',
        label: 'Connect an agent',
        run: this.go(['/settings', 'connect']),
      },
    ];
    if (s.canAdmin(null))
      pages.push({
        group: 'Settings',
        icon: 'building',
        label: s.groupShown() ? 'Group and organizations' : 'Organizations',
        run: this.go(['/settings', 'group']),
      });
    if (s.adminsAnything)
      pages.push({
        group: 'Settings',
        icon: 'users',
        label: 'People and agents',
        run: this.go(['/settings', 'people']),
      });
    if (s.isSuperadmin)
      pages.push({
        group: 'Settings',
        icon: 'server',
        label: 'All groups',
        run: this.go(['/settings', 'server']),
      });
    return pages;
  });

  readonly items = computed<Item[]>(() => {
    const q = this.query().trim().toLowerCase();
    const match = (t: string) => !q || t.toLowerCase().includes(q);
    const { project: hereProject, organization: hereOrg } = this.here();
    const narrow = this.narrow() ? this.near() : null;

    const local = this.local();
    const inProject: Item[] = local
      ? [
          ...local.scopes.map<Item>((sc) => ({
            group: 'In ' + local.name,
            icon: 'grid',
            label: sc.name,
            hint: 'Scope',
            run: this.go(['/scopes', sc.id]),
          })),
          ...local.documents.map<Item>((d) => ({
            group: 'In ' + local.name,
            icon: 'file',
            label: d.title,
            hint: 'Document',
            run: this.go(['/documents', d.id]),
          })),
        ]
          .filter((it) => match(it.label))
          .slice(0, q ? 6 : 4)
      : [];

    const pages = narrow ? [] : this.pages().filter((p) => match(p.label) || match(p.hint ?? ''));
    const orgId = narrow?.kind === 'organization' ? narrow.id : hereOrg?.id;
    const projects =
      narrow?.kind === 'project'
        ? []
        : this.projects()
            .filter((p) => narrow?.kind !== 'organization' || p.organization_id === narrow.id)
            .filter((p) => p.id !== hereProject?.id && (match(p.name) || match(p.slug)))
            // The organization on screen first; sort is stable, so the server's order stays
            // within each.
            .sort((a, b) => +(b.organization_id === orgId) - +(a.organization_id === orgId))
            .slice(0, q ? 8 : 5)
            .map<Item>((p) => ({
              group: 'Projects',
              icon: 'repo',
              label: p.name,
              hint: p.organization_name,
              run: this.go(['/projects', p.id]),
            }));

    const where = (h: SearchHit): string => {
      if (h.project_id === hereProject?.id) return `In ${hereProject.name}`;
      if (h.organization_id === hereOrg?.id) return `In ${hereOrg.name}`;
      return hereProject || hereOrg ? 'Elsewhere' : 'Rules and terms';
    };
    const order = (g: string) => (g === 'Elsewhere' ? 2 : hereOrg && g === `In ${hereOrg.name}` ? 1 : 0);
    const all = this.hits();
    const shown = this.more() ? all : all.slice(0, FIRST_HITS);
    const rules = shown
      .map<Item>((h) => ({
        group: where(h),
        icon: 'file',
        label: h.heading,
        snippet: h.snippet,
        mode: h.mode,
        hint: [h.organization_slug ?? this.session.group()?.name, h.project_slug, h.document_title]
          .filter(Boolean)
          .join(' · '),
        run: this.go(['/documents', h.document_id], { fragment: 's-' + h.section_id.slice(0, 8) }),
      }))
      .sort((a, b) => order(a.group) - order(b.group));
    if (all.length > shown.length)
      rules.push({
        group: rules[rules.length - 1].group,
        icon: 'plus',
        label: `Show ${all.length - shown.length} more`,
        run: () => { this.more.set(true); },
      });

    return [
      ...inProject,
      ...pages.filter((p) => p.group === 'Pages'),
      ...projects,
      ...pages.filter((p) => p.group !== 'Pages'),
      ...rules,
    ];
  });

  marked(snippet: string): string {
    return escapeHtml(snippet).replace(/\*\*(.+?)\*\*/g, '<mark>$1</mark>');
  }

  constructor() {
    void this.api
      .projects({})
      .then((p) => {
        this.projects.set(p);
      })
      .catch(() => undefined);
    const project = untracked(this.here).project;
    if (project)
      void this.api
        .project(project.id)
        .then((p) => {
          this.local.set(p);
        })
        .catch(() => undefined);
    effect(() => {
      queueMicrotask(() => {
        this.input().nativeElement.focus();
      });
    });
    const start = untracked(this.session.palette);
    if (start) this.onInput(start);
  }

  onInput(v: string): void {
    this.query.set(v);
    this.search();
  }

  toggleNarrow(): void {
    this.narrow.set(!this.narrow());
    this.search();
    this.input().nativeElement.focus();
  }

  private search(): void {
    this.active.set(0);
    this.more.set(false);
    clearTimeout(this.timer);
    const q = this.query().trim();
    if (q.length < 2) {
      this.hits.set([]);
      return;
    }
    const { project, organization } = this.here();
    const near = {
      near_project_id: project?.id,
      near_organization_id: project ? undefined : organization?.id,
      within: this.narrow() ? this.near()?.kind : undefined,
    };
    this.searching.set(true);
    this.timer = setTimeout(async () => {
      try {
        const hits = await this.api.search(q, near);
        if (this.query().trim() === q && this.narrow() === !!near.within) this.hits.set(hits);
      } catch {
        this.hits.set([]);
      }
      this.searching.set(false);
    }, 180);
  }

  onKey(ev: KeyboardEvent): void {
    const n = this.items().length;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      this.active.set(n ? (this.active() + 1) % n : 0);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      this.active.set(n ? (this.active() - 1 + n) % n : 0);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const it = this.items().at(this.active());
      if (it) this.pick(it);
    } else if (ev.key === 'Tab' && this.near()) {
      ev.preventDefault();
      this.toggleNarrow();
    }
  }

  pick(it: Item): void {
    it.run();
  }
}
