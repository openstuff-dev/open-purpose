import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  inject,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { Api } from '../core/api';
import type { LinkTarget } from '../core/models';
import { Icon } from './icon';
import { MarkdownView } from './markdown';

type Format =
  | 'h2' |
  'h3' |
  'bold' |
  'italic' |
  'strike' |
  'code' |
  'link' |
  'wikilink' |
  'list-ul' |
  'list-ol' |
  'list-task' |
  'quote' |
  'code-block';

const MOD =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** Toolbar groups, separated by a divider. */
const TOOLS: { format: Format; icon: string; label: string; key?: string }[][] = [
  [
    { format: 'h2', icon: 'h2', label: 'Heading' },
    { format: 'h3', icon: 'h3', label: 'Subheading' },
  ],
  [
    { format: 'bold', icon: 'bold', label: 'Bold', key: 'B' },
    { format: 'italic', icon: 'italic', label: 'Italic', key: 'I' },
    { format: 'strike', icon: 'strike', label: 'Strikethrough' },
    { format: 'code', icon: 'code', label: 'Inline code', key: 'E' },
  ],
  [
    { format: 'link', icon: 'link', label: 'Web link', key: 'K' },
    { format: 'wikilink', icon: 'brackets', label: 'Link a project or term' },
  ],
  [
    { format: 'list-ul', icon: 'list-ul', label: 'Bulleted list' },
    { format: 'list-ol', icon: 'list-ol', label: 'Numbered list' },
    { format: 'list-task', icon: 'list-task', label: 'Checklist' },
    { format: 'quote', icon: 'quote', label: 'Quote' },
    { format: 'code-block', icon: 'code-block', label: 'Code block' },
  ],
];

const WRAP: Partial<Record<Format, string>> = { bold: '**', italic: '_', strike: '~~', code: '`' };
const PREFIX: Partial<Record<Format, string>> = {
  h2: '## ',
  h3: '### ',
  'list-ul': '- ',
  'list-task': '- [ ] ',
  quote: '> ',
};
const SHORTCUTS: Record<string, Format> = { b: 'bold', i: 'italic', e: 'code', k: 'link' };
/** Any block prefix a line may carry, so switching e.g. a quote to a heading replaces it. */
const ANY_PREFIX = /^(#{1,6} |> |- \[[ xX]\] |[-*+] |\d+\. )/;
/** A list item, for continuing the list on Enter. */
const LIST_ITEM = /^(\s*)(- \[[ xX]\] |[-*+] |(\d+)\. )(.*)$/;

/**
 * Markdown textarea with a formatting toolbar, a preview and [[link]]
 * autocomplete: type "[[" and pick a project or glossary term.
 */
@Component({
  selector: 'app-md-editor',
  imports: [Icon, MarkdownView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="editor">
      <div class="os-tab-list editor-tabs" role="tablist">
        <button
          class="os-tab"
          type="button"
          role="tab"
          [attr.aria-selected]="!preview()"
          (click)="preview.set(false)"
        >
          Write
        </button>
        <button
          class="os-tab"
          type="button"
          role="tab"
          [attr.aria-selected]="preview()"
          (click)="preview.set(true)"
        >
          Preview
        </button>
        @if (!preview()) {
          <div class="editor-toolbar" role="toolbar" aria-label="Formatting">
            @for (group of tools; track $index) {
              <span class="editor-tool-group">
                @for (t of group; track t.format) {
                  <button
                    type="button"
                    class="editor-tool"
                    [attr.aria-label]="t.label"
                    [title]="t.key ? t.label + ' (' + mod + t.key + ')' : t.label"
                    (mousedown)="$event.preventDefault()"
                    (click)="apply(t.format)"
                  >
                    <app-icon [name]="t.icon" />
                  </button>
                }
              </span>
            }
          </div>
        }
      </div>
      @if (preview()) {
        <app-md
          class="editor-preview"
          [text]="value()"
          [fromProject]="fromProject()"
          [fromOrganization]="fromOrganization()"
        />
      } @else {
        <div class="editor-field">
          <textarea
            #ta
            [rows]="rows()"
            [value]="value()"
            [attr.aria-label]="label()"
            (input)="onInput()"
            (keydown)="onKeydown($event)"
            (blur)="closeSoon()"
          ></textarea>
          @if (suggestions().length) {
            <ul class="suggest" role="listbox" aria-label="Link suggestions">
              @for (s of suggestions(); track s.type + s.value; let i = $index) {
                <li
                  role="option"
                  [attr.aria-selected]="i === active()"
                  [class.active]="i === active()"
                  (mousedown)="$event.preventDefault(); pick(s)"
                >
                  <span class="suggest-type" [attr.data-type]="s.type">{{
                    s.type === 'project' ? 'Project' : 'Term'
                  }}</span>
                  {{ s.label }}
                  @if (s.type === 'project') {
                    <code>{{ s.value }}</code>
                  }
                  <span class="suggest-where">{{ s.where }}</span>
                </li>
              }
            </ul>
          }
        </div>
        <p class="editor-hint">Markdown. Type <code>[[</code> to link a project or term.</p>
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

  readonly tools = TOOLS;
  readonly mod = MOD;
  private api = inject(Api);
  private readonly ta = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
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
    if (!list.length) {
      const shortcut =
        (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey
          ? SHORTCUTS[ev.key.toLowerCase()]
          : undefined;
      if (shortcut) {
        ev.preventDefault();
        this.apply(shortcut);
      } else if (
        ev.key === 'Enter' &&
        !ev.shiftKey &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.altKey &&
        !ev.isComposing
      ) {
        if (this.continueList()) ev.preventDefault();
      }
      return;
    }
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

  /** Applies a toolbar format to the selection, or toggles it off if already applied. */
  apply(format: Format): void {
    const el = this.ta()?.nativeElement;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end, value } = el;
    const selected = value.slice(start, end);
    const wrap = WRAP[format];
    if (wrap) {
      if (
        value.slice(start - wrap.length, start) === wrap &&
        value.slice(end, end + wrap.length) === wrap
      ) {
        this.replace(
          start - wrap.length,
          end + wrap.length,
          selected,
          start - wrap.length,
          end - wrap.length,
        );
      } else if (
        selected.length > 2 * wrap.length &&
        selected.startsWith(wrap) &&
        selected.endsWith(wrap)
      ) {
        const inner = selected.slice(wrap.length, -wrap.length);
        this.replace(start, end, inner, start, start + inner.length);
      } else {
        const inner = selected || 'text';
        this.replace(
          start,
          end,
          wrap + inner + wrap,
          start + wrap.length,
          start + wrap.length + inner.length,
        );
      }
    } else if (format === 'link') {
      const text = selected || 'link text';
      const insert = `[${text}](https://)`;
      const url = start + text.length + 3;
      this.replace(start, end, insert, url, url + 'https://'.length);
    } else if (format === 'wikilink') {
      this.replace(
        start,
        end,
        '[[' + selected,
        start + 2 + selected.length,
        start + 2 + selected.length,
      );
      this.onInput();
    } else if (format === 'code-block') {
      const from = value.lastIndexOf('\n', start - 1) + 1;
      const to =
        end > start && value[end - 1] === '\n'
          ? end - 1
          : !value.includes('\n', end)
              ? value.length
              : value.indexOf('\n', end);
      const body = value.slice(from, to);
      const fenced = /^```[^\n]*\n([\s\S]*)\n```$/.exec(body);
      const insert = fenced ? fenced[1] : '```\n' + body + '\n```';
      const caret = fenced ? from : from + 4;
      this.replace(from, to, insert, caret, caret + (fenced ? insert.length : body.length));
    } else {
      this.toggleLines(format);
    }
  }

  /**
   * Adds a block prefix (heading, list, quote) to every selected line, or removes it if all
   * have it.
   */
  private toggleLines(format: Format): void {
    const el = this.ta()?.nativeElement;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end, value } = el;
    const from = value.lastIndexOf('\n', start - 1) + 1;
    const lastEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
    const to = !value.includes('\n', lastEnd) ? value.length : value.indexOf('\n', lastEnd);
    const lines = value.slice(from, to).split('\n');
    const prefixFor = (i: number) => (format === 'list-ol' ? `${i + 1}. ` : (PREFIX[format] ?? ''));
    const has = (line: string, i: number) =>
      format === 'list-ol' ? /^\d+\. /.test(line) : line.startsWith(prefixFor(i));
    const off = lines.every((l, i) => has(l, i) || !l.trim());
    const out = lines.map((l, i) => {
      if (!l.trim() && lines.length > 1) return l;
      const bare = l.replace(ANY_PREFIX, '');
      return off ? bare : prefixFor(i) + bare;
    });
    const insert = out.join('\n');
    if (lines.length === 1) {
      // Keep the caret on the same text it was on.
      const shift = out[0].length - lines[0].length;
      this.replace(from, to, insert, Math.max(from, start + shift), Math.max(from, end + shift));
    } else {
      this.replace(from, to, insert, from, from + insert.length);
    }
  }

  /** On Enter inside a list item, starts the next item; on an empty item, ends the list. */
  private continueList(): boolean {
    const el = this.ta()?.nativeElement;
    if (!el || el.selectionStart !== el.selectionEnd) return false;
    const caret = el.selectionStart;
    const from = el.value.lastIndexOf('\n', caret - 1) + 1;
    const m = LIST_ITEM.exec(el.value.slice(from, caret));
    if (!m) return false;
    const [, indent, marker, num, rest] = m;
    if (!rest.trim()) {
      this.replace(from, caret, '', from, from);
      return true;
    }
    const next = indent + (num ? `${Number(num) + 1}. ` : marker.replace(/\[[xX]\]/, '[ ]'));
    this.replace(caret, caret, '\n' + next, caret + 1 + next.length, caret + 1 + next.length);
    return true;
  }

  /** Replaces a range, keeping the browser's undo history where it supports that. */
  private replace(
    start: number,
    end: number,
    text: string,
    selStart: number,
    selEnd: number,
  ): void {
    const el = this.ta()?.nativeElement;
    if (!el) return;
    el.focus();
    el.setSelectionRange(start, end);
    // execCommand is deprecated, but it is still the only way to edit a textarea and keep
    // the browser's undo history. setRangeText is the fallback.
    /* eslint-disable @typescript-eslint/no-deprecated */
    const done = text
      ? document.execCommand('insertText', false, text)
      : document.execCommand('delete');
    /* eslint-enable @typescript-eslint/no-deprecated */
    if (!done) el.setRangeText(text, start, end);
    el.setSelectionRange(selStart, selEnd);
    this.value.set(el.value);
  }

  closeSoon(): void {
    setTimeout(() => {
      this.close();
    }, 150);
  }

  private close(): void {
    this.query = null;
    this.suggestions.set([]);
  }
}
