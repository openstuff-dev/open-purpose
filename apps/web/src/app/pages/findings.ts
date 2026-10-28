import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  Button,
  Control,
  DialogTitle,
  Drawer,
  IconButton,
  StatusDot,
  type Tone,
} from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { Finding, FindingCounts, FindingStatus } from '../core/models';
import { Session } from '../core/session';
import { Icon } from '../shared/icon';
import { MarkdownView } from '../shared/markdown';
import { Notices } from '../shared/notice';

const STATUSES: FindingStatus[] = ['new', 'todo', 'ask_later', 'solved', 'dismissed'];

/** Shown unless someone turns on solved or dismissed. */
const DEFAULT_SHOWN: FindingStatus[] = ['new', 'todo', 'ask_later'];

const TONE: Record<FindingStatus, Tone> = {
  new: 'brand',
  todo: 'success',
  ask_later: 'warning',
  solved: 'neutral',
  dismissed: 'neutral',
};

const STATUS: Record<FindingStatus, string> = {
  new: 'New',
  todo: 'To do',
  ask_later: 'Ask me later',
  solved: 'Solved',
  dismissed: 'Dismissed',
};

/** What each status means, for the buttons that set it. */
const STATUS_HINT: Record<FindingStatus, string> = {
  new: 'Nobody has looked at it yet',
  todo: 'Worth fixing. Agents may pick it up when someone asks',
  ask_later: 'Needs a decision first. Agents bring it up instead of fixing it',
  solved: 'Fixed',
  dismissed: 'Not a problem, or not worth fixing',
};

type SortKey = 'when' | 'title' | 'file' | 'where';

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function lines(f: Finding): string {
  if (!f.line_start) return '';
  return f.line_end && f.line_end !== f.line_start
    ? `:${f.line_start}-${f.line_end}`
    : `:${f.line_start}`;
}

@Component({
  selector: 'app-findings',
  imports: [
    FormsModule,
    RouterLink,
    DatePipe,
    MarkdownView,
    Icon,
    Button,
    IconButton,
    Control,
    StatusDot,
    Drawer,
    DialogTitle,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)', class: 'wide-page' },
  template: `
    <header class="page-head">
      <h1>Findings</h1>
      <p class="lede">
        Problems agents noticed outside their task and didn't fix. Mark the ones worth fixing as to
        do, and agents can pick them up when you ask. Solved and dismissed ones are hidden unless
        you turn them on.
      </p>
    </header>

    <div class="inbox-bar">
      <!-- Several can be on at once, so checkboxes in the toolkit's segmented look. -->
      <div class="os-segmented" role="group" aria-label="Show findings that are">
        @for (s of statuses; track s) {
          <label [title]="hint[s]">
            <input type="checkbox" [checked]="shown().includes(s)" (change)="toggle(s)" />
            {{ label[s] }}
            @if (counts(); as c) {
              <span class="seg-count">{{ c[s] }}</span>
            }
          </label>
        }
      </div>
      <div class="inbox-filters">
        <label class="search-field"
          ><app-icon name="search" />
          <input
            os-input
            type="search"
            placeholder="Filter by text, file, project or person"
            aria-label="Filter"
            [ngModel]="q()"
            (ngModelChange)="q.set($event)"
          />
        </label>
        <select os-select aria-label="Where" [ngModel]="org()" (ngModelChange)="setOrg($event)">
          <option value="">Everywhere I can see</option>
          @for (o of session.readableOrgs(); track o.id) {
            <option [value]="o.id">{{ o.name }}</option>
          }
        </select>
      </div>
    </div>

    <div class="table-wrap">
      <table class="data-table" [attr.aria-busy]="!loaded()">
        <thead>
          <tr>
            @for (c of columns; track c.key) {
              <th
                scope="col"
                [class]="'col-' + c.col"
                [attr.aria-sort]="
                  sort() === c.key ? (dir() === 1 ? 'ascending' : 'descending') : null
                "
              >
                <button type="button" class="th-sort" (click)="sortBy(c.key)">
                  {{ c.label }}
                  @if (sort() === c.key) {
                    <span aria-hidden="true">{{ dir() === 1 ? '↑' : '↓' }}</span>
                  }
                </button>
              </th>
            }
            <th scope="col" class="col-from">Reported by</th>
            <th scope="col" class="col-status">Status</th>
          </tr>
        </thead>
        <tbody>
          @for (f of rows(); track f.id) {
            <tr
              [class.selected]="f.id === openId()"
              (click)="open(f.id)"
              tabindex="0"
              (keydown.enter)="open(f.id)"
              [attr.aria-selected]="f.id === openId()"
            >
              <td class="col-change">
                <span class="cell-main">{{ f.title }}</span>
                @if (f.problem) {
                  <span class="cell-sub finding-gist">{{ plain(f.problem) }}</span>
                }
              </td>
              <td class="col-file">
                <code [title]="f.file + lines(f)">{{ shortPath(f.file) }}{{ lines(f) }}</code>
              </td>
              <td class="col-where">
                <span class="cell-main"
                  ><i class="dot" [style.background]="session.orgColor(f.organization_id)"></i
                  >{{ f.project_name }}</span
                >
                <span class="cell-sub">{{ f.scope_name ?? 'Whole project' }}</span>
              </td>
              <td class="col-when" [title]="f.created_at | date: 'd MMM y, HH:mm'">
                {{ ago(f.created_at) }}
              </td>
              <td class="col-from">
                <span class="who"
                  ><app-icon
                    [name]="f.created_by_kind === 'human' ? 'user' : 'bot'"
                    [size]="14"
                  />{{ f.created_by_name ?? 'Unknown' }}</span
                >
              </td>
              <td class="col-status">
                <span os-status-dot [tone]="tone[f.status]">{{ label[f.status] }}</span>
                @if (f.status === 'ask_later' && f.remind_after) {
                  <span class="awaiting">From {{ f.remind_after | date: 'd MMM y' }}</span>
                }
              </td>
            </tr>
          } @empty {
            @if (loaded()) {
              <tr class="empty-row">
                <td colspan="6">
                  @if (all().length) {
                    Nothing matches these filters.
                  } @else if (!shown().length) {
                    Choose at least one status above.
                  } @else {
                    No findings here. When an agent notices a problem outside its task, it reports
                    it here instead of fixing it.
                  }
                </td>
              </tr>
            }
          }
        </tbody>
      </table>
    </div>
    @if (rows().length) {
      <p class="table-foot">
        {{ rows().length }} of {{ all().length }} shown · ↑ ↓ to move between findings · Esc to
        close
      </p>
    }

    @if (current(); as f) {
      <div class="drawer-backdrop" (click)="close()"></div>
      <!-- Not modal, like before: notices and the command palette stay usable on top. -->
      <dialog
        os-drawer
        nonModal
        class="drawer"
        [open]="true"
        (openChange)="$event || close()"
        #drawer
        tabindex="-1"
      >
        <header class="drawer-top">
          <span class="kind-tag"><app-icon name="bug" [size]="13" />Finding</span>
          <span os-status-dot [tone]="tone[f.status]">{{ label[f.status] }}</span>
          <span class="drawer-nav">
            <button
              os-icon-button
              variant="ghost"
              type="button"
              (click)="step(-1)"
              [disabled]="index() <= 0"
              label="Previous finding"
            >
              <app-icon name="chevron-down" [size]="16" class="flip" />
            </button>
            <button
              os-icon-button
              variant="ghost"
              type="button"
              (click)="step(1)"
              [disabled]="index() < 0 || index() >= rows().length - 1"
              label="Next finding"
            >
              <app-icon name="chevron-down" [size]="16" />
            </button>
            <button
              os-icon-button
              variant="ghost"
              type="button"
              (click)="copyLink()"
              label="Copy link to this finding"
              title="Copy link"
            >
              <app-icon name="link" />
            </button>
            <button os-icon-button variant="ghost" type="button" (click)="close()" label="Close">
              <app-icon name="x" [size]="18" />
            </button>
          </span>
        </header>

        <div class="drawer-body">
          <h2 class="drawer-title" os-dialog-title>{{ f.title }}</h2>
          <p class="byline">
            <app-icon [name]="f.created_by_kind === 'human' ? 'user' : 'bot'" [size]="13" />
            <span
              >{{ f.created_by_kind === 'human' ? 'Reported by' : 'Reported by the agent' }}
              <strong>{{ f.created_by_name ?? 'Unknown' }}</strong
              >, {{ f.created_at | date: 'd MMM y, HH:mm' }}</span
            >
          </p>

          <dl class="detail-grid">
            <dt>Where</dt>
            <dd>
              <span class="crumb-path">
                <span
                  ><i class="dot" [style.background]="session.orgColor(f.organization_id)"></i
                  >{{ orgName(f) }}</span
                >
                <a [routerLink]="['/projects', f.project_id]">{{ f.project_name }}</a>
                @if (f.scope_id) {
                  <a [routerLink]="['/scopes', f.scope_id]">{{ f.scope_name }}</a>
                }
              </span>
            </dd>
            <dt>File</dt>
            <dd>
              <code class="wrap">{{ f.file }}{{ lines(f) }}</code>
            </dd>
            @if (f.remote) {
              <dt>Repository</dt>
              <dd>
                <code class="wrap">{{ f.remote }}</code>
              </dd>
            }
            @if (f.commit_sha) {
              <dt>Commit</dt>
              <dd>
                <code>{{ f.commit_sha.slice(0, 12) }}</code>
                <span class="quiet"> when it was reported</span>
              </dd>
            }
            @if (f.status_at) {
              <dt>{{ label[f.status] }}</dt>
              <dd>
                By {{ f.status_by_name ?? 'unknown' }}, {{ f.status_at | date: 'd MMM y, HH:mm' }}
                @if (f.solved_ref) {
                  in <code class="wrap">{{ f.solved_ref }}</code>
                }
                @if (f.status_note) {
                  <span class="quiet"> · {{ f.status_note }}</span>
                }
              </dd>
            }
            @if (f.status === 'ask_later' && f.remind_after) {
              <dt>Remind after</dt>
              <dd>{{ f.remind_after | date: 'd MMM y' }}</dd>
            }
            <dt>ID</dt>
            <dd>
              <code class="quiet">{{ f.id.slice(0, 8) }}</code>
            </dd>
          </dl>

          <section class="drawer-section">
            <div class="drawer-section-head"><h3>The problem</h3></div>
            @if (f.problem) {
              <app-md
                [text]="f.problem"
                [fromProject]="f.project_id"
                [fromOrganization]="f.organization_id"
              />
            } @else {
              <p class="quiet">Not described.</p>
            }
          </section>

          <section class="drawer-section">
            <div class="drawer-section-head">
              <h3>Proposed fix</h3>
              <button os-button variant="ghost" size="sm" type="button" (click)="copyAsIssue(f)">
                <app-icon name="copy" [size]="14" />Copy as issue
              </button>
            </div>
            @if (f.proposed_fix) {
              <app-md
                [text]="f.proposed_fix"
                [fromProject]="f.project_id"
                [fromOrganization]="f.organization_id"
              />
            } @else {
              <p class="quiet">None given.</p>
            }
            @if (f.commit_sha && f.status !== 'solved') {
              <p class="quiet">
                Written at commit <code>{{ f.commit_sha.slice(0, 7) }}</code
                >. Check the code before following it.
              </p>
            }
          </section>
        </div>

        @if (session.canEdit(f.organization_id)) {
          <footer class="drawer-foot">
            <div class="foot-row">
              <input
                os-input
                class="note"
                [(ngModel)]="note"
                name="note"
                placeholder="Note for the record (optional)"
                aria-label="Note"
              />
              <label class="os-field remind"
                ><span class="os-label">Remind after</span
                ><input
                  class="os-input"
                  type="date"
                  [(ngModel)]="remindAfter"
                  name="remind"
                  aria-describedby="remind-hint"
              /></label>
            </div>
            <div class="form-actions">
              @for (s of nextStatuses(f); track s) {
                <button
                  type="button"
                  os-button
                  [variant]="s === 'todo' ? 'primary' : s === 'dismissed' ? 'ghost' : 'default'"
                  [title]="hint[s]"
                  (click)="setStatus(f, s)"
                >
                  {{ actionLabel(f, s) }}
                </button>
              }
              <span class="foot-hint quiet" id="remind-hint"
                >The date only applies to Ask me later</span
              >
            </div>
          </footer>
        }
      </dialog>
    }
  `,
})
export class FindingsPage {
  readonly api = inject(Api);
  readonly session = inject(Session);
  private notices = inject(Notices);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private drawer = viewChild('drawer', { read: ElementRef<HTMLElement> });

  readonly statuses = STATUSES;
  readonly label = STATUS;
  readonly tone = TONE;
  readonly hint = STATUS_HINT;
  readonly lines = lines;
  readonly ago = ago;
  readonly columns: Array<{ key: SortKey; col: string; label: string }> = [
    { key: 'title', col: 'change', label: 'Finding' },
    { key: 'file', col: 'file', label: 'File' },
    { key: 'where', col: 'where', label: 'Where' },
    { key: 'when', col: 'when', label: 'Reported' },
  ];

  readonly all = signal<Finding[]>([]);
  readonly counts = signal<FindingCounts | null>(null);
  readonly loaded = signal(false);
  readonly shown = signal<FindingStatus[]>(DEFAULT_SHOWN);
  readonly q = signal('');
  readonly org = signal('');
  readonly sort = signal<SortKey>('when');
  readonly dir = signal<1 | -1>(-1);
  note = '';
  remindAfter = '';
  /** A finding opened by link that the current filters leave out. */
  private extra = signal<Finding | null>(null);

  private readonly params = toSignal(this.route.queryParamMap);
  readonly openId = computed(() => this.params()?.get('f') ?? null);

  readonly rows = computed(() => {
    const q = this.q().trim().toLowerCase();
    const list = this.all().filter((f) => {
      if (!q) return true;
      return [
        f.title,
        f.problem,
        f.proposed_fix,
        f.file,
        f.where,
        f.created_by_name,
        f.remote,
        f.solved_ref,
      ].some((v) => v?.toLowerCase().includes(q));
    });
    const key = (f: Finding): string => {
      switch (this.sort()) {
        case 'title':
          return f.title.toLowerCase();
        case 'file':
          return f.file.toLowerCase();
        case 'where':
          return f.where.toLowerCase();
        default:
          return f.created_at;
      }
    };
    return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * this.dir());
  });

  readonly current = computed(() => {
    const id = this.openId();
    if (!id) return null;
    return this.all().find((f) => f.id === id) ?? (this.extra()?.id === id ? this.extra() : null);
  });
  readonly index = computed(() => this.rows().findIndex((f) => f.id === this.openId()));

  constructor() {
    const s = this.route.snapshot.queryParamMap.get('status');
    if (s !== null) {
      this.shown.set(STATUSES.filter((x) => s.split(',').includes(x)));
    }
    void this.load();
    // Open a finding by link even if the filters leave it out.
    effect(() => {
      const id = this.openId();
      const loaded = this.loaded();
      untracked(() => {
        if (!id || !loaded || this.all().some((f) => f.id === id) || this.extra()?.id === id)
          return;
        void this.api
          .finding(id)
          .then((f) => this.extra.set(f))
          .catch((e) => {
            this.notices.error(e);
            this.close();
          });
      });
    });
    effect(() => {
      const id = this.current()?.id;
      untracked(() => {
        if (!id) return;
        this.note = '';
        this.remindAfter = this.current()?.remind_after ?? '';
        queueMicrotask(() => this.drawer()?.nativeElement.focus({ preventScroll: true }));
      });
    });
  }

  toggle(s: FindingStatus): void {
    const next = this.shown().includes(s)
      ? this.shown().filter((x) => x !== s)
      : STATUSES.filter((x) => x === s || this.shown().includes(x));
    this.shown.set(next);
    const isDefault =
      next.length === DEFAULT_SHOWN.length && DEFAULT_SHOWN.every((x) => next.includes(x));
    void this.router.navigate([], {
      queryParams: { status: isDefault ? null : next.join(',') },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    void this.load();
  }

  setOrg(id: string): void {
    this.org.set(id);
    void this.load();
  }

  sortBy(key: SortKey): void {
    if (this.sort() === key) this.dir.set(this.dir() === 1 ? -1 : 1);
    else {
      this.sort.set(key);
      this.dir.set(key === 'when' ? -1 : 1);
    }
  }

  orgName(f: Finding): string {
    return this.session.orgName(f.organization_id);
  }

  /** Markdown as one line of plain text, for the summary under the title. */
  plain(md: string): string {
    return md
      .replace(/[`*_#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  shortPath(path: string): string {
    const parts = path.split('/');
    return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : path;
  }

  /**
   * Every status but the current one. Ask me later stays, to change the reminder.
   * Solved is usually the agents' to set, but people may too.
   */
  nextStatuses(f: Finding): FindingStatus[] {
    const order: FindingStatus[] = ['todo', 'ask_later', 'dismissed', 'solved', 'new'];
    return order.filter((s) => s !== f.status || s === 'ask_later');
  }

  actionLabel(f: Finding, s: FindingStatus): string {
    if (s === 'new') return 'Back to new';
    if (s === 'todo')
      return f.status === 'solved' || f.status === 'dismissed' ? 'Reopen as to do' : 'To do';
    if (s === 'ask_later') return f.status === 'ask_later' ? 'Change reminder' : 'Ask me later';
    if (s === 'dismissed') return 'Dismiss';
    return 'Mark solved';
  }

  async setStatus(f: Finding, status: FindingStatus): Promise<void> {
    const rows = this.rows();
    const i = rows.findIndex((x) => x.id === f.id);
    const next = rows[i + 1] ?? rows[i - 1];
    try {
      const updated = await this.api.setFindingStatus(f.id, {
        status,
        note: this.note.trim() || undefined,
        remind_after: status === 'ask_later' ? this.remindAfter || null : null,
      });
      this.notices.ok(`"${updated.title}" is now ${STATUS[status].toLowerCase()}`);
      this.session.me.set(await this.api.me());
      await this.load();
      // Moved out of the current filters: go on to the next one.
      if (!this.all().some((x) => x.id === f.id)) {
        if (next && this.all().some((x) => x.id === next.id)) this.open(next.id);
        else this.close();
      }
    } catch (e) {
      this.notices.error(e);
    }
  }

  open(id: string): void {
    void this.router.navigate([], {
      queryParams: { f: id },
      queryParamsHandling: 'merge',
      replaceUrl: !!this.openId(),
    });
  }

  close(): void {
    void this.router.navigate([], { queryParams: { f: null }, queryParamsHandling: 'merge' });
  }

  step(delta: number): void {
    const next = this.rows()[this.index() + delta];
    if (next) this.open(next.id);
  }

  onKey(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
      if (ev.key === 'Escape' && this.current()) (target as HTMLInputElement).blur();
      return;
    }
    if (document.querySelector('.palette-backdrop')) return;
    if (ev.key === 'Escape' && this.current()) {
      this.close();
    } else if ((ev.key === 'ArrowDown' || ev.key === 'j') && this.rows().length) {
      ev.preventDefault();
      if (this.index() < 0) this.open(this.rows()[0].id);
      else this.step(1);
    } else if (
      (ev.key === 'ArrowUp' || ev.key === 'k') &&
      this.current() &&
      !ev.metaKey &&
      !ev.ctrlKey
    ) {
      ev.preventDefault();
      this.step(-1);
    }
  }

  async copyLink(): Promise<void> {
    await this.copy(location.href, 'Copied link to this finding');
  }

  /** The finding as Markdown, for the occasional one that belongs in the team's issue tracker. */
  async copyAsIssue(f: Finding): Promise<void> {
    const md = [
      `## ${f.title}`,
      '',
      `\`${f.file}${lines(f)}\` in ${f.where}${f.commit_sha ? ` (reported at \`${f.commit_sha.slice(0, 12)}\`)` : ''}`,
      '',
      '### Problem',
      '',
      f.problem || '_Not described._',
      '',
      '### Proposed fix',
      '',
      f.proposed_fix || '_None given._',
    ].join('\n');
    await this.copy(md, 'Copied as Markdown, ready to paste into an issue');
  }

  private async copy(text: string, done: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.notices.ok(done);
    } catch {
      this.notices.error('Copying is blocked in this browser.');
    }
  }

  private async load(): Promise<void> {
    try {
      const org = this.org() || undefined;
      const shown = this.shown();
      const [list, counts] = await Promise.all([
        shown.length
          ? this.api.findings({ status: shown, organization_id: org })
          : Promise.resolve([]),
        this.api.findingCounts({ organization_id: org }),
      ]);
      this.all.set(list);
      this.counts.set(counts);
    } catch (e) {
      this.notices.error(e);
    }
    this.loaded.set(true);
  }
}
