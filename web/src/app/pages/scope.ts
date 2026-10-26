import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import type { ScopeDetail } from '../core/models';
import { Session } from '../core/session';
import { DocList } from '../shared/doc-list';
import { Notices } from '../shared/notice';
import { splitList } from '../shared/scope-list';
import { SlugRenameField } from '../shared/slug-rename';

@Component({
  selector: 'app-scope',
  imports: [DocList, FormsModule, RouterLink, SlugRenameField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (scope(); as s) {
      <header class="page-head">
        <nav class="crumbs" aria-label="Breadcrumb">
          <a routerLink="/group">{{ session.group()?.name }}</a>
          @if (s.organization; as o) { <a routerLink="/organization">{{ o.name }}</a> }
          @if (s.project; as p) { <a [routerLink]="['/projects', p.id]">{{ p.name }}</a> }
        </nav>
        <h1>{{ s.name }}</h1>
        <p class="lede">{{ s.description || (s.project ? 'Rules for one part of ' + s.project.name + '.' : s.organization ? 'Rules for a kind of code across ' + s.organization.name + '.' : 'Rules for a kind of code in every organization.') }}</p>
      </header>

      <section class="block">
        <h2>When this applies</h2>
        @if (editing()) {
          <form class="inline-form" (ngSubmit)="save()">
            <label class="grow">Name <input name="name" [(ngModel)]="draft.name" required></label>
            <label class="full">Description <input name="description" [(ngModel)]="draft.description"></label>
            <label class="full">Paths <input name="globs" class="mono" [(ngModel)]="draft.globs" placeholder="frontend/**"></label>
            <label class="full">Stacks <input name="stacks" [(ngModel)]="draft.stacks" placeholder="angular"></label>
            <div class="form-actions full">
              <button class="btn primary" type="submit">Save</button>
              <button class="btn" type="button" (click)="editing.set(false)">Cancel</button>
            </div>
          </form>
        } @else {
          <dl class="facts">
            <dt>Paths</dt>
            <dd>@for (g of s.path_globs; track g) { <code class="chip path">{{ g }}</code> } @empty { <span class="quiet">Any path</span> }</dd>
            <dt>Stacks</dt>
            <dd>@for (t of s.stacks; track t) { <span class="chip stack">{{ t }}</span> } @empty { <span class="quiet">Any stack</span> }</dd>
          </dl>
          <p class="quiet">Applies when an agent works on a file matching any path, or in code whose manifest has any of these stacks.</p>
          @if (s.can_edit) {
            <div class="form-actions">
              <button class="btn" type="button" (click)="startEdit()">Edit matching</button>
              <button class="btn danger" type="button" (click)="remove()">Delete scope</button>
            </div>
          }
        }
        <app-slug-rename kind="scope" [id]="s.id" [slug]="s.slug" [name]="s.name" [aliases]="s.aliases"
          [canEdit]="s.can_edit" (changed)="reload()" />
      </section>

      <section class="block">
        <h2>Documents</h2>
        <app-doc-list [organizationId]="s.organization_id" [projectId]="s.project_id" [scopeId]="s.id" [canEdit]="s.can_edit"
          emptyText="No documents yet. Approved learnings for this scope will appear in a Learnings document here." />
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

  constructor() {
    effect(() => void this.load(this.id()));
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
    this.draft = { name: s.name, description: s.description, globs: s.path_globs.join(', '), stacks: s.stacks.join(', ') };
    this.editing.set(true);
  }

  async save(): Promise<void> {
    try {
      await this.api.updateScope(this.id(), {
        name: this.draft.name, description: this.draft.description,
        path_globs: splitList(this.draft.globs), stacks: splitList(this.draft.stacks),
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
      await this.router.navigate(s.project ? ['/projects', s.project.id] : s.organization ? ['/organization'] : ['/group']);
    } catch (e) {
      this.notices.error(e);
    }
  }
}
