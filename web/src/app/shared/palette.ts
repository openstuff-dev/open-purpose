import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, output, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import type { Project, SearchHit } from '../core/models';
import { Session } from '../core/session';
import { Icon } from './icon';

interface Item {
  group: string;
  icon: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** ⌘K: jump to a page or project, or search every rule you can read. */
@Component({
  selector: 'app-palette',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="palette-backdrop" (click)="close.emit()" (keydown.escape)="close.emit()">
      <div class="palette" role="dialog" aria-modal="true" aria-label="Go to or search" (click)="$event.stopPropagation()">
        <div class="palette-input">
          <app-icon name="search" [size]="18" />
          <input #input type="text" placeholder="Go to a page or project, or search rules…" aria-label="Search"
                 role="combobox" aria-controls="palette-list" [attr.aria-activedescendant]="'pi-' + active()"
                 [value]="query()" (input)="onInput($any($event.target).value)" (keydown)="onKey($event)">
          <kbd>Esc</kbd>
        </div>
        @if (items().length) {
          <ul class="palette-list" id="palette-list" role="listbox">
            @for (it of items(); track $index; let i = $index) {
              @if (i === 0 || items()[i - 1].group !== it.group) { <li class="palette-group" role="presentation">{{ it.group }}</li> }
              <li class="palette-item" role="option" [id]="'pi-' + i" [class.active]="i === active()" [attr.aria-selected]="i === active()"
                  (mousemove)="active.set(i)" (click)="pick(it)">
                <app-icon [name]="it.icon" />
                <span>{{ it.label }}</span>
                @if (it.hint) { <small>{{ it.hint }}</small> }
              </li>
            }
          </ul>
        } @else {
          <p class="palette-empty">{{ searching() ? 'Searching…' : 'Nothing found.' }}</p>
        }
        <div class="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span></div>
      </div>
    </div>
  `,
})
export class Palette {
  readonly close = output<void>();
  private api = inject(Api);
  private router = inject(Router);
  private session = inject(Session);
  private input = viewChild.required<ElementRef<HTMLInputElement>>('input');

  readonly query = signal('');
  readonly active = signal(0);
  readonly searching = signal(false);
  private projects = signal<Project[]>([]);
  private hits = signal<SearchHit[]>([]);
  private timer: ReturnType<typeof setTimeout> | undefined;

  private go(path: unknown[], extras: Record<string, unknown> = {}): () => void {
    return () => {
      void this.router.navigate(path, extras);
      this.close.emit();
    };
  }

  private readonly pages = computed<Item[]>(() => {
    const s = this.session;
    const pages: Item[] = [
      { group: 'Pages', icon: 'building', label: s.group()?.name ?? 'Group', hint: 'Group overview', run: this.go(['/group']) },
      ...(s.org() ? [{ group: 'Pages', icon: 'layers', label: s.org()!.name, hint: 'Organization overview', run: this.go(['/organization']) }] : []),
      { group: 'Pages', icon: 'repo', label: 'Projects', run: this.go(['/projects']) },
      { group: 'Pages', icon: 'map', label: 'Map', run: this.go(['/map']) },
      { group: 'Pages', icon: 'inbox', label: 'Inbox', run: this.go(['/inbox']) },
      { group: 'Settings', icon: 'eye', label: 'Test a repository', hint: 'What an agent gets for a git remote', run: this.go(['/settings', 'test']) },
      { group: 'Settings', icon: 'user', label: 'Account and tokens', run: this.go(['/settings', 'account']) },
      { group: 'Settings', icon: 'palette', label: 'Appearance', run: this.go(['/settings', 'appearance']) },
      { group: 'Settings', icon: 'plug', label: 'Connect an agent', run: this.go(['/settings', 'connect']) },
    ];
    if (s.canAdmin(null)) pages.push({ group: 'Settings', icon: 'building', label: 'Group and organizations', run: this.go(['/settings', 'group']) });
    if (s.adminsAnything) pages.push({ group: 'Settings', icon: 'users', label: 'People and agents', run: this.go(['/settings', 'people']) });
    if (s.isSuperadmin) pages.push({ group: 'Settings', icon: 'server', label: 'All groups', run: this.go(['/settings', 'server']) });
    return pages;
  });

  readonly items = computed<Item[]>(() => {
    const q = this.query().trim().toLowerCase();
    const match = (t: string) => !q || t.toLowerCase().includes(q);
    const pages = this.pages().filter((p) => match(p.label) || match(p.hint ?? ''));
    const projects = this.projects()
      .filter((p) => match(p.name) || match(p.slug))
      .slice(0, q ? 8 : 5)
      .map<Item>((p) => ({ group: 'Projects', icon: 'repo', label: p.name, hint: p.organization_name, run: this.go(['/projects', p.id]) }));
    const rules = this.hits().slice(0, 8).map<Item>((h) => ({
      group: 'Rules and terms', icon: 'file', label: h.heading,
      hint: [h.organization_slug ?? this.session.group()?.name, h.project_slug, h.document_title].filter(Boolean).join(' · '),
      run: this.go(['/documents', h.document_id], { fragment: 's-' + h.section_id.slice(0, 8) }),
    }));
    return [...pages.filter((p) => p.group === 'Pages'), ...projects, ...pages.filter((p) => p.group !== 'Pages'), ...rules];
  });

  constructor() {
    void this.api.projects({}).then((p) => this.projects.set(p)).catch(() => {});
    effect(() => queueMicrotask(() => this.input().nativeElement.focus()));
  }

  onInput(v: string): void {
    this.query.set(v);
    this.active.set(0);
    clearTimeout(this.timer);
    const q = v.trim();
    if (q.length < 2) {
      this.hits.set([]);
      return;
    }
    this.searching.set(true);
    this.timer = setTimeout(async () => {
      try {
        const hits = await this.api.search(q);
        if (this.query().trim() === q) this.hits.set(hits);
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
      const it = this.items()[this.active()];
      if (it) this.pick(it);
    } else if (ev.key === 'Escape') {
      this.close.emit();
    }
  }

  pick(it: Item): void {
    it.run();
  }
}
