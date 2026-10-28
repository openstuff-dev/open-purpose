import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** Line diff via longest common subsequence. Fine for section-sized text. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: a[i++] });
    } else {
      out.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

@Component({
  selector: 'app-diff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="diff" role="table" aria-label="Changes">
      @for (l of lines(); track $index) {
        <div class="diff-line" [attr.data-type]="l.type" role="row">
          <span class="diff-sign" aria-hidden="true">{{
            l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''
          }}</span>
          <span class="sr-only">{{
            l.type === 'add' ? 'Added:' : l.type === 'del' ? 'Removed:' : ''
          }}</span>
          <span class="diff-text" role="cell">{{ l.text || ' ' }}</span>
        </div>
      }
    </div>
  `,
})
export class DiffView {
  readonly before = input('');
  readonly after = input('');
  readonly lines = computed(() => diffLines(this.before(), this.after()));
}
