import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
} from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { Router } from '@angular/router';
import DOMPurify from 'dompurify';
import { Marked, type TokenizerAndRendererExtension } from 'marked';

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** [[target]], [[target|label]], [[project:x]], [[term:x]] → links handled by the /go route. */
const wikilink: TokenizerAndRendererExtension = {
  name: 'wikilink',
  level: 'inline',
  start: (src: string) => src.indexOf('[['),
  tokenizer(src: string) {
    const m = /^\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/.exec(src);
    if (!m) return undefined;
    return { type: 'wikilink', raw: m[0], target: m[1].trim(), label: (m[2] || '').trim() };
  },
  renderer(token) {
    const target = String(token['target']);
    const label = typeof token['label'] === 'string' ? token['label'] : '';
    const shown = label || target.replace(/^(project|term)\s*:\s*/i, '');
    const kind = /^term\s*:/i.test(target)
      ? 'term'
      : /^project\s*:/i.test(target)
        ? 'project'
        : 'any';
    return `<a class="wikilink wikilink-${kind}" href="/go/${encodeURIComponent(target)}" data-wikilink="${escapeHtml(target)}">${escapeHtml(shown)}</a>`;
  },
};

// Raw HTML in rules is shown as text: "Result<T>" must not become a tag.
const marked = new Marked({
  gfm: true,
  breaks: false,
  extensions: [wikilink],
  renderer: { html: ({ text }) => escapeHtml(text) },
});

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-wikilink'] });
}

@Component({
  selector: 'app-md',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'prose', '(click)': 'onClick($event)' },
  template: '<div [innerHTML]="html()"></div>',
})
export class MarkdownView {
  readonly text = input<string>('');
  /** Project the text belongs to, so [[Term]] prefers that project's glossary. */
  readonly fromProject = input<string | null>(null);
  /** Organization the text belongs to (null = group-wide), for resolving bare [[links]]. */
  readonly fromOrganization = input<string | null>(null);
  /** Off in agent mode, where the pages [[links]] point to aren't reachable. */
  readonly followLinks = input(true);
  private sanitizer = inject(DomSanitizer);
  private router = inject(Router);
  private el = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly html = computed(() =>
    // renderMarkdown sanitizes with DOMPurify; Angular's sanitizer would drop data-wikilink.
    // eslint-disable-next-line no-restricted-syntax
    this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(this.text())),
  );

  onClick(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a || !this.el.nativeElement.contains(a)) return;
    const target = a.getAttribute('data-wikilink');
    if (target && !this.followLinks()) {
      ev.preventDefault();
      return;
    }
    if (target && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      const queryParams: Record<string, string> = {};
      const from = this.fromProject();
      const org = this.fromOrganization();
      if (from) queryParams['from'] = from;
      if (org) queryParams['org'] = org;
      void this.router.navigate(['/go', target], { queryParams });
      return;
    }
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('http')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    }
  }
}
