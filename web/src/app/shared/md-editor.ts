import { ChangeDetectionStrategy, Component, ElementRef, inject, input, model, signal, viewChild } from '@angular/core';
import { Api } from '../core/api';
import type { LinkTarget } from '../core/models';
import { MarkdownView } from './markdown';

/**
 * Markdown textarea with a preview and [[link]] autocomplete:
 * type "[[" and pick a project or glossary term.
 */
@Component({
  selector: 'app-md-editor',
  imports: [MarkdownView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="editor">
      <div class="editor-tabs" role="tablist">
        <button type="button" role="tab" [attr.aria-selected]="!preview()" (click)="preview.set(false)">Write</button>
        <button type="button" role="tab" [attr.aria-selected]="preview()" (click)="preview.set(true)">Preview</button>
        <span class="editor-hint">Markdown. Type <code>[[</code> to link a project or term.</span>
      </div>
      @if (preview()) {
        <app-md class="editor-preview" [text]="value()" [fromProject]="fromProject()" [fromOrganization]="fromOrganization()" />
      } @else {
        <div class="editor-field">
          <textarea #ta [rows]="rows()" [value]="value()" [attr.aria-label]="label()"
            (input)="onInput()" (keydown)="onKeydown($event)" (blur)="closeSoon()"></textarea>
          @if (suggestions().length) {
            <ul class="suggest" role="listbox" aria-label="Link suggestions">
              @for (s of suggestions(); track s.type + s.value; let i = $index) {
                <li role="option" [attr.aria-selected]="i === active()" [class.active]="i === active()"
                    (mousedown)="$event.preventDefault(); pick(s)">
                  <span class="suggest-type" [attr.data-type]="s.type">{{ s.type === 'project' ? 'Project' : 'Term' }}</span>
                  {{ s.label }}
                  @if (s.type === 'project') { <code>{{ s.value }}</code> }
                  <span class="suggest-where">{{ s.where }}</span>
                </li>
              }
            </ul>
          }
        </div>
      }
    </div>
  `,
})
export class MarkdownEditor {
  readonly value = model<string>('');
  readonly rows = input(8);
  readonly label = input('Markdown');
  readonly fromProject = input<string | null>(null);
  readonly fromOrganization = input<string | null>(null);

  private api = inject(Api);
  private ta = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
  readonly preview = signal(false);
  readonly suggestions = signal<LinkTarget[]>([]);
  readonly active = signal(0);
  private query: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  onInput(): void {
    const el = this.ta()?.nativeElement;
    if (!el) return;
    this.value.set(el.value);
    const before = el.value.slice(0, el.selectionStart);
    const m = /\[\[([^\[\]\n|]*)$/.exec(before);
    if (!m) {
      this.close();
      return;
    }
    this.query = m[1];
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const q = this.query;
      if (q === null) return;
      const results = await this.api.linkTargets(q.replace(/^(project|term)\s*:\s*/i, ''));
      if (this.query === q) {
        this.suggestions.set(results);
        this.active.set(0);
      }
    }, 120);
  }

  onKeydown(ev: KeyboardEvent): void {
    const list = this.suggestions();
    if (!list.length) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      this.active.set((this.active() + 1) % list.length);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      this.active.set((this.active() - 1 + list.length) % list.length);
    } else if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault();
      this.pick(list[this.active()]);
    } else if (ev.key === 'Escape') {
      this.close();
    }
  }

  pick(s: LinkTarget): void {
    const el = this.ta()?.nativeElement;
    if (!el) return;
    const caret = el.selectionStart;
    const before = el.value.slice(0, caret);
    const start = before.lastIndexOf('[[');
    const after = el.value.slice(caret).replace(/^[^\[\]\n|]*\]\]/, '');
    const insert = `[[${s.type === 'term' ? 'term:' : ''}${s.value}]]`;
    el.value = el.value.slice(0, start) + insert + after;
    const pos = start + insert.length;
    el.setSelectionRange(pos, pos);
    el.focus();
    this.value.set(el.value);
    this.close();
  }

  closeSoon(): void {
    setTimeout(() => this.close(), 150);
  }

  private close(): void {
    this.query = null;
    this.suggestions.set([]);
  }
}
