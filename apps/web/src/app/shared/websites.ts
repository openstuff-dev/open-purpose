import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  Injector,
  input,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Badge, Button, Control, Field } from '@openstuff-dev/ui-angular';
import type { Website } from '../core/models';
import { Icon } from './icon';

/** Labels offered while typing; any other text works too. */
const LABELS = ['Staging', 'Production', 'Development', 'Public', 'Docs'];

/** The URL as people read it: no https://, no trailing slash. */
function shown(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * The websites of a project or organization, under its page header: a link icon, the link and
 * its label as a badge. Editors add, edit and remove them in place; the buttons on a row show
 * when it is hovered or focused, and always on touch screens.
 */
@Component({
  selector: 'app-websites',
  imports: [FormsModule, NgTemplateOutlet, Icon, Badge, Button, Field, Control],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (websites().length || canEdit()) {
      <div class="websites">
        @if (websites().length) {
          <ul class="website-list" aria-label="Websites">
            @for (w of websites(); track $index; let i = $index) {
              @if (editing() === i) {
                <li>
                  <ng-container *ngTemplateOutlet="form" />
                </li>
              } @else {
                <li class="website">
                  <a [href]="w.url" target="_blank" rel="noopener noreferrer" class="website-link"
                    ><app-icon name="link" [size]="14" />{{ shown(w.url) }}</a
                  >
                  @if (w.label) {
                    <span os-badge>{{ w.label }}</span>
                  }
                  @if (canEdit()) {
                    <span class="row-actions">
                      <button
                        os-button
                        variant="link"
                        size="sm"
                        type="button"
                        [attr.aria-label]="'Edit ' + name(w)"
                        (click)="edit(i)"
                      >
                        Edit
                      </button>
                      <button
                        os-button
                        variant="link"
                        size="sm"
                        tone="danger"
                        type="button"
                        [attr.aria-label]="'Remove ' + name(w)"
                        [disabled]="busy()"
                        (click)="remove(i)"
                      >
                        Remove
                      </button>
                    </span>
                  }
                </li>
              }
            }
          </ul>
        }
        @if (editing() === 'new') {
          <ng-container *ngTemplateOutlet="form" />
        } @else if (canEdit() && editing() === null) {
          <button os-button size="sm" type="button" class="website-add" (click)="edit('new')">
            <app-icon name="plus" [size]="14" />Add website
          </button>
        }
      </div>
    }

    <ng-template #form>
      <form class="website-form" (ngSubmit)="submit()" (keydown.escape)="cancel()">
        <os-field label="Label">
          <input
            os-input
            name="label"
            maxlength="40"
            placeholder="Staging"
            autocomplete="off"
            [attr.list]="listId"
            [(ngModel)]="draft.label"
          />
        </os-field>
        <datalist [id]="listId">
          @for (l of labels; track l) {
            <option [value]="l"></option>
          }
        </datalist>
        <os-field label="URL" class="grow">
          <input
            os-input
            name="url"
            type="url"
            required
            class="mono"
            placeholder="https://staging.example.com"
            [(ngModel)]="draft.url"
          />
        </os-field>
        <div class="form-actions">
          <button
            os-button
            variant="primary"
            type="submit"
            [disabled]="busy() || !draft.url.trim()"
          >
            Save
          </button>
          <button os-button type="button" (click)="cancel()">Cancel</button>
        </div>
      </form>
    </ng-template>
  `,
})
export class Websites {
  readonly websites = input.required<Website[]>();
  readonly canEdit = input(false);
  /** Saves the whole new list; resolves true when it was saved. */
  readonly save = input.required<(websites: Website[]) => Promise<boolean>>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  /** Index of the row being edited, 'new' while adding, null otherwise. */
  readonly editing = signal<number | 'new' | null>(null);
  readonly busy = signal(false);
  readonly labels = LABELS;
  readonly listId = `website-labels-${Math.random().toString(36).slice(2, 8)}`;
  readonly shown = shown;
  draft: Website = { label: '', url: '' };

  name(w: Website): string {
    return w.label || shown(w.url);
  }

  edit(at: number | 'new'): void {
    this.draft = at === 'new' ? { label: '', url: '' } : { ...this.websites()[at] };
    this.editing.set(at);
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLInputElement>('.website-form input')?.focus(),
      { injector: this.injector },
    );
  }

  cancel(): void {
    this.editing.set(null);
  }

  async submit(): Promise<void> {
    const at = this.editing();
    if (at === null) return;
    const w = { label: this.draft.label.trim(), url: this.draft.url.trim() };
    const list = [...this.websites()];
    if (at === 'new') list.push(w);
    else list[at] = w;
    if (await this.store(list)) this.editing.set(null);
  }

  async remove(at: number): Promise<void> {
    await this.store(this.websites().filter((_, i) => i !== at));
  }

  private async store(list: Website[]): Promise<boolean> {
    this.busy.set(true);
    try {
      return await this.save()(list);
    } finally {
      this.busy.set(false);
    }
  }
}
