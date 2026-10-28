import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { DOC_KINDS, KIND_LABEL, type Doc, type DocKind, type EditMode } from '../core/models';
import { Session } from '../core/session';
import { ModeBadge } from './mode';
import { Icon } from './icon';
import { DatePipe } from '@angular/common';
import { Badge, Button, Control, Field, EmptyState } from '@openstuff-dev/ui-angular';

const GLYPH: Record<DocKind, string> = {
  purpose: 'book',
  business_logic: 'layers',
  glossary: 'link',
  guidelines: 'file',
  reference: 'grid',
  learnings: 'bot',
};
import { Notices } from './notice';

const KIND_HINT: Record<DocKind, string> = {
  purpose: 'Why this exists and what good looks like.',
  business_logic: 'Rules of the business that code must respect.',
  glossary: 'Terms. Each section is one term others can [[link]] to.',
  guidelines: 'How to build: conventions, patterns, do and don’t.',
  reference: 'Background material agents can consult.',
  learnings: 'Approved lessons from corrections.',
};

/** Documents at one level (organization, project or scope), with a form to add one. */
@Component({
  selector: 'app-doc-list',
  imports: [
    RouterLink,
    FormsModule,
    ModeBadge,
    Icon,
    DatePipe,
    Button,
    Field,
    Control,
    Badge,
    EmptyState,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (docs().length) {
      <ul class="doc-list">
        @for (d of docs(); track d.id) {
          <li [class.disabled]="d.disabled_at">
            <a [routerLink]="['/documents', d.id]">
              <span class="doc-glyph" [attr.data-kind]="d.kind"
                ><app-icon [name]="glyph[d.kind]"
              /></span>
              <span class="doc-name">
                <span class="doc-title">{{ d.title }}</span>
                <span class="doc-kind">{{ kindLabel[d.kind] }}</span>
              </span>
              @if (d.disabled_at) {
                <span os-badge title="Agents don't get this document">Disabled</span>
              } @else if (d.staleness) {
                <span
                  os-badge
                  tone="warning"
                  title="Agents haven't requested it. Consider disabling it."
                  >Not requested in a {{ d.staleness }}</span
                >
              }
              <span class="doc-count">Updated {{ d.updated_at | date: 'd MMM' }}</span>
              <app-mode-badge [mode]="d.mode" />
            </a>
          </li>
        }
      </ul>
    } @else if (loaded()) {
      <os-empty-state [title]="emptyTitle()" bordered>{{ emptyText() }}</os-empty-state>
    }
    @if (canEdit()) {
      @if (adding()) {
        <form class="inline-form" (ngSubmit)="create()">
          <os-field label="Type"
            ><select os-select name="kind" [(ngModel)]="kind" (ngModelChange)="suggestTitle()">
              @for (k of kinds; track k) {
                <option [value]="k">{{ kindLabel[k] }}</option>
              }
            </select></os-field
          >
          <os-field label="Title" class="grow"
            ><input os-input name="title" [(ngModel)]="title" required
          /></os-field>
          <p class="quiet full">{{ hint[kind] }}</p>
          <div class="form-actions full">
            <button os-button variant="primary" type="submit" [disabled]="!title.trim()">
              Create document
            </button>
            <button os-button type="button" (click)="adding.set(false)">Cancel</button>
          </div>
        </form>
      } @else {
        <button os-button type="button" (click)="adding.set(true); suggestTitle()">
          <app-icon name="plus" />New document
        </button>
      }
    }
  `,
})
export class DocList {
  /** null = group-wide. */
  readonly organizationId = input<string | null>(null);
  readonly projectId = input<string | null>(null);
  readonly scopeId = input<string | null>(null);
  readonly canEdit = input(false);
  readonly emptyTitle = input('No documents yet');
  /** A sentence under the title, such as what to add first. */
  readonly emptyText = input('');
  readonly session = inject(Session);
  private api = inject(Api);
  private router = inject(Router);
  private notices = inject(Notices);
  readonly docs = signal<Doc[]>([]);
  readonly loaded = signal(false);
  readonly adding = signal(false);
  readonly kinds = DOC_KINDS;
  readonly kindLabel = KIND_LABEL;
  readonly hint = KIND_HINT;
  readonly glyph = GLYPH;
  kind: DocKind = 'guidelines';
  title = '';

  constructor() {
    effect(() => {
      void this.load({
        organization_id: this.organizationId(),
        project_id: this.projectId(),
        scope_id: this.scopeId(),
      });
    });
  }

  private async load(level: {
    organization_id: string | null;
    project_id: string | null;
    scope_id: string | null;
  }): Promise<void> {
    try {
      this.docs.set(await this.api.documents(level));
    } catch (e) {
      this.notices.error(e);
    }
    this.loaded.set(true);
  }

  suggestTitle(): void {
    if (!this.title.trim() || Object.values(KIND_LABEL).includes(this.title))
      this.title = KIND_LABEL[this.kind];
  }

  async create(): Promise<void> {
    const mode: EditMode = this.kind === 'purpose' ? 'locked' : 'propose';
    try {
      const doc = await this.api.createDocument({
        organization_id: this.organizationId(),
        project_id: this.projectId(),
        scope_id: this.scopeId(),
        kind: this.kind,
        title: this.title.trim(),
        mode,
      });
      this.notices.ok(`Created ${doc.title}`);
      await this.router.navigate(['/documents', doc.id]);
    } catch (e) {
      this.notices.error(e);
    }
  }
}
