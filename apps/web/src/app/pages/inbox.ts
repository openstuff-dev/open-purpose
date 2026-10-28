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
  Badge,
  Button,
  Check,
  Checkbox,
  Chip,
  Control,
  Field,
  IconButton,
  StatusDot,
  type Tone,
} from '@openstuff-dev/ui-angular';
import { SegmentedControl } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import {
  MODE_LABEL,
  type EditMode,
  type Proposal,
  type ProposalCounts,
  type ProposalStatus,
  type Review,
  type ReviewEvent,
  type ReviewThread,
  type Scope,
} from '../core/models';
import { Session } from '../core/session';
import { Icon } from '../shared/icon';
import { MarkdownView } from '../shared/markdown';
import { MarkdownEditor } from '../shared/md-editor';
import { ModeBadge, ModePicker } from '../shared/mode';
import { Notices } from '../shared/notice';
import { ReviewText, ThreadView } from '../shared/review';

interface Target {
  key: string;
  label: string;
  organization_id: string | null;
  project_id: string | null;
  scope_id: string | null;
  /** Filing here moves the learning up to the whole group. */
  promote?: boolean;
}

/** The reviewer's unsaved choices for one proposal. */
interface Draft {
  editing: boolean;
  heading: string;
  body: string;
  note: string;
  target: string;
  mode: EditMode;
  targets: Target[];
  /** General comment being written. */
  comment: string;
}

type StatusTab = ProposalStatus | 'all';
type SortKey = 'when' | 'kind' | 'change' | 'where' | 'from';

const KIND: Record<Proposal['kind'], { label: string; icon: string }> = {
  learning: { label: 'Learning', icon: 'bot' },
  edit_section: { label: 'Change', icon: 'pencil' },
  new_section: { label: 'New section', icon: 'plus' },
};

const STATUS_TONE: Record<ProposalStatus, Tone> = {
  pending: 'brand',
  changes_requested: 'warning',
  approved: 'success',
  rejected: 'danger',
};

const STATUS: Record<ProposalStatus, string> = {
  pending: 'Needs review',
  changes_requested: 'Waiting on author',
  approved: 'Approved',
  rejected: 'Rejected',
};

const EVENT: Record<ReviewEvent['kind'], { verb: string; icon: string }> = {
  proposed: { verb: 'proposed this', icon: 'dot' },
  revised: { verb: 'pushed revision', icon: 'pencil' },
  changes_requested: { verb: 'requested changes', icon: 'message' },
  approved: { verb: 'approved', icon: 'check' },
  rejected: { verb: 'rejected', icon: 'x' },
  commented: { verb: 'commented', icon: 'message' },
};

type TimelineItem = { at: string; event?: ReviewEvent; thread?: ReviewThread };

function isOpen(s: ProposalStatus): boolean {
  return s === 'pending' || s === 'changes_requested';
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

@Component({
  selector: 'app-inbox',
  imports: [
    FormsModule,
    RouterLink,
    DatePipe,
    ReviewText,
    ThreadView,
    MarkdownView,
    MarkdownEditor,
    ModePicker,
    ModeBadge,
    Icon,
    Button,
    IconButton,
    Field,
    Control,
    Check,
    Checkbox,
    StatusDot,
    Badge,
    Chip,
    SegmentedControl,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)', class: 'wide-page' },
  template: `
    <header class="page-head">
      <h1>Inbox</h1>
      <p class="lede">
        What agents learned from corrections, and changes they want to make to rules. Nothing here
        reaches other agents until someone approves it.
      </p>
    </header>

    <div class="inbox-bar">
      <!-- The toolkit's segmented look, with a count after each label. -->
      <div class="os-segmented" role="radiogroup" aria-label="Status">
        @for (t of tabs; track t.value) {
          <label>
            <input
              type="radio"
              name="inbox-status"
              [value]="t.value"
              [checked]="status() === t.value"
              (change)="setStatus(t.value)"
            />
            {{ t.label }}
            @if (countFor(t.value) !== null) {
              <span class="seg-count">{{ countFor(t.value) }}</span>
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
            placeholder="Filter by text, person, project or file"
            aria-label="Filter"
            [ngModel]="q()"
            (ngModelChange)="q.set($event)"
          />
        </label>
        <select
          os-select
          aria-label="Type"
          [ngModel]="kindFilter()"
          (ngModelChange)="kindFilter.set($event)"
        >
          <option value="">All types</option>
          <option value="learning">Learnings</option>
          <option value="edit_section">Changes</option>
          <option value="new_section">New sections</option>
        </select>
        <select os-select aria-label="Where" [ngModel]="level()" (ngModelChange)="setLevel($event)">
          <option value="all">Everywhere I can see</option>
          <option value="group">{{ session.group()?.name }} only</option>
          @for (o of session.readableOrgs(); track o.id) {
            <option [value]="o.id">{{ o.name }}</option>
          }
        </select>
        <label os-check
          ><input
            os-checkbox
            type="checkbox"
            [ngModel]="mine()"
            (ngModelChange)="mine.set($event)"
          />
          Only what I can review</label
        >
      </div>
    </div>

    <div class="table-wrap">
      <table class="data-table" [attr.aria-busy]="!loaded()">
        <thead>
          <tr>
            @for (c of columns; track c.key) {
              <th
                scope="col"
                [class]="'col-' + c.key"
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
            <th scope="col" class="col-file">File</th>
            <th scope="col" class="col-status">Status</th>
          </tr>
        </thead>
        <tbody>
          @for (p of rows(); track p.id) {
            <tr
              [class.selected]="p.id === openId()"
              (click)="open(p.id)"
              tabindex="0"
              (keydown.enter)="open(p.id)"
              [attr.aria-selected]="p.id === openId()"
            >
              <td class="col-change">
                <span class="change-cell">
                  <span class="kind-dot" [attr.data-kind]="p.kind" [title]="kind[p.kind].label"
                    ><app-icon [name]="kind[p.kind].icon" [size]="13"
                  /></span>
                  <span class="change-text">
                    <span class="cell-main">{{ p.heading || p.current_heading }}</span>
                    <span class="cell-sub"
                      ><span class="kind-word" [attr.data-kind]="p.kind">{{
                        kind[p.kind].label
                      }}</span>
                      @if (p.document_title) {
                        · {{ p.document_title }}
                      }
                      @if (p.revision > 1) {
                        · rev {{ p.revision }}
                      }
                      @if (p.comment_count) {
                        <span
                          class="comment-count"
                          [class.open]="p.open_threads"
                          [title]="p.open_threads + ' unresolved'"
                          ><app-icon name="message" [size]="12" />{{ p.comment_count }}</span
                        >
                      }
                    </span>
                  </span>
                </span>
              </td>
              <td class="col-where">
                <span class="cell-main"
                  ><i
                    class="dot"
                    [style.background]="
                      p.organization_id ? session.orgColor(p.organization_id) : 'var(--ink)'
                    "
                  ></i
                  >{{ p.organization_name ?? session.group()?.name }}</span
                >
                <span class="cell-sub">{{ whereTail(p) }}</span>
              </td>
              <td class="col-from">
                <span class="who"
                  ><app-icon
                    [name]="p.created_by_kind === 'human' ? 'user' : 'bot'"
                    [size]="14"
                  />{{ p.created_by_name ?? 'Unknown' }}</span
                >
              </td>
              <td class="col-when" [title]="p.created_at | date: 'd MMM y, HH:mm'">
                {{ ago(p.created_at) }}
              </td>
              <td class="col-file">
                @if (p.context.path) {
                  <code [title]="p.context.path">{{ shortPath(p.context.path) }}</code>
                } @else {
                  <span class="faint">—</span>
                }
              </td>
              <td class="col-status">
                <span os-status-dot [tone]="statusTone[p.status]">{{ statusLabel[p.status] }}</span>
                @if (p.awaiting === 'author') {
                  <span
                    class="awaiting"
                    [title]="'Waiting on ' + (p.created_by_name ?? 'the author')"
                    >{{ p.status === 'changes_requested' ? '' : 'Reply due · '
                    }}{{ p.created_by_name ?? 'author' }}</span
                  >
                }
              </td>
            </tr>
          } @empty {
            @if (loaded()) {
              <tr class="empty-row">
                <td colspan="6">
                  @if (all().length) {
                    Nothing matches these filters.
                  } @else if (status() === 'pending') {
                    Nothing waiting. When an agent is corrected and proposes a learning, it lands
                    here.
                  } @else {
                    Nothing here yet.
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
        {{ rows().length }} of {{ all().length }} shown · ↑ ↓ to move between changes · Esc to close
      </p>
    }

    @if (current(); as p) {
      <div class="drawer-backdrop" (click)="close()"></div>
      <aside
        class="drawer"
        role="dialog"
        aria-modal="false"
        [attr.aria-label]="p.heading || 'Change'"
        #drawer
        tabindex="-1"
      >
        <header class="drawer-top">
          <span class="kind-tag" [attr.data-kind]="p.kind"
            ><app-icon [name]="kind[p.kind].icon" [size]="13" />{{ kind[p.kind].label }}</span
          >
          <span os-status-dot [tone]="statusTone[p.status]">{{ statusLabel[p.status] }}</span>
          <span class="drawer-nav">
            <button
              os-icon-button
              variant="ghost"
              type="button"
              (click)="step(-1)"
              [disabled]="index() <= 0"
              label="Previous change"
            >
              <app-icon name="chevron-down" [size]="16" class="flip" />
            </button>
            <button
              os-icon-button
              variant="ghost"
              type="button"
              (click)="step(1)"
              [disabled]="index() < 0 || index() >= rows().length - 1"
              label="Next change"
            >
              <app-icon name="chevron-down" [size]="16" />
            </button>
            <button
              os-icon-button
              variant="ghost"
              type="button"
              (click)="copyLink()"
              label="Copy link to this change"
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
          <h2 class="drawer-title">{{ p.heading || p.current_heading }}</h2>
          <p class="byline">
            <app-icon [name]="p.created_by_kind === 'human' ? 'user' : 'bot'" [size]="13" />
            <span
              >{{ p.created_by_kind === 'human' ? 'Proposed by' : 'Proposed by the agent' }}
              <strong>{{ p.created_by_name ?? 'Unknown' }}</strong
              >, {{ p.created_at | date: 'd MMM y, HH:mm' }}</span
            >
          </p>

          @if (p.rationale) {
            <blockquote class="rationale">
              <span class="quiet">{{ p.kind === 'learning' ? 'What happened' : 'Why' }}</span
              >{{ p.rationale }}
            </blockquote>
          }

          <dl class="detail-grid">
            <dt>{{ p.kind === 'learning' && isOpen(p.status) ? 'Suggested for' : 'Where' }}</dt>
            <dd>
              <span class="crumb-path">
                <span
                  ><i
                    class="dot"
                    [style.background]="
                      p.organization_id ? session.orgColor(p.organization_id) : 'var(--ink)'
                    "
                  ></i
                  >{{ p.organization_name ?? session.group()?.name }}</span
                >
                @if (p.project_id) {
                  <a [routerLink]="['/projects', p.project_id]">{{ p.project_name }}</a>
                }
                @if (p.scope_id) {
                  <a [routerLink]="['/scopes', p.scope_id]">{{ p.scope_name }}</a>
                }
              </span>
              @if (!p.organization_id) {
                <span class="quiet"> (every organization)</span>
              }
            </dd>
            @if (p.document_id) {
              <dt>Document</dt>
              <dd>
                <a [routerLink]="['/documents', p.document_id]">{{ p.document_title }}</a>
                @if (p.document_mode && p.kind === 'new_section') {
                  <app-mode-badge [mode]="p.document_mode" />
                }
              </dd>
            }
            @if (p.section_id) {
              <dt>Section</dt>
              <dd>
                <a
                  [routerLink]="['/documents', p.document_id]"
                  [fragment]="'s-' + p.section_id.slice(0, 8)"
                  >{{ p.current_heading }}</a
                >
                <code class="quiet">s:{{ p.section_id.slice(0, 8) }}</code>
                @if (p.section_mode) {
                  <app-mode-badge [mode]="p.section_mode" />
                }
              </dd>
              <dt>Version</dt>
              <dd>
                Based on version {{ p.base_version }}
                @if (isOpen(p.status)) {
                  , now at {{ p.current_version }}
                  @if (p.current_version !== p.base_version) {
                    <span os-badge tone="warning">Changed since</span>
                  }
                }
              </dd>
            }
            @if (p.context.path) {
              <dt>File</dt>
              <dd>
                <code class="wrap">{{ p.context.path }}</code>
              </dd>
            }
            @if (p.context.remote) {
              <dt>Repository</dt>
              <dd>
                <code class="wrap">{{ p.context.remote }}</code>
              </dd>
            }
            @if (p.context.stacks?.length) {
              <dt>Stacks</dt>
              <dd>
                @for (t of p.context.stacks; track t) {
                  <span os-chip>{{ t }}</span>
                }
              </dd>
            }
            @if (p.context.manifests?.length) {
              <dt>Manifests</dt>
              <dd>
                @for (m of p.context.manifests; track m) {
                  <code class="wrap">{{ m }}</code>
                }
              </dd>
            }
            <dt>ID</dt>
            <dd>
              <code class="quiet">{{ p.id.slice(0, 8) }}</code>
            </dd>
          </dl>

          @let rv = reviewOf(p.id);
          @let r = draft(p);
          <section class="drawer-section">
            <div class="drawer-section-head">
              <h3>
                {{
                  p.kind === 'edit_section'
                    ? 'What changed'
                    : p.kind === 'learning'
                      ? 'The learning'
                      : 'The new section'
                }}
                @if (p.revision > 1) {
                  <span os-chip>Revision {{ p.revision }}</span>
                }
              </h3>
              <os-segmented-control
                label="View"
                size="sm"
                [options]="p.kind === 'edit_section' ? editViews : views"
                [(value)]="view"
              />
            </div>
            @if (r.editing) {
              <div class="section-edit">
                <os-field label="Heading"
                  ><input os-input [(ngModel)]="r.heading" name="heading"
                /></os-field>
                <app-md-editor
                  [(value)]="r.body"
                  [rows]="12"
                  label="Text"
                  [fromProject]="p.project_id"
                  [fromOrganization]="p.organization_id"
                />
                @if (rv?.threads?.length) {
                  <p class="quiet">
                    Comments stay attached to their lines as long as those lines still exist.
                  </p>
                }
              </div>
            } @else if (view() === 'review') {
              @if (compareOptions(p, rv).length > 1) {
                <div class="compare-bar">
                  <label
                    ><app-icon name="diff" [size]="14" />Compare with
                    <select
                      os-select
                      [ngModel]="compare()"
                      (ngModelChange)="compare.set($event)"
                      aria-label="Compare with"
                    >
                      @for (o of compareOptions(p, rv); track o.value) {
                        <option [value]="o.value">{{ o.label }}</option>
                      }
                    </select>
                  </label>
                  @if (rv?.can_comment && isOpen(p.status)) {
                    <span class="quiet compare-hint"
                      >Click <b>+</b> beside a line to comment, shift-click to select several.</span
                    >
                  }
                </div>
              } @else if (rv?.can_comment && isOpen(p.status)) {
                <p class="quiet compare-hint">
                  Click <b>+</b> beside a line to comment, shift-click to select several.
                </p>
              }
              @if (
                p.kind === 'edit_section' &&
                compare() === 'section' &&
                p.heading &&
                p.heading !== p.current_heading
              ) {
                <p class="heading-change">
                  <span class="del">{{ p.current_heading }}</span> →
                  <span class="add">{{ p.heading }}</span>
                </p>
              }
              <app-review-text
                [proposalId]="p.id"
                [text]="p.body"
                [base]="baseText(p, rv)"
                [threads]="rv?.threads ?? []"
                [canComment]="!!rv?.can_comment && isOpen(p.status)"
                [canRevise]="!!rv?.can_revise && isOpen(p.status)"
                [me]="session.me()?.actor?.id ?? null"
                (changed)="refresh(p)"
              />
            } @else if (view() === 'before') {
              <div class="proposal-body">
                <app-md
                  [text]="p.current_body ?? ''"
                  [fromProject]="p.project_id"
                  [fromOrganization]="p.organization_id"
                />
              </div>
            } @else {
              <div class="proposal-body">
                <app-md
                  [text]="p.body"
                  [fromProject]="p.project_id"
                  [fromOrganization]="p.organization_id"
                />
              </div>
            }
          </section>

          <section class="drawer-section">
            <div class="drawer-section-head">
              <h3>Conversation</h3>
              @if (p.awaiting) {
                <span class="awaiting-pill" [attr.data-who]="p.awaiting">
                  <app-icon
                    [name]="
                      p.awaiting === 'author'
                        ? p.created_by_kind === 'agent'
                          ? 'bot'
                          : 'user'
                        : 'users'
                    "
                    [size]="13"
                  />
                  {{
                    p.awaiting === 'author'
                      ? 'Waiting on ' + (p.created_by_name ?? 'the author')
                      : 'Waiting on a reviewer'
                  }}
                </span>
              }
            </div>
            <ol class="timeline">
              @for (item of timeline(rv); track item.event?.id ?? item.thread?.id) {
                @if (item.event; as e) {
                  <li class="tl-event" [attr.data-kind]="e.kind">
                    <span class="tl-icon"
                      ><app-icon [name]="eventInfo[e.kind].icon" [size]="13"
                    /></span>
                    <div>
                      <p>
                        <strong>{{ e.actor_name ?? 'Someone' }}</strong>
                        @if (e.actor_kind === 'agent') {
                          <span os-chip>Agent</span>
                        }
                        {{ eventInfo[e.kind].verb }}
                        @if (e.kind === 'revised') {
                          {{ e.revision }}
                        }
                        <span class="quiet">· {{ ago(e.created_at) }}</span>
                      </p>
                      @if (e.note) {
                        <app-md class="tl-note" [text]="e.note" />
                      }
                    </div>
                  </li>
                } @else if (item.thread; as t) {
                  <li class="tl-thread">
                    <app-thread
                      [thread]="t"
                      [proposalId]="p.id"
                      [showAnchor]="t.line_start !== null"
                      [canComment]="!!rv?.can_comment && isOpen(p.status)"
                      [canRevise]="!!rv?.can_revise && isOpen(p.status)"
                      [canResolve]="!!rv?.can_revise || t.created_by === session.me()?.actor?.id"
                      (changed)="refresh(p)"
                    />
                  </li>
                }
              } @empty {
                <li class="quiet">Loading…</li>
              }
            </ol>
            @if (rv?.can_comment && isOpen(p.status)) {
              <div class="composer general">
                <textarea
                  os-textarea
                  rows="3"
                  [(ngModel)]="r.comment"
                  name="comment"
                  placeholder="Comment on the whole change… (Markdown)"
                  aria-label="Comment on the whole change"
                  (keydown.control.enter)="comment(p)"
                  (keydown.meta.enter)="comment(p)"
                ></textarea>
                <div class="form-actions">
                  <button
                    os-button
                    size="sm"
                    type="button"
                    (click)="comment(p)"
                    [disabled]="!r.comment.trim()"
                  >
                    <app-icon name="message" [size]="13" />Comment
                  </button>
                  @if (p.can_review) {
                    <button
                      os-button
                      size="sm"
                      type="button"
                      (click)="requestChanges(p)"
                      title="Send this comment and hand the change back to its author"
                    >
                      Request changes
                    </button>
                  }
                </div>
              </div>
            }
          </section>

          @if (!isOpen(p.status)) {
            <section class="drawer-section decision-box" [attr.data-status]="p.status">
              <h3>
                <app-icon [name]="p.status === 'approved' ? 'check' : 'x'" />{{
                  p.status === 'approved' ? 'Approved' : 'Rejected'
                }}
              </h3>
              <p>
                By <strong>{{ p.reviewed_by_name ?? 'unknown' }}</strong
                >, {{ p.reviewed_at | date: 'd MMM y, HH:mm' }}
              </p>
              @if (p.review_note) {
                <p>“{{ p.review_note }}”</p>
              }
              @if (p.status === 'approved' && p.result_document_id && p.result_section_id) {
                <a
                  os-button
                  size="sm"
                  [routerLink]="['/documents', p.result_document_id]"
                  [fragment]="'s-' + p.result_section_id.slice(0, 8)"
                  >Open the rule</a
                >
              }
            </section>
          }
        </div>

        @if (isOpen(p.status)) {
          @if (p.can_review) {
            <footer class="drawer-foot">
              @if (p.kind === 'learning') {
                <os-field label="File under" class="file-under"
                  ><select os-select [(ngModel)]="r.target" name="target" (ngModelChange)="touch()">
                    @for (t of r.targets; track t.key) {
                      <option [value]="t.key">{{ t.label }}</option>
                    }
                  </select></os-field
                >
                @if (isPromotion(r)) {
                  <p class="promote-note">Every agent in every organization will get this.</p>
                }
              }
              <div class="foot-row">
                @if (p.kind !== 'edit_section') {
                  <div class="doc-mode">
                    <span>Agents may</span>
                    <app-mode-picker
                      [mode]="r.mode"
                      (changed)="r.mode = $event; touch()"
                      label="What agents may do with the approved section"
                    />
                  </div>
                }
                <input
                  os-input
                  class="note"
                  [(ngModel)]="r.note"
                  name="note"
                  placeholder="Note for the record (optional)"
                  aria-label="Note"
                />
              </div>
              @if (rv && unresolved(rv)) {
                <p class="quiet foot-warn">
                  <app-icon name="message" [size]="13" />{{ unresolved(rv) }} unresolved
                  {{ unresolved(rv) === 1 ? 'conversation' : 'conversations' }}
                </p>
              }
              <div class="form-actions">
                <button os-button variant="primary" type="button" (click)="approve(p)">
                  <app-icon name="check" />Approve
                </button>
                @if (r.editing) {
                  <button os-button type="button" (click)="saveRevision(p)">
                    Save as revision
                  </button>
                  <button os-button variant="ghost" type="button" (click)="stopEditing(p)">
                    Discard edits
                  </button>
                } @else {
                  <button os-button type="button" (click)="r.editing = true; touch()">
                    <app-icon name="pencil" />Edit
                  </button>
                  <button os-button type="button" (click)="requestChanges(p)">
                    Request changes
                  </button>
                }
                <button os-button variant="danger" type="button" (click)="reject(p)">Reject</button>
                @if (p.kind !== 'edit_section') {
                  <span class="quiet foot-hint">{{ modeLabel[r.mode] }} after approval</span>
                }
              </div>
            </footer>
          } @else if (rv?.can_revise) {
            <footer class="drawer-foot">
              <p class="quiet">
                {{
                  p.status === 'changes_requested'
                    ? 'A reviewer asked for changes. Reply in the threads, apply suggestions or edit the text, then save a revision.'
                    : 'Waiting for a reviewer. You can still improve it.'
                }}
              </p>
              @if (r.editing) {
                <input
                  os-input
                  class="note"
                  [(ngModel)]="r.note"
                  name="note"
                  placeholder="What changed in this revision (optional)"
                  aria-label="Revision note"
                />
              }
              <div class="form-actions">
                @if (r.editing) {
                  <button os-button variant="primary" type="button" (click)="saveRevision(p)">
                    Save revision
                  </button>
                  <button os-button variant="ghost" type="button" (click)="stopEditing(p)">
                    Discard edits
                  </button>
                } @else {
                  <button os-button type="button" (click)="r.editing = true; touch()">
                    <app-icon name="pencil" />Edit
                  </button>
                  <button os-button variant="ghost" type="button" (click)="withdraw(p)">
                    Withdraw
                  </button>
                }
              </div>
            </footer>
          } @else {
            <footer class="drawer-foot">
              <p class="quiet">
                Only editors of {{ p.organization_name ?? session.group()?.name }} can approve this.
                @if (rv?.can_comment) {
                  You can still comment.
                }
              </p>
            </footer>
          }
        }
      </aside>
    }
  `,
})
export class InboxPage {
  readonly session = inject(Session);
  private api = inject(Api);
  private notices = inject(Notices);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private drawer = viewChild<ElementRef<HTMLElement>>('drawer');

  readonly kind = KIND;
  readonly statusLabel = STATUS;
  readonly statusTone = STATUS_TONE;
  readonly modeLabel = MODE_LABEL;
  readonly ago = ago;
  readonly tabs: Array<{ value: StatusTab; label: string }> = [
    { value: 'pending', label: 'Needs review' },
    { value: 'changes_requested', label: 'Waiting on author' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'all', label: 'All' },
  ];
  readonly columns: Array<{ key: SortKey; label: string }> = [
    { key: 'change', label: 'Change' },
    { key: 'where', label: 'Where' },
    { key: 'from', label: 'From' },
    { key: 'when', label: 'When' },
  ];

  readonly all = signal<Proposal[]>([]);
  readonly counts = signal<ProposalCounts | null>(null);
  readonly loaded = signal(false);
  readonly status = signal<StatusTab>('pending');
  readonly level = signal('all');
  readonly kindFilter = signal('');
  readonly q = signal('');
  readonly mine = signal(false);
  readonly sort = signal<SortKey>('when');
  readonly dir = signal<1 | -1>(-1);
  readonly drafts = signal<Record<string, Draft>>({});
  /** Review threads, revisions and timeline, per opened proposal. */
  readonly reviewData = signal<Record<string, Review>>({});
  readonly view = signal<'review' | 'rendered' | 'before'>('review');
  readonly views = [
    { value: 'review', label: 'Lines' },
    { value: 'rendered', label: 'Rendered' },
  ] as const;
  readonly editViews = [...this.views, { value: 'before', label: 'Before' }] as const;
  /** What the proposed text is compared with: 'section', 'none' or a revision number. */
  readonly compare = signal<string>('none');
  readonly eventInfo = EVENT;
  readonly isOpen = isOpen;
  /** A proposal opened by link that isn't in the current list. */
  private extra = signal<Proposal | null>(null);
  private scopeCache = new Map<string, Scope[]>();

  private readonly params = toSignal(this.route.queryParamMap);
  readonly openId = computed(() => this.params()?.get('p') ?? null);

  readonly rows = computed(() => {
    const q = this.q().trim().toLowerCase();
    const kind = this.kindFilter();
    const list = this.all().filter((p) => {
      if (kind && p.kind !== kind) return false;
      if (this.mine() && !(p.can_review && isOpen(p.status))) return false;
      if (!q) return true;
      return [
        p.heading,
        p.current_heading,
        p.body,
        p.rationale,
        p.created_by_name,
        p.organization_name,
        p.project_name,
        p.scope_name,
        p.document_title,
        p.context.path,
        p.context.remote,
      ].some((v) => v?.toLowerCase().includes(q));
    });
    const key = (p: Proposal): string => {
      switch (this.sort()) {
        case 'kind':
          return p.kind;
        case 'change':
          return (p.heading || p.current_heading || '').toLowerCase();
        case 'where':
          return [p.organization_name ?? '', p.project_name ?? '', p.scope_name ?? '']
            .join('/')
            .toLowerCase();
        case 'from':
          return (p.created_by_name ?? '').toLowerCase();
        default:
          return p.created_at;
      }
    };
    return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * this.dir());
  });

  readonly current = computed(() => {
    const id = this.openId();
    if (!id) return null;
    return this.all().find((p) => p.id === id) ?? (this.extra()?.id === id ? this.extra() : null);
  });
  readonly index = computed(() => this.rows().findIndex((p) => p.id === this.openId()));

  constructor() {
    const s = this.route.snapshot.queryParamMap.get('status');
    if (
      s === 'pending' ||
      s === 'changes_requested' ||
      s === 'approved' ||
      s === 'rejected' ||
      s === 'all'
    )
      this.status.set(s);
    void this.load();
    // Open a change by link even if the current tab doesn't list it.
    effect(() => {
      const id = this.openId();
      const loaded = this.loaded();
      untracked(() => {
        if (!id || !loaded || this.all().some((p) => p.id === id) || this.extra()?.id === id)
          return;
        void this.api
          .proposal(id)
          .then(async (p) => {
            await this.prepare(p);
            this.extra.set(p);
          })
          .catch((e) => {
            this.notices.error(e);
            this.close();
          });
      });
    });
    effect(() => {
      const id = this.current()?.id;
      untracked(() => {
        const p = this.current();
        if (!id || !p) return;
        this.view.set('review');
        this.compare.set(p.kind === 'edit_section' && isOpen(p.status) ? 'section' : 'none');
        void this.loadReview(p.id);
        queueMicrotask(() => this.drawer()?.nativeElement.focus({ preventScroll: true }));
      });
    });
  }

  countFor(t: StatusTab): number | null {
    const c = this.counts();
    if (!c) return null;
    return t === 'all' ? c.pending + c.changes_requested + c.approved + c.rejected : c[t];
  }

  whereTail(p: Proposal): string {
    if (!p.organization_id && !p.project_name && !p.scope_name) return 'Every organization';
    return (
      [p.project_name, p.scope_name].filter(Boolean).join(' › ') ||
      (p.organization_id ? 'Whole organization' : 'Every organization')
    );
  }

  shortPath(path: string): string {
    const parts = path.split('/');
    return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : path;
  }

  setStatus(s: StatusTab): void {
    this.status.set(s);
    void this.router.navigate([], {
      queryParams: { status: s === 'pending' ? null : s },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    void this.load();
  }

  setLevel(level: string): void {
    this.level.set(level);
    void this.load();
  }

  sortBy(key: SortKey): void {
    if (this.sort() === key) this.dir.set(this.dir() === 1 ? -1 : 1);
    else {
      this.sort.set(key);
      this.dir.set(key === 'when' ? -1 : 1);
    }
  }

  open(id: string): void {
    void this.router.navigate([], {
      queryParams: { p: id },
      queryParamsHandling: 'merge',
      replaceUrl: !!this.openId(),
    });
  }

  close(): void {
    void this.router.navigate([], { queryParams: { p: null }, queryParamsHandling: 'merge' });
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
    try {
      await navigator.clipboard.writeText(location.href);
      this.notices.ok('Copied link to this change');
    } catch {
      this.notices.error('Copying is blocked in this browser. Copy the address bar instead.');
    }
  }

  touch(): void {
    this.drafts.update((r) => ({ ...r }));
  }

  isPromotion(r: Draft): boolean {
    return !!r.targets.find((t) => t.key === r.target)?.promote;
  }

  draft(p: Proposal): Draft {
    let d = this.drafts()[p.id];
    if (!d) {
      d = this.blank(p);
      this.drafts()[p.id] = d;
    }
    return d;
  }

  reviewOf(id: string): Review | null {
    return this.reviewData()[id] ?? null;
  }

  unresolved(rv: Review): number {
    return rv.threads.filter((t) => !t.resolved_at).length;
  }

  compareOptions(p: Proposal, rv: Review | null): Array<{ value: string; label: string }> {
    const out: Array<{ value: string; label: string }> = [];
    if (p.kind === 'edit_section' && isOpen(p.status))
      out.push({ value: 'section', label: `The section as it is now (v${p.current_version})` });
    for (const r of rv?.revisions ?? []) {
      if (r.revision === p.revision) continue;
      out.push({
        value: String(r.revision),
        label:
          r.revision === 1
            ? 'Revision 1, as first proposed'
            : `Revision ${r.revision}${r.revision === p.revision - 1 ? ', the previous one' : ''}`,
      });
    }
    out.push({ value: 'none', label: 'Nothing, just the text' });
    return out;
  }

  baseText(p: Proposal, rv: Review | null): string | null {
    const c = this.compare();
    if (c === 'section') return p.current_body ?? '';
    if (c === 'none') return null;
    return rv?.revisions.find((r) => String(r.revision) === c)?.body ?? null;
  }

  /** Events and general or outdated threads, oldest first. Line threads live beside their lines. */
  timeline(rv: Review | null): TimelineItem[] {
    if (!rv) return [];
    const items: TimelineItem[] = rv.events
      .filter((e) => e.kind !== 'commented')
      .map((e) => ({ at: e.created_at, event: e }));
    for (const t of rv.threads)
      if (t.line_start === null || t.outdated) items.push({ at: t.created_at, thread: t });
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }

  private async loadReview(id: string): Promise<void> {
    try {
      const rv = await this.api.review(id);
      this.reviewData.update((all) => ({ ...all, [id]: rv }));
    } catch (e) {
      this.notices.error(e);
    }
  }

  /** Reload the proposal and its review after a comment, resolve or revision. */
  async refresh(p: Proposal): Promise<void> {
    try {
      const [fresh, rv] = await Promise.all([this.api.proposal(p.id), this.api.review(p.id)]);
      this.reviewData.update((all) => ({ ...all, [p.id]: rv }));
      const old = this.drafts()[p.id];
      const d = this.blank(fresh);
      if (old) {
        Object.assign(d, {
          target: old.target,
          targets: old.targets,
          mode: old.mode,
          comment: old.comment,
        });
        // Keep unsaved edits unless a new revision just replaced the text.
        if (old.editing && fresh.revision === p.revision)
          Object.assign(d, { editing: true, body: old.body, heading: old.heading, note: old.note });
      }
      this.drafts.update((all) => ({ ...all, [p.id]: d }));
      if (this.all().some((x) => x.id === p.id))
        this.all.update((l) => l.map((x) => (x.id === p.id ? fresh : x)));
      else this.extra.set(fresh);
      void this.api
        .proposalCounts(this.level() === 'all' ? undefined : this.level())
        .then((c) => this.counts.set(c));
    } catch (e) {
      this.notices.error(e);
    }
  }

  async comment(p: Proposal): Promise<void> {
    const d = this.draft(p);
    if (!d.comment.trim()) return;
    try {
      await this.api.comment(p.id, { body: d.comment.trim() });
      d.comment = '';
      await this.refresh(p);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async requestChanges(p: Proposal): Promise<void> {
    const d = this.draft(p);
    const note = d.comment.trim() || d.note.trim();
    if (!note && !this.reviewOf(p.id)?.threads.some((t) => !t.resolved_at)) {
      this.notices.error(
        'Say what should change: write a comment, or comment on specific lines first.',
      );
      return;
    }
    try {
      await this.api.requestChanges(p.id, note);
      d.comment = '';
      d.note = '';
      this.notices.ok(`Handed back to ${p.created_by_name ?? 'the author'}`);
      await this.refresh(p);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async saveRevision(p: Proposal): Promise<void> {
    const d = this.draft(p);
    if (d.body === p.body && d.heading === (p.heading || p.current_heading || '')) {
      this.stopEditing(p);
      return;
    }
    try {
      await this.api.revise(p.id, { body: d.body, heading: d.heading, note: d.note || undefined });
      this.notices.ok('Saved as a new revision');
      await this.refresh(p);
    } catch (e) {
      this.notices.error(e);
    }
  }

  stopEditing(p: Proposal): void {
    const d = this.draft(p);
    Object.assign(d, {
      editing: false,
      body: p.body,
      heading: p.heading || p.current_heading || '',
    });
    this.touch();
  }

  async withdraw(p: Proposal): Promise<void> {
    try {
      await this.api.withdraw(p.id);
      this.notices.ok('Withdrawn');
      this.close();
      await this.load();
    } catch (e) {
      this.notices.error(e);
    }
  }

  private blank(p: Proposal): Draft {
    return {
      editing: false,
      heading: p.heading || p.current_heading || '',
      body: p.body,
      note: '',
      comment: '',
      target: this.keyOf(p.organization_id, p.project_id, p.scope_id),
      mode: 'propose',
      targets: [],
    };
  }

  private keyOf(orgId: string | null, projectId: string | null, scopeId: string | null): string {
    return `${orgId ?? 'group'}|${projectId ?? ''}|${scopeId ?? ''}`;
  }

  private async scopesAt(orgId: string | null, projectId: string | null): Promise<Scope[]> {
    const key = `${orgId}|${projectId}`;
    if (!this.scopeCache.has(key))
      this.scopeCache.set(
        key,
        await this.api.scopes({ organization_id: orgId, project_id: projectId }),
      );
    return this.scopeCache.get(key)!;
  }

  private async prepare(p: Proposal): Promise<void> {
    const r = this.blank(p);
    if (p.kind === 'learning' && isOpen(p.status) && p.can_review)
      r.targets = await this.targetsFor(p);
    if (r.targets.length && !r.targets.some((t) => t.key === r.target))
      r.target = r.targets[r.targets.length - 1].key;
    this.drafts.update((all) => ({ ...all, [p.id]: r }));
  }

  private async load(): Promise<void> {
    try {
      const level = this.level() === 'all' ? undefined : this.level();
      const [list, counts] = await Promise.all([
        this.api.proposals(this.status(), level),
        this.api.proposalCounts(level),
      ]);
      this.drafts.set({});
      for (const p of list) await this.prepare(p);
      this.all.set(list);
      this.counts.set(counts);
    } catch (e) {
      this.notices.error(e);
    }
    this.loaded.set(true);
  }

  /** Every place this reviewer may file the learning, narrowest first. */
  private async targetsFor(p: Proposal): Promise<Target[]> {
    const group = this.session.group()?.name ?? 'Group';
    const targets: Target[] = [];
    const orgId = p.organization_id;
    if (orgId && this.session.canEdit(orgId)) {
      const org = p.organization_name ?? this.session.orgName(orgId);
      if (p.project_id) {
        for (const s of await this.scopesAt(orgId, p.project_id)) {
          targets.push({
            key: this.keyOf(orgId, p.project_id, s.id),
            label: `${p.project_name} › ${s.name}`,
            organization_id: orgId,
            project_id: p.project_id,
            scope_id: s.id,
          });
        }
        targets.push({
          key: this.keyOf(orgId, p.project_id, null),
          label: `${p.project_name}, whole project`,
          organization_id: orgId,
          project_id: p.project_id,
          scope_id: null,
        });
      }
      for (const s of await this.scopesAt(orgId, null)) {
        targets.push({
          key: this.keyOf(orgId, null, s.id),
          label: `${org} › ${s.name}, every project`,
          organization_id: orgId,
          project_id: null,
          scope_id: s.id,
        });
      }
      targets.push({
        key: this.keyOf(orgId, null, null),
        label: `${org}, everyone`,
        organization_id: orgId,
        project_id: null,
        scope_id: null,
      });
    }
    if (this.session.canEdit(null)) {
      for (const s of await this.scopesAt(null, null)) {
        targets.push({
          key: this.keyOf(null, null, s.id),
          label: `${group} › ${s.name}, every organization`,
          organization_id: null,
          project_id: null,
          scope_id: s.id,
          promote: true,
        });
      }
      targets.push({
        key: this.keyOf(null, null, null),
        label: `${group}, every organization`,
        organization_id: null,
        project_id: null,
        scope_id: null,
        promote: true,
      });
    }
    return targets;
  }

  /** After a decision, move on to the next change in the list, if any. */
  private async afterDecision(p: Proposal): Promise<void> {
    const rows = this.rows();
    const i = rows.findIndex((x) => x.id === p.id);
    const next = rows[i + 1] ?? rows[i - 1];
    this.session.me.set(await this.api.me());
    await this.load();
    if (next && this.all().some((x) => x.id === next.id)) this.open(next.id);
    else if (!this.all().some((x) => x.id === p.id)) this.close();
  }

  async approve(p: Proposal): Promise<void> {
    const r = this.draft(p);
    const t = r.targets.find((x) => x.key === r.target);
    try {
      await this.api.approve(p.id, {
        heading: r.heading !== (p.heading || p.current_heading) ? r.heading : undefined,
        body: r.body !== p.body ? r.body : undefined,
        note: r.note || undefined,
        mode: p.kind === 'edit_section' ? undefined : r.mode,
        target:
          p.kind === 'learning' && t
            ? { organization_id: t.organization_id, project_id: t.project_id, scope_id: t.scope_id }
            : undefined,
      });
      this.notices.ok(
        p.kind === 'learning'
          ? `Approved. Agents in ${t?.label ?? 'that scope'} get it from now on.`
          : 'Approved',
      );
      await this.afterDecision(p);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async reject(p: Proposal): Promise<void> {
    try {
      await this.api.reject(p.id, this.draft(p).note || undefined);
      this.notices.ok('Rejected');
      await this.afterDecision(p);
    } catch (e) {
      this.notices.error(e);
    }
  }
}
