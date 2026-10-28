import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Button, Control, Field } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { ReviewComment, ReviewThread } from '../core/models';
import { diffLines } from './diff';
import { Icon } from './icon';
import { MarkdownView } from './markdown';
import { Notices } from './notice';

interface Row {
  type: 'same' | 'add' | 'del';
  text: string;
  oldNo: number | null;
  /** Line number in the current text; only these lines can be commented on. */
  newNo: number | null;
}

/** One conversation: comments, suggestions with "Apply", reply box, resolve. */
@Component({
  selector: 'app-thread',
  imports: [FormsModule, DatePipe, Icon, MarkdownView, Button, Control],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="thread"
      [class.resolved]="thread().resolved_at"
      [class.outdated]="thread().outdated"
    >
      @if (thread().resolved_at && collapsed()) {
        <button type="button" class="thread-collapsed" (click)="collapsed.set(false)">
          <app-icon name="check" [size]="13" /> Resolved by
          {{ thread().resolved_by_name ?? 'someone' }} · {{ thread().comments.length }}
          {{ thread().comments.length === 1 ? 'comment' : 'comments' }}
          <span class="quiet">Show</span>
        </button>
      } @else {
        @if (showAnchor() && thread().anchor) {
          <div class="thread-anchor">
            <span class="quiet"
              >{{ thread().outdated ? 'Outdated · originally on' : '' }} lines
              {{ thread().line_start }}–{{ thread().line_end }}</span
            >
            <pre><code>{{ thread().anchor }}</code></pre>
          </div>
        }
        @for (c of thread().comments; track c.id) {
          <div class="comment">
            <span class="comment-avatar" [attr.data-kind]="c.actor_kind"
              ><app-icon [name]="c.actor_kind === 'agent' ? 'bot' : 'user'" [size]="13"
            /></span>
            <div class="comment-main">
              <div class="comment-head">
                <strong>{{ c.actor_name ?? 'Unknown' }}</strong>
                @if (c.actor_kind === 'agent') {
                  <span class="chip">Agent</span>
                }
                <span class="quiet" [title]="c.created_at | date: 'd MMM y, HH:mm'">{{
                  c.created_at | date: 'd MMM, HH:mm'
                }}</span>
              </div>
              @if (c.body) {
                <app-md class="comment-body" [text]="c.body" />
              }
              @if (c.suggestion !== null) {
                <div class="suggestion">
                  <div class="suggestion-head">
                    <span><app-icon name="pencil" [size]="12" /> Suggested change</span>
                    @if (c.applied_at) {
                      <span class="applied"
                        ><app-icon name="check" [size]="12" />Applied by
                        {{ c.applied_by_name ?? 'someone' }}</span
                      >
                    } @else if (canRevise() && !thread().outdated) {
                      <button
                        os-button
                        variant="primary"
                        size="sm"
                        type="button"
                        (click)="apply(c)"
                      >
                        Apply suggestion
                      </button>
                    } @else if (thread().outdated) {
                      <span class="quiet">The lines changed since</span>
                    }
                  </div>
                  <div class="diff">
                    @for (l of suggestionDiff(c); track $index) {
                      <div class="diff-line" [attr.data-type]="l.type">
                        <span class="diff-sign">{{
                          l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''
                        }}</span
                        ><span>{{ l.text || ' ' }}</span>
                      </div>
                    }
                  </div>
                </div>
              }
            </div>
          </div>
        }
        <div class="thread-foot">
          @if (replying()) {
            <form class="reply" (ngSubmit)="reply()">
              <textarea
                os-textarea
                name="reply"
                rows="3"
                [(ngModel)]="replyText"
                placeholder="Reply… (Markdown)"
                aria-label="Reply"
                (keydown.control.enter)="reply()"
                (keydown.meta.enter)="reply()"
              ></textarea>
              <div class="form-actions">
                <button
                  os-button
                  variant="primary"
                  size="sm"
                  type="submit"
                  [disabled]="!replyText.trim()"
                >
                  Reply
                </button>
                <button os-button size="sm" type="button" (click)="replying.set(false)">
                  Cancel
                </button>
              </div>
            </form>
          } @else {
            @if (canComment()) {
              <button class="reply-trigger" type="button" (click)="replying.set(true)">
                Reply…
              </button>
            }
            @if (canResolve()) {
              <button
                os-button
                variant="ghost"
                size="sm"
                type="button"
                (click)="resolve(!thread().resolved_at)"
              >
                {{ thread().resolved_at ? 'Unresolve' : 'Resolve' }}
              </button>
            }
          }
        </div>
      }
    </div>
  `,
})
export class ThreadView {
  readonly thread = input.required<ReviewThread>();
  readonly proposalId = input.required<string>();
  readonly canComment = input(false);
  readonly canRevise = input(false);
  readonly canResolve = input(false);
  /** Show the quoted lines (in the conversation list, not inline under the lines). */
  readonly showAnchor = input(false);
  /** The thread's lines as they read now, for the suggestion preview. */
  readonly currentLines = input<string | null>(null);
  readonly changed = output<void>();
  private api = inject(Api);
  private notices = inject(Notices);
  readonly replying = signal(false);
  readonly collapsed = signal(true);
  replyText = '';

  suggestionDiff(c: ReviewComment) {
    const before = this.currentLines() ?? this.thread().anchor;
    return diffLines(c.applied_at ? this.thread().anchor : before, c.suggestion ?? '');
  }

  async reply(): Promise<void> {
    if (!this.replyText.trim()) return;
    try {
      await this.api.comment(this.proposalId(), {
        body: this.replyText.trim(),
        thread_id: this.thread().id,
      });
      this.replyText = '';
      this.replying.set(false);
      this.changed.emit();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async resolve(resolved: boolean): Promise<void> {
    try {
      await this.api.resolveThread(this.thread().id, resolved);
      this.collapsed.set(true);
      this.changed.emit();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async apply(c: ReviewComment): Promise<void> {
    try {
      await this.api.applySuggestion(c.id);
      this.notices.ok('Applied the suggestion as a new revision');
      this.changed.emit();
    } catch (e) {
      this.notices.error(e);
    }
  }
}

/**
 * The proposed text with line numbers, optionally as a diff against an older
 * text. Click a line number to comment; shift-click to select a range.
 */
@Component({
  selector: 'app-review-text',
  imports: [FormsModule, Icon, ThreadView, Button, Field, Control],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rt" [class.can-comment]="canComment()" [class.single]="base() === null">
      @for (r of rows(); track $index) {
        <div
          class="rt-line"
          [attr.data-type]="r.type"
          [class.selected]="isSelected(r)"
          [class.has-thread]="covered().has(r.newNo ?? -1)"
        >
          <span class="rt-no">{{ r.oldNo ?? '' }}</span>
          <span class="rt-no">{{ r.newNo ?? '' }}</span>
          <span class="rt-gutter">
            @if (canComment() && r.newNo !== null) {
              <button
                type="button"
                class="rt-add"
                (click)="pick(r.newNo, $event)"
                [attr.aria-label]="'Comment on line ' + r.newNo"
                title="Comment (shift-click to select several lines)"
              >
                <app-icon name="plus" [size]="12" />
              </button>
            }
          </span>
          <span class="rt-sign">{{ r.type === 'add' ? '+' : r.type === 'del' ? '−' : '' }}</span>
          <span class="rt-text">{{ r.text || ' ' }}</span>
        </div>
        @if (r.newNo !== null) {
          @for (t of threadsAt().get(r.newNo) ?? []; track t.id) {
            <div class="rt-inline">
              <app-thread
                [thread]="t"
                [proposalId]="proposalId()"
                [canComment]="canComment()"
                [canRevise]="canRevise()"
                [canResolve]="canResolve(t)"
                [currentLines]="linesText(t.line_start!, t.line_end!)"
                (changed)="changed.emit()"
              />
            </div>
          }
          @if (selEnd() === r.newNo) {
            <div class="rt-inline">
              <form class="composer" (ngSubmit)="submit()">
                <div class="composer-head">
                  <span>{{
                    selStart() === selEnd()
                      ? 'Line ' + selStart()
                      : 'Lines ' + selStart() + '–' + selEnd()
                  }}</span>
                  <button
                    type="button"
                    os-button
                    variant="ghost"
                    size="sm"
                    (click)="toggleSuggestion()"
                  >
                    <app-icon name="pencil" [size]="12" />{{
                      suggesting() ? 'Remove suggestion' : 'Suggest a change'
                    }}
                  </button>
                </div>
                <textarea
                  os-textarea
                  name="body"
                  rows="3"
                  [(ngModel)]="body"
                  placeholder="Leave a comment… (Markdown)"
                  aria-label="Comment"
                  (keydown.control.enter)="submit()"
                  (keydown.meta.enter)="submit()"
                ></textarea>
                @if (suggesting()) {
                  <os-field label="Replace with">
                    <textarea
                      os-textarea
                      name="suggestion"
                      class="mono"
                      [rows]="selEnd()! - selStart()! + 2"
                      [(ngModel)]="suggestion"
                      aria-label="Suggested replacement"
                    ></textarea>
                  </os-field>
                }
                <div class="form-actions">
                  <button
                    os-button
                    variant="primary"
                    size="sm"
                    type="submit"
                    [disabled]="!body.trim() && !suggesting()"
                  >
                    Comment
                  </button>
                  <button os-button size="sm" type="button" (click)="cancel()">Cancel</button>
                  <span class="quiet composer-hint">Ctrl+Enter to send</span>
                </div>
              </form>
            </div>
          }
        }
      }
    </div>
  `,
})
export class ReviewText {
  readonly proposalId = input.required<string>();
  readonly text = input.required<string>();
  /** Compare against this; null shows the text alone. */
  readonly base = input<string | null>(null);
  readonly threads = input<ReviewThread[]>([]);
  readonly canComment = input(false);
  readonly canRevise = input(false);
  readonly me = input<string | null>(null);
  readonly author = input<string | null>(null);
  readonly changed = output<void>();
  private api = inject(Api);
  private notices = inject(Notices);

  readonly selStart = signal<number | null>(null);
  readonly selEnd = signal<number | null>(null);
  readonly suggesting = signal(false);
  body = '';
  suggestion = '';

  readonly rows = computed<Row[]>(() => {
    const after = this.text();
    const base = this.base();
    let o = 0;
    let n = 0;
    if (base === null)
      return after
        .split('\n')
        .map((t) => ({ type: 'same' as const, text: t, oldNo: null, newNo: ++n }));
    return diffLines(base, after).map((l) => {
      if (l.type === 'same') return { ...l, oldNo: ++o, newNo: ++n };
      if (l.type === 'del') return { ...l, oldNo: ++o, newNo: null };
      return { ...l, oldNo: null, newNo: ++n };
    });
  });

  /** Inline threads (still on their lines), keyed by their last line. */
  readonly threadsAt = computed(() => {
    const m = new Map<number, ReviewThread[]>();
    for (const t of this.threads()) {
      if (t.line_end === null || t.outdated) continue;
      m.set(t.line_end, [...(m.get(t.line_end) ?? []), t]);
    }
    return m;
  });

  readonly covered = computed(() => {
    const s = new Set<number>();
    for (const t of this.threads()) {
      if (t.line_start === null || t.outdated || t.resolved_at) continue;
      for (let i = t.line_start; i <= t.line_end!; i++) s.add(i);
    }
    return s;
  });

  canResolve(t: ReviewThread): boolean {
    return this.canRevise() || (t.created_by !== null && t.created_by === this.me());
  }

  linesText(start: number, end: number): string {
    return this.text()
      .split('\n')
      .slice(start - 1, end)
      .join('\n');
  }

  isSelected(r: Row): boolean {
    const s = this.selStart();
    const e = this.selEnd();
    return r.newNo !== null && s !== null && e !== null && r.newNo >= s && r.newNo <= e;
  }

  pick(line: number, ev: MouseEvent): void {
    const s = this.selStart();
    if (ev.shiftKey && s !== null) {
      this.selStart.set(Math.min(s, line));
      this.selEnd.set(Math.max(s, line, this.selEnd() ?? line));
    } else {
      this.selStart.set(line);
      this.selEnd.set(line);
    }
    if (this.suggesting()) this.suggestion = this.linesText(this.selStart()!, this.selEnd()!);
  }

  toggleSuggestion(): void {
    const on = !this.suggesting();
    this.suggesting.set(on);
    if (on) this.suggestion = this.linesText(this.selStart()!, this.selEnd()!);
  }

  cancel(): void {
    this.selStart.set(null);
    this.selEnd.set(null);
    this.suggesting.set(false);
    this.body = '';
  }

  async submit(): Promise<void> {
    const s = this.selStart();
    const e = this.selEnd();
    if (s === null || e === null || (!this.body.trim() && !this.suggesting())) return;
    try {
      await this.api.comment(this.proposalId(), {
        body: this.body.trim(),
        line_start: s,
        line_end: e,
        suggestion: this.suggesting() ? this.suggestion : undefined,
      });
      this.cancel();
      this.changed.emit();
    } catch (err) {
      this.notices.error(err);
    }
  }
}
