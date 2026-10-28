import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  Badge,
  Button,
  Chip,
  ConfirmDialog,
  Control,
  Field,
  Callout,
  EmptyState,
} from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import {
  KIND_LABEL,
  MODE_HELP,
  MODE_LABEL,
  type DocDetail,
  type EditMode,
  type GraphNode,
  type LinkRef,
  type Section,
  type SectionVersion,
} from '../core/models';
import { Session, provideHere } from '../core/session';
import { MarkdownView } from '../shared/markdown';
import { MarkdownEditor } from '../shared/md-editor';
import { ModeBadge, ModePicker } from '../shared/mode';
import { Notices } from '../shared/notice';
import { Icon } from '../shared/icon';
import { ActivityFigure, StatStyleSwitch } from '../shared/activity-figure';
import { dateTime, lastDays, since } from '../core/time';

interface Draft {
  heading: string;
  body: string;
  note: string;
}

@Component({
  selector: 'app-document',
  imports: [
    EmptyState,
    Callout,
    FormsModule,
    RouterLink,
    DatePipe,
    MarkdownView,
    MarkdownEditor,
    ModeBadge,
    ModePicker,
    Icon,
    ActivityFigure,
    StatStyleSwitch,
    Button,
    Field,
    Control,
    Chip,
    Badge,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (doc(); as d) {
      <header class="page-head doc-head">
        <nav class="crumbs" aria-label="Breadcrumb">
          @if (session.groupShown() || !d.organization) {
            <a routerLink="/group">{{ session.group()?.name }}</a>
          }
          @if (d.organization; as o) {
            <a routerLink="/organization">{{ o.name }}</a>
          }
          @if (d.project; as p) {
            <a [routerLink]="['/projects', p.id]">{{ p.name }}</a>
          }
          @if (d.scope; as s) {
            <a [routerLink]="['/scopes', s.id]">{{ s.name }}</a>
          }
        </nav>
        @if (editingTitle()) {
          <form class="title-form" (ngSubmit)="saveTitle()">
            <input
              os-input
              name="title"
              [(ngModel)]="titleDraft"
              aria-label="Document title"
              required
            />
            <button os-button variant="primary" type="submit">Save</button>
            <button os-button type="button" (click)="editingTitle.set(false)">Cancel</button>
          </form>
        } @else {
          <div class="title-row">
            <h1>{{ d.title }}</h1>
            @if (d.can_edit) {
              <button
                os-button
                type="button"
                (click)="titleDraft = d.title; editingTitle.set(true)"
              >
                <app-icon name="pencil" />Rename
              </button>
              <button
                os-button
                variant="danger"
                type="button"
                (click)="removeDoc()"
                aria-label="Delete document"
              >
                <app-icon name="trash" />
              </button>
            }
          </div>
        }
        <p class="meta">
          <span os-chip>{{ kindLabel[d.kind] }}</span>
          <span>{{ where() }}</span>
          <span
            >{{ d.sections.length }} {{ d.sections.length === 1 ? 'section' : 'sections' }}</span
          >
        </p>
        @if (d.kind === 'glossary') {
          <p class="quiet">
            Each section is one term. Anyone can link to it with <code>[[Term name]]</code>, and it
            shows up on the map.
          </p>
        }
        <div class="doc-mode">
          <span>New sections from agents</span>
          @if (d.can_edit) {
            <app-mode-picker
              [mode]="d.mode"
              (changed)="setDocMode($event)"
              label="What agents may do when adding sections"
            />
          } @else {
            <app-mode-badge [mode]="d.mode" />
          }
          <span class="quiet">{{ modeHelp[d.mode] }}</span>
        </div>
        @if (d.disabled_at) {
          <os-callout tone="neutral" title="Disabled" role="status">
            Agents don't get this document, so it costs no tokens. People can still read and edit
            it.
            @if (d.can_edit) {
              <button os-button os-actions type="button" (click)="setDisabled(false)">
                Enable
              </button>
            }
          </os-callout>
        } @else if (d.staleness) {
          <os-callout tone="warning" role="status">
            <p>
              Agents haven't requested this document in the last
              {{ d.staleness === 'month' ? 'month' : 'week' }}. Disable it to stop sending it to
              agents and save tokens. You can turn it back on at any time.
            </p>
            @if (d.can_edit) {
              <button os-button os-actions type="button" (click)="setDisabled(true)">
                <app-icon name="eye-off" />Disable document
              </button>
            }
          </os-callout>
        }
      </header>

      <div class="sections-head">
        <span class="quiet">Agent requests per section</span>
        <app-stat-style-switch />
      </div>
      <div class="sections">
        @for (s of d.sections; track s.id; let first = $first; let last = $last) {
          <article class="section" [attr.data-mode]="s.mode" [id]="'s-' + s.id.slice(0, 8)">
            @if (editing() === s.id) {
              <form class="section-edit" (ngSubmit)="saveSection(s)">
                <os-field label="Heading"
                  ><input os-input name="heading" [(ngModel)]="draft.heading" required
                /></os-field>
                <app-md-editor
                  [(value)]="draft.body"
                  [rows]="10"
                  label="Section text"
                  [fromProject]="d.project_id"
                  [fromOrganization]="d.organization_id"
                />
                <label class="os-field"
                  ><span class="os-label"
                    >Note for history <span class="quiet">(optional)</span></span
                  ><input
                    os-input
                    name="note"
                    [(ngModel)]="draft.note"
                    placeholder="What changed and why"
                /></label>
                <div class="form-actions">
                  <button
                    os-button
                    variant="primary"
                    type="submit"
                    [disabled]="!draft.heading.trim()"
                  >
                    Save section
                  </button>
                  <button os-button type="button" (click)="editing.set(null)">Cancel</button>
                </div>
              </form>
            } @else {
              <header class="section-head">
                <h2>{{ s.heading }}</h2>
                @if (d.can_edit) {
                  <app-mode-picker
                    [mode]="s.mode"
                    (changed)="setSectionMode(s, $event)"
                    [label]="'What agents may do with ' + s.heading"
                  />
                } @else {
                  <app-mode-badge [mode]="s.mode" />
                }
              </header>
              <app-md
                [text]="s.body"
                [fromProject]="d.project_id"
                [fromOrganization]="d.organization_id"
              />
              <footer class="section-foot">
                <span
                  >Version {{ s.version }}
                  @if (s.updated_by_name) {
                    , by {{ s.updated_by_name }}
                  }
                  , {{ s.updated_at | date: 'd MMM y, HH:mm' }}</span
                >
                <span class="section-reads">
                  @if (s.activity.last_read_at; as last) {
                    Requested
                    <app-activity-figure
                      size="sm"
                      [count]="s.activity.reads"
                      [previous]="s.activity.previous_week"
                      [current]="s.activity.week"
                      [daily]="s.activity.daily"
                      [days]="days28"
                      compare="the week before"
                      unit="requests"
                      [title]="
                        s.activity.week +
                        ' this week, ' +
                        s.activity.previous_week +
                        ' the week before'
                      "
                    />
                    {{ s.activity.reads === 1 ? 'time' : 'times' }} by agents, last
                    <time [attr.datetime]="last" [title]="dateTime(last)">{{ since(last) }}</time>
                    @if (quietFor30Days(last)) {
                      <span os-badge tone="warning">Not requested in the last month</span>
                    }
                  } @else {
                    <span class="quiet">Not requested by agents yet</span>
                  }
                </span>
                <code class="sid" title="Section id agents use">s:{{ s.id.slice(0, 8) }}</code>
                <span class="section-actions">
                  @if (d.can_edit) {
                    <button os-button variant="link" size="sm" type="button" (click)="startEdit(s)">
                      Edit
                    </button>
                  }
                  <button
                    os-button
                    variant="link"
                    size="sm"
                    type="button"
                    (click)="toggleHistory(s)"
                    [attr.aria-expanded]="historyFor() === s.id"
                  >
                    History
                  </button>
                  @if (d.kind === 'glossary') {
                    <button
                      os-button
                      variant="link"
                      size="sm"
                      type="button"
                      (click)="toggleRefs(s)"
                      [attr.aria-expanded]="refsFor() === s.id"
                    >
                      References
                    </button>
                  }
                  @if (d.can_edit) {
                    <button
                      os-button
                      variant="link"
                      size="sm"
                      type="button"
                      [disabled]="first"
                      (click)="move(s, -1)"
                      aria-label="Move up"
                    >
                      Up
                    </button>
                    <button
                      os-button
                      variant="link"
                      size="sm"
                      type="button"
                      [disabled]="last"
                      (click)="move(s, 1)"
                      aria-label="Move down"
                    >
                      Down
                    </button>
                    <button
                      os-button
                      variant="link"
                      size="sm"
                      class="danger"
                      type="button"
                      (click)="removeSection(s)"
                    >
                      Delete
                    </button>
                  }
                </span>
              </footer>
              @if (historyFor() === s.id) {
                <ol class="history" reversed>
                  @for (v of versions(); track v.id) {
                    <li>
                      <details>
                        <summary>
                          Version {{ v.version }}, {{ v.actor_name ?? 'system' }},
                          {{ v.created_at | date: 'd MMM y, HH:mm' }}
                          @if (v.note) {
                            <span class="quiet">: {{ v.note }}</span>
                          }
                        </summary>
                        <p class="quiet">{{ v.heading }}, {{ modeNames[v.mode] }}</p>
                        <app-md [text]="v.body" />
                        @if (d.can_edit && v.version !== s.version) {
                          <button os-button type="button" (click)="revert(s, v.version)">
                            Restore version {{ v.version }}
                          </button>
                        }
                      </details>
                    </li>
                  }
                </ol>
              }
              @if (refsFor() === s.id) {
                <div class="refs">
                  @for (r of refs(); track r.source.id) {
                    <p>
                      <a
                        [routerLink]="
                          r.source.type === 'project'
                            ? ['/projects', r.source.project_id]
                            : r.source.type === 'group'
                              ? ['/group']
                              : ['/organization']
                        "
                        >{{ r.source.label }}</a
                      >
                      <span class="quiet">in {{ refText(r.refs) }}</span>
                    </p>
                  } @empty {
                    <p class="quiet">Nothing links to this term yet.</p>
                  }
                </div>
              }
            }
          </article>
        } @empty {
          <os-empty-state title="No sections yet" bordered />
        }
      </div>

      @if (d.can_edit) {
        @if (adding()) {
          <form class="section-edit add" (ngSubmit)="addSection()">
            <os-field label="Heading"
              ><input
                os-input
                name="heading"
                [(ngModel)]="newDraft.heading"
                required
                [placeholder]="
                  d.kind === 'glossary' ? 'Term, e.g. Order' : 'One rule or topic per section'
                "
            /></os-field>
            <app-md-editor
              [(value)]="newDraft.body"
              [rows]="8"
              label="Section text"
              [fromProject]="d.project_id"
              [fromOrganization]="d.organization_id"
            />
            <div class="doc-mode">
              <span>Agents may</span>
              <app-mode-picker
                [mode]="newMode()"
                (changed)="newMode.set($event)"
                label="What agents may do with the new section"
              />
            </div>
            <div class="form-actions">
              <button
                os-button
                variant="primary"
                type="submit"
                [disabled]="!newDraft.heading.trim()"
              >
                Add section
              </button>
              <button os-button type="button" (click)="adding.set(false)">Cancel</button>
            </div>
          </form>
        } @else {
          <button os-button type="button" (click)="startAdd()">
            <app-icon name="plus" />Add section
          </button>
        }
      }
    }
  `,
})
export class DocumentPage {
  readonly id = input.required<string>();
  readonly session = inject(Session);
  private readonly confirmDialog = inject(ConfirmDialog);
  private api = inject(Api);
  private router = inject(Router);
  private notices = inject(Notices);
  readonly doc = signal<DocDetail | null>(null);
  readonly editing = signal<string | null>(null);
  readonly historyFor = signal<string | null>(null);
  readonly refsFor = signal<string | null>(null);
  readonly versions = signal<SectionVersion[]>([]);
  readonly refs = signal<Array<{ source: GraphNode; refs: LinkRef[] }>>([]);
  readonly adding = signal(false);
  readonly editingTitle = signal(false);
  readonly newMode = signal<EditMode>('propose');
  readonly kindLabel = KIND_LABEL;
  readonly modeHelp = MODE_HELP;
  readonly modeNames = MODE_LABEL;
  draft: Draft = { heading: '', body: '', note: '' };
  newDraft = { heading: '', body: '' };
  titleDraft = '';
  readonly since = since;
  readonly dateTime = dateTime;
  readonly days28 = lastDays(28);

  quietFor30Days(lastRead: string): boolean {
    return Date.now() - new Date(lastRead).getTime() > 30 * 86_400_000;
  }

  async setDisabled(disabled: boolean): Promise<void> {
    try {
      await this.api.updateDocument(this.id(), { disabled });
      this.notices.ok(
        disabled ? 'Disabled. Agents no longer get this document' : 'Enabled. Agents get it again',
      );
      await this.reload();
    } catch (e) {
      this.notices.error(e);
    }
  }

  readonly where = computed(() => {
    const d = this.doc();
    if (!d) return '';
    const org = d.organization?.name;
    if (d.scope)
      return d.project
        ? `Only in ${d.project.name} › ${d.scope.name}`
        : org
          ? `${d.scope.name}, across ${org}`
          : `${d.scope.name}, in every organization`;
    if (d.project) return `All of ${d.project.name}`;
    return org
      ? `Every project in ${org}`
      : `Every organization in ${this.session.group()?.name ?? 'the group'}`;
  });

  constructor() {
    effect(() => void this.load(this.id()));
    provideHere(() => {
      const x = this.doc();
      return x ? { project: x.project, organization: x.organization } : null;
    });
  }

  private async load(id: string): Promise<void> {
    try {
      this.doc.set(await this.api.document(id));
    } catch (e) {
      this.notices.error(e);
    }
  }

  private async reload(): Promise<void> {
    await this.load(this.id());
  }

  startEdit(s: Section): void {
    this.draft = { heading: s.heading, body: s.body, note: '' };
    this.historyFor.set(null);
    this.editing.set(s.id);
  }

  startAdd(): void {
    this.newDraft = { heading: '', body: '' };
    this.newMode.set(this.doc()!.mode);
    this.adding.set(true);
  }

  async saveSection(s: Section): Promise<void> {
    try {
      await this.api.updateSection(s.id, {
        heading: this.draft.heading,
        body: this.draft.body,
        note: this.draft.note || undefined,
        expected_version: s.version,
      });
      this.editing.set(null);
      this.notices.ok('Saved section');
      await this.reload();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async setSectionMode(s: Section, mode: EditMode): Promise<void> {
    try {
      await this.api.updateSection(s.id, {
        mode,
        expected_version: s.version,
        note: `Mode set to ${mode}`,
      });
      this.notices.ok(`${s.heading}: ${MODE_HELP[mode]}`);
      await this.reload();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async setDocMode(mode: EditMode): Promise<void> {
    try {
      await this.api.updateDocument(this.id(), { mode });
      await this.reload();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async saveTitle(): Promise<void> {
    try {
      await this.api.updateDocument(this.id(), { title: this.titleDraft.trim() });
      this.editingTitle.set(false);
      await this.reload();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async addSection(): Promise<void> {
    try {
      await this.api.addSection(this.id(), {
        heading: this.newDraft.heading.trim(),
        body: this.newDraft.body,
        mode: this.newMode(),
      });
      this.adding.set(false);
      this.notices.ok('Added section');
      await this.reload();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async toggleHistory(s: Section): Promise<void> {
    if (this.historyFor() === s.id) {
      this.historyFor.set(null);
      return;
    }
    try {
      this.versions.set(await this.api.versions(s.id));
      this.historyFor.set(s.id);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async toggleRefs(s: Section): Promise<void> {
    if (this.refsFor() === s.id) {
      this.refsFor.set(null);
      return;
    }
    try {
      this.refs.set(await this.api.backlinks({ node: `term:${s.id}` }));
      this.refsFor.set(s.id);
    } catch (e) {
      this.notices.error(e);
    }
  }

  refText(refs: LinkRef[]): string {
    return refs.map((r) => `“${r.heading}”`).join(', ');
  }

  async revert(s: Section, version: number): Promise<void> {
    try {
      await this.api.revert(s.id, version);
      this.historyFor.set(null);
      this.notices.ok(`Restored version ${version}`);
      await this.reload();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async move(s: Section, delta: number): Promise<void> {
    const ids = this.doc()!.sections.map((x) => x.id);
    const i = ids.indexOf(s.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try {
      await this.api.reorder(this.id(), ids);
      await this.reload();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async removeSection(s: Section): Promise<void> {
    const remove = await this.confirmDialog.confirm({
      title: `Delete “${s.heading}”?`,
      message: 'Its history is deleted too.',
      confirmLabel: 'Delete section',
      danger: true,
    });
    if (!remove) return;
    try {
      await this.api.deleteSection(s.id);
      this.notices.ok('Deleted section');
      await this.reload();
    } catch (e) {
      this.notices.error(e);
    }
  }

  async removeDoc(): Promise<void> {
    const d = this.doc()!;
    const remove = await this.confirmDialog.confirm({
      title: `Delete “${d.title}”?`,
      message: 'All its sections are deleted too.',
      confirmLabel: 'Delete document',
      danger: true,
    });
    if (!remove) return;
    try {
      await this.api.deleteDocument(d.id);
      this.notices.ok(`Deleted ${d.title}`);
      await this.router.navigate(
        d.scope
          ? ['/scopes', d.scope.id]
          : d.project
            ? ['/projects', d.project.id]
            : d.organization
              ? ['/organization']
              : ['/group'],
      );
    } catch (e) {
      this.notices.error(e);
    }
  }
}
