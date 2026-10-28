import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Button } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { SlugAlias, SlugKind, SlugRename, SlugRenameRef } from '../core/models';
import { aliasConflict, errorMessage } from '../core/session';
import { Notices } from './notice';

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * Shows a slug, what depends on it, and a rename that previews every link,
 * repository and agent it touches before anything changes. The old slug stays
 * as an alias until someone removes it.
 */
@Component({
  selector: 'app-slug-rename',
  imports: [FormsModule, RouterLink, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="slug-field">
      <div class="slug-current">
        <span class="slug-label">Slug</span>
        <code>{{ prefix() }}{{ slug() }}</code>
        @if (canEdit() && !open()) {
          <button os-button size="sm" type="button" (click)="start()">Rename slug…</button>
        }
      </div>
      <p class="quiet">{{ usedFor() }}</p>

      @if (open()) {
        <form class="slug-rename" (ngSubmit)="apply()">
          <label
            >New slug
            <input
              name="newslug"
              class="mono"
              [ngModel]="draft()"
              (ngModelChange)="onDraft($event)"
              autocomplete="off"
              spellcheck="false"
              required
              aria-describedby="slug-impact"
            />
          </label>
          <div id="slug-impact" aria-live="polite">
            @if (error()) {
              <p class="field-error">{{ error() }}</p>
            } @else if (checking()) {
              <p class="quiet">
                Checking what uses <code>{{ slug() }}</code
                >…
              </p>
            } @else if (preview(); as r) {
              @if (r.alias_of; as other) {
                <div class="callout danger">
                  <p>
                    <strong
                      ><code>{{ r.to }}</code> is the old slug of {{ other.name }}</strong
                    >
                    (now <code>{{ other.slug }}</code
                    >). Repositories, agents and links that still use <code>{{ r.to }}</code> reach
                    {{ other.name }} today. Renaming sends them here instead.
                  </p>
                  <label class="check"
                    ><input type="checkbox" name="take" [(ngModel)]="take" /> Take
                    <code>{{ r.to }}</code> from {{ other.name }}</label
                  >
                </div>
              }
              <div class="callout warn">
                <p>
                  <strong
                    >What changes when <code>{{ r.from }}</code> becomes
                    <code>{{ r.to }}</code></strong
                  >
                </p>
                <ul class="impact">
                  @if (r.rewrite.length) {
                    <li>
                      @if (rewrite) {
                        Updates {{ linkCount(r.rewrite) }} in {{ sections(r.rewrite) }}. Each change
                        is kept in the section's history.
                      } @else {
                        {{ linkCount(r.rewrite) }} in {{ sections(r.rewrite) }} keep the old slug.
                      }
                      <details>
                        <summary>Show sections</summary>
                        <ul>
                          @for (x of r.rewrite; track x.section_id) {
                            <li>
                              <a [routerLink]="['/documents', x.document_id]"
                                >{{ x.location }} › {{ x.document_title }} › {{ x.heading }}</a
                              >
                            </li>
                          }
                        </ul>
                      </details>
                    </li>
                  }
                  @if (r.cannot_edit.length) {
                    <li>
                      {{ sections(r.cannot_edit) }} you can't edit still say
                      <code>{{ r.from }}</code
                      >. They keep working through the old slug.
                      <details>
                        <summary>Show sections</summary>
                        <ul>
                          @for (x of r.cannot_edit; track x.section_id) {
                            <li>
                              <a [routerLink]="['/documents', x.document_id]"
                                >{{ x.location }} › {{ x.document_title }} › {{ x.heading }}</a
                              >
                            </li>
                          }
                        </ul>
                      </details>
                    </li>
                  }
                  @if (kind() !== 'scope' && !r.rewrite.length && !r.cannot_edit.length) {
                    <li>
                      No links you can read use <code>{{ r.from }}</code
                      >.
                    </li>
                  }
                  @if (r.repositories) {
                    <li>
                      {{ plural(r.repositories, 'repository', 'repositories') }} may have
                      <code>.openpurpose.json</code> naming <code>{{ r.from }}</code
                      >. They keep working, and agents there are told to switch to
                      <code>{{ r.to }}</code
                      >.
                    </li>
                  }
                  @if (r.open_proposals) {
                    <li>
                      {{ plural(r.open_proposals, 'open proposal') }} mention
                      <code>{{ r.from }}</code
                      >. They aren't changed.
                    </li>
                  }
                  @if (kind() === 'scope') {
                    <li>
                      Agents that ask for <code>{{ r.from }}</code> still get this scope, and are
                      told the new slug.
                    </li>
                  }
                  <li>
                    <code>{{ r.from }}</code> stays as an old slug, so nothing breaks. Remove it
                    below once nothing uses it.
                  </li>
                </ul>
                @if (r.rewrite.length) {
                  <label class="check"
                    ><input type="checkbox" name="rewrite" [(ngModel)]="rewrite" /> Update links I
                    can edit</label
                  >
                }
              </div>
            }
          </div>
          <div class="form-actions">
            <button os-button variant="primary" type="submit" [disabled]="!ready()">
              Rename to {{ preview()?.to ?? '…' }}
            </button>
            <button os-button type="button" (click)="cancel()">Cancel</button>
          </div>
        </form>
      }

      @if (aliases().length) {
        <div class="alias-list">
          <span class="quiet">Also answers to</span>
          @for (a of aliases(); track a.id) {
            <span class="chip"
              ><code>{{ a.old_slug }}</code>
              @if (canEdit()) {
                <button
                  type="button"
                  class="chip-x"
                  (click)="removeAlias(a)"
                  [attr.aria-label]="'Remove old slug ' + a.old_slug"
                >
                  ×
                </button>
              }
            </span>
          }
        </div>
      }
    </div>
  `,
})
export class SlugRenameField {
  readonly kind = input.required<SlugKind>();
  readonly id = input.required<string>();
  readonly slug = input.required<string>();
  readonly name = input.required<string>();
  readonly aliases = input<SlugAlias[]>([]);
  /** Shown before the slug, e.g. "logistics/" for a project. */
  readonly prefix = input('');
  readonly canEdit = input(true);
  /** After a rename or a removed alias: reload. */
  readonly changed = output<void>();

  private api = inject(Api);
  private notices = inject(Notices);

  readonly open = signal(false);
  readonly draft = signal('');
  readonly preview = signal<SlugRename | null>(null);
  readonly checking = signal(false);
  readonly error = signal<string | null>(null);
  rewrite = true;
  take = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;

  readonly plural = plural;

  readonly usedFor = computed(() => {
    const s = this.slug();
    switch (this.kind()) {
      case 'project':
        return `People and agents use it in [[${this.prefix()}${s}]] links, in .openpurpose.json files in repositories, and to ask for this project.`;
      case 'organization':
        return `It's the first part of links to this organization's projects, like [[${s}/project]], and of every .openpurpose.json that names one of them.`;
      default:
        return `Agents use it to ask for this scope explicitly and to file learnings under it.`;
    }
  });

  linkCount(refs: SlugRenameRef[]): string {
    return plural(
      refs.reduce((n, r) => n + r.links, 0),
      'link',
    );
  }

  sections(refs: SlugRenameRef[]): string {
    return plural(refs.length, 'section');
  }

  ready(): boolean {
    const r = this.preview();
    return !!r && !this.checking() && !this.error() && (!r.alias_of || this.take);
  }

  start(): void {
    this.open.set(true);
    this.draft.set('');
    this.preview.set(null);
    this.error.set(null);
    this.rewrite = true;
    this.take = false;
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.seq++;
    this.open.set(false);
  }

  onDraft(value: string): void {
    this.draft.set(value);
    this.preview.set(null);
    this.error.set(null);
    this.take = false;
    clearTimeout(this.timer);
    const slug = value.trim().toLowerCase();
    if (!slug || slug === this.slug()) {
      this.checking.set(false);
      return;
    }
    this.checking.set(true);
    const seq = ++this.seq;
    this.timer = setTimeout(async () => {
      try {
        const r = await this.api.renameSlug(this.kind(), this.id(), { slug, dry_run: true });
        if (seq === this.seq) this.preview.set(r);
      } catch (e) {
        if (seq === this.seq) this.error.set(errorMessage(e));
      } finally {
        if (seq === this.seq) this.checking.set(false);
      }
    }, 300);
  }

  async apply(): Promise<void> {
    const r = this.preview();
    if (!r || !this.ready()) return;
    try {
      const done = await this.api.renameSlug(this.kind(), this.id(), {
        slug: r.to,
        rewrite_links: this.rewrite,
        take_alias: this.take || undefined,
      });
      const updated = done.rewrite.length ? ` and updated ${this.linkCount(done.rewrite)}` : '';
      this.notices.ok(`Renamed ${done.from} to ${done.to}${updated}`);
      this.open.set(false);
      this.changed.emit();
    } catch (e) {
      // Someone took the slug, or made it an old slug, since the preview.
      if (aliasConflict(e)) void this.onDraft(this.draft());
      this.notices.error(e);
    }
  }

  async removeAlias(a: SlugAlias): Promise<void> {
    if (
      !confirm(
        `Remove the old slug "${a.old_slug}"? Repositories, agents and [[links]] that still use it stop finding ${this.name()}.`,
      )
    )
      return;
    try {
      await this.api.deleteAlias(a.id);
      this.notices.ok(`Removed ${a.old_slug}`);
      this.changed.emit();
    } catch (e) {
      this.notices.error(e);
    }
  }
}
