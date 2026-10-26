import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import type { SearchHit } from '../core/models';
import { ModeBadge } from '../shared/mode';
import { Notices } from '../shared/notice';
import { Session } from '../core/session';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

@Component({
  selector: 'app-search',
  imports: [FormsModule, RouterLink, ModeBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <h1>Search</h1>
    </header>
    <form class="toolbar" (ngSubmit)="run()" role="search">
      <input type="search" class="search" name="q" [(ngModel)]="q" placeholder="Search rules, terms and learnings" aria-label="Search">
      <button class="btn primary" type="submit" [disabled]="!q.trim()">Search</button>
    </form>
    @if (hits().length) {
      <ul class="hits">
        @for (h of hits(); track h.section_id) {
          <li>
            <a [routerLink]="['/documents', h.document_id]" [fragment]="'s-' + h.section_id.slice(0, 8)">{{ h.heading }}</a>
            <app-mode-badge [mode]="h.mode" />
            <p class="quiet">{{ where(h) }}, in {{ h.document_title }}</p>
            <p class="snippet" [innerHTML]="snippet(h.snippet)"></p>
          </li>
        }
      </ul>
    } @else if (searched()) {
      <p class="empty">Nothing matches “{{ searched() }}”.</p>
    }
  `,
})
export class SearchPage {
  private api = inject(Api);
  private notices = inject(Notices);
  private router = inject(Router);
  readonly hits = signal<SearchHit[]>([]);
  readonly searched = signal('');
  q = '';

  constructor() {
    const q = inject(ActivatedRoute).snapshot.queryParamMap.get('q');
    if (q) {
      this.q = q;
      void this.run();
    }
  }

  private session = inject(Session);

  where(h: SearchHit): string {
    const org = h.organization_slug ? this.session.orgs().find((o) => o.slug === h.organization_slug)?.name ?? h.organization_slug : this.session.group()?.name ?? 'Group';
    return [org, h.project_slug, h.scope_slug].filter(Boolean).join(' › ');
  }

  snippet(s: string): string {
    return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<mark>$1</mark>');
  }

  async run(): Promise<void> {
    const q = this.q.trim();
    if (!q) return;
    void this.router.navigate([], { queryParams: { q }, replaceUrl: true });
    try {
      this.hits.set(await this.api.search(q));
      this.searched.set(q);
    } catch (e) {
      this.notices.error(e);
    }
  }
}
