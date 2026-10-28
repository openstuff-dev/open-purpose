import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  Badge,
  Button,
  Check,
  Checkbox,
  Control,
  Field,
  Radio,
  SegmentedControl,
  Callout,
} from '@openstuff-dev/ui-angular';
import { Api, type ImportUpload } from '../core/api';
import type {
  ExportIncludes,
  ImportChange,
  ImportChangePolicy,
  ImportOrgChoice,
  ImportReport,
} from '../core/models';
import { Session } from '../core/session';
import { ContextSwitch } from '../core/switch';
import { DiffView } from '../shared/diff';
import { Icon } from '../shared/icon';
import { Notices } from '../shared/notice';

const POLICIES: Array<{ value: ImportChangePolicy; label: string; hint: string }> = [
  {
    value: 'propose',
    label: 'Propose the changes',
    hint: 'Each changed section becomes a proposal in the inbox, for someone to review.',
  },
  { value: 'file', label: 'The file wins', hint: 'Changed sections are updated right away.' },
  { value: 'keep', label: 'Keep mine', hint: 'Changed sections stay as they are here.' },
];

const STATUS: Record<ImportChange['status'], string> = {
  new: 'New',
  changed: 'Changed',
  only_in_target: 'Only here',
  conflict: 'Conflict',
};

const ACTION: Record<ImportChange['action'], string> = {
  add: 'Added',
  propose: 'Proposed',
  file: 'Updated',
  keep: 'Kept as it is',
  remove: 'Removed',
  skip: 'Left out',
};

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readUpload(file: File): Promise<ImportUpload> {
  if (file.name.toLowerCase().endsWith('.zip')) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { zip: btoa(binary) };
  }
  try {
    return { file: JSON.parse(await file.text()) };
  } catch {
    throw new Error(
      `${file.name} isn't a JSON file. Choose an OpenPurpose export (.json or .zip).`,
    );
  }
}

/** Settings › Export and import: download a group or organization, and import such a file. */
@Component({
  selector: 'app-transfer',
  imports: [
    Callout,
    FormsModule,
    Icon,
    DiffView,
    Button,
    Field,
    Control,
    Check,
    Checkbox,
    Radio,
    Badge,
    SegmentedControl,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h2>Export</h2>
      <p class="quiet">
        Download everything in {{ session.group()?.name }} or one organization, to keep as a backup
        or to import into another OpenPurpose server. A group export is a complete backup.
      </p>
      <div class="os-setting-card">
        <div class="os-setting-row" data-inline>
          <div class="os-setting-text">
            <h3>What to export</h3>
          </div>
          <select os-select name="what" [(ngModel)]="what" aria-label="What to export">
            @if (session.canAdmin(null)) {
              <option value="">
                {{ session.groupShown() ? 'The whole group' : 'Everything' }} ({{
                  session.group()?.name
                }})
              </option>
            }
            @for (o of adminOrgs(); track o.id) {
              <option [value]="o.id">{{ o.name }}</option>
            }
          </select>
        </div>
        <div class="os-setting-row" data-inline>
          <div class="os-setting-text">
            <h3>Format</h3>
            <p>
              {{
                format === 'json'
                  ? 'One file with everything. Best for backups and imports.'
                  : 'A Markdown file per document, easy to read or keep in git. Imports read the manifest.json inside.'
              }}
            </p>
          </div>
          <os-segmented-control label="Format" size="sm" [options]="formats" [(value)]="format" />
        </div>
        <div class="os-setting-row stack">
          <div class="os-setting-text">
            <h3>Include</h3>
          </div>
          <div class="transfer-includes">
            <label os-check
              ><input os-checkbox type="checkbox" name="history" [(ngModel)]="includes.history" />
              Earlier versions of every section</label
            >
            <label os-check
              ><input
                os-checkbox
                type="checkbox"
                name="proposals"
                [(ngModel)]="includes.proposals"
              />
              Proposals and their reviews</label
            >
            <label os-check
              ><input os-checkbox type="checkbox" name="apis" [(ngModel)]="includes.api_specs" />
              API specs</label
            >
            <label os-check
              ><input os-checkbox type="checkbox" name="findings" [(ngModel)]="includes.findings" />
              Findings, solved and dismissed ones too</label
            >
            <label os-check
              ><input os-checkbox type="checkbox" name="people" [(ngModel)]="includes.people" />
              Names and roles of people and agents
              <span class="quiet">(never their tokens)</span></label
            >
          </div>
        </div>
        <div class="os-setting-row" data-inline>
          <p>
            For scheduled backups, run
            <code
              >npm run -s export -w server -- --group {{ session.group()?.slug }} --out
              backup.json</code
            >
            on the server.
          </p>
          <button
            os-button
            variant="primary"
            type="button"
            (click)="exportNow()"
            [disabled]="busy()"
          >
            <app-icon name="download" />Download
          </button>
        </div>
      </div>
    </section>

    <section>
      <h2>Import</h2>
      <p class="quiet">
        Bring in an export from this or another OpenPurpose server. You see what will happen before
        anything changes.
      </p>

      @if (done(); as d) {
        <os-callout tone="success" title="Imported" role="status">
          <p>{{ summary(d) }}</p>
          <div class="form-actions">
            @if (d.group?.id) {
              <button os-button variant="primary" type="button" (click)="openGroup(d.group!.id!)">
                Switch to {{ d.group!.name }}
              </button>
            } @else {
              @for (o of d.organizations; track o.key) {
                @if (o.id) {
                  <button os-button type="button" (click)="openOrg(o.id)">
                    Open {{ o.into?.name ?? o.name }}
                  </button>
                }
              }
            }
            <button os-button type="button" (click)="done.set(null)">Done</button>
          </div>
        </os-callout>
      }

      <div class="os-setting-card">
        <div class="os-setting-row" data-inline>
          <div class="os-setting-text">
            <h3>File</h3>
            <p>{{ fileName() || 'An OpenPurpose export, .json or .zip' }}</p>
          </div>
          <label class="os-button">
            <app-icon name="upload" />{{ fileName() ? 'Choose another' : 'Choose file' }}
            <input
              type="file"
              class="sr-only"
              accept=".json,.zip,application/json,application/zip"
              (change)="pick($event)"
            />
          </label>
        </div>
        @if (session.isSuperadmin && upload()) {
          <div class="os-setting-row" data-inline>
            <div class="os-setting-text">
              <h3>Import into</h3>
              <p>
                {{
                  asGroup()
                    ? 'A new group with everything in the file, including its group-wide content. You become its admin.'
                    : 'Organizations in ' +
                      session.group()?.name +
                      ', new or merged into ones already here.'
                }}
              </p>
            </div>
            <os-segmented-control
              label="Import into"
              size="sm"
              [options]="targets"
              [value]="asGroup() ? 'new' : 'group'"
              (valueChange)="setAsGroup($event === 'new')"
            />
          </div>
        }
      </div>

      @if (report(); as r) {
        <p class="quiet transfer-source">
          Exported from {{ r.source.group.name }} on {{ r.source.exported_at.slice(0, 10) }}.
        </p>

        @if (asGroup() && r.group) {
          <form class="inline-form os-panel os-panel-body" (ngSubmit)="refresh()">
            <os-field label="Group name" class="grow"
              ><input os-input name="gname" [(ngModel)]="groupName" (change)="refresh()"
            /></os-field>
            <os-field label="Slug" class="grow"
              ><input
                os-input
                name="gslug"
                class="mono"
                [(ngModel)]="groupSlug"
                (change)="refresh()"
            /></os-field>
            @if (r.group.conflict) {
              <p class="full os-error" role="alert">
                {{ r.group.conflict }}
                <button
                  type="button"
                  os-button
                  variant="link"
                  size="sm"
                  (click)="useGroupSlug(r.group.suggested_slug!)"
                >
                  Use {{ r.group.suggested_slug }}
                </button>
              </p>
            }
          </form>
        } @else {
          <h3 class="list-label">Organizations in the file</h3>
          <ul class="transfer-orgs">
            @for (o of r.organizations; track o.key) {
              <li>
                <div>
                  <strong>{{ o.name }}</strong> <code class="quiet">{{ o.slug }}</code>
                </div>
                <select
                  os-select
                  [ngModel]="choiceValue(o.key)"
                  (ngModelChange)="choose(o.key, $event)"
                  [attr.aria-label]="'What to do with ' + o.name"
                >
                  @if (session.canAdmin(null)) {
                    <option value="new">Add as a new organization</option>
                  }
                  @for (t of adminOrgs(); track t.id) {
                    <option [value]="'merge:' + t.id">Merge into {{ t.name }}</option>
                  }
                  <option value="skip">Leave out</option>
                </select>
                @if (choices()[o.key]?.action === 'new') {
                  <os-field label="Slug" class="transfer-slug"
                    ><input
                      os-input
                      class="mono"
                      [ngModel]="o.new_slug"
                      (change)="setSlug(o.key, $any($event.target).value)"
                  /></os-field>
                }
                @if (o.conflict) {
                  <p class="os-error" role="alert">
                    {{ o.conflict }}
                    @if (o.suggested_slug) {
                      <button
                        type="button"
                        os-button
                        variant="link"
                        size="sm"
                        (click)="setSlug(o.key, o.suggested_slug)"
                      >
                        Use {{ o.suggested_slug }}
                      </button>
                    }
                  </p>
                }
              </li>
            }
          </ul>

          @if (merging()) {
            <div class="os-setting-card">
              <div class="os-setting-row stack">
                <div class="os-setting-text">
                  <h3>When a section here differs from the file</h3>
                </div>
                <div
                  class="transfer-policies"
                  role="radiogroup"
                  aria-label="When a section differs"
                >
                  @for (p of policies; track p.value) {
                    <label os-check
                      ><input
                        os-radio
                        type="radio"
                        name="policy"
                        [value]="p.value"
                        [ngModel]="changes()"
                        (ngModelChange)="setChanges($event)"
                      />
                      <span
                        ><strong>{{ p.label }}</strong>
                        <span class="quiet">{{ p.hint }}</span></span
                      ></label
                    >
                  }
                </div>
              </div>
              <div class="os-setting-row stack">
                <label os-check
                  ><input
                    os-checkbox
                    type="checkbox"
                    [ngModel]="removeMissing()"
                    (ngModelChange)="removeMissing.set($event); refresh()"
                  />
                  <span
                    ><strong>Remove what's not in the file</strong>
                    <span class="quiet"
                      >Deletes sections, documents and scopes in the merged organizations that the
                      file doesn't have, and archives such projects.</span
                    ></span
                  ></label
                >
              </div>
            </div>
          }
          @if (hasGroupContent(r) && session.canAdmin(null)) {
            <label os-check class="transfer-group-content"
              ><input
                os-checkbox
                type="checkbox"
                [ngModel]="groupContent()"
                (ngModelChange)="groupContent.set($event); refresh()"
              />
              Also merge the file's group-wide content ({{ groupContentSize(r) }}) into
              {{ session.group()?.name }}</label
            >
          }
        }

        <h3 class="list-label">What will happen</h3>
        <p>{{ summary(r) }}</p>
        @if (r.warnings.length) {
          <ul class="transfer-warnings">
            @for (w of r.warnings; track $index) {
              <li>{{ w }}</li>
            }
          </ul>
        }

        @if (r.changes.length) {
          <h3 class="list-label">Sections in merged documents</h3>
          <ul class="transfer-changes">
            @for (c of r.changes; track c.place + (c.key ?? c.target_id)) {
              <li>
                <details>
                  <summary>
                    <span os-badge [tone]="c.status === 'only_in_target' ? 'neutral' : 'warning'">{{
                      status[c.status]
                    }}</span>
                    <span class="transfer-place quiet">{{ c.place }} ›</span>
                    <strong>{{ (c.after ?? c.before)!.heading }}</strong>
                    <span class="quiet">{{ action[c.action] }}</span>
                  </summary>
                  @if (c.reason) {
                    <p class="quiet">{{ c.reason }}</p>
                  }
                  @if (c.status === 'changed' && c.key) {
                    <os-field label="For this section" class="transfer-override"
                      ><select
                        os-select
                        [ngModel]="sectionChanges()[c.key] ?? changes()"
                        (ngModelChange)="setSectionChange(c.key, $event)"
                      >
                        @for (p of policies; track p.value) {
                          <option [value]="p.value">{{ p.label }}</option>
                        }
                      </select></os-field
                    >
                  }
                  <app-diff [before]="c.before?.body ?? ''" [after]="c.after?.body ?? ''" />
                </details>
              </li>
            }
          </ul>
        }

        <div class="form-actions">
          <button
            os-button
            variant="primary"
            type="button"
            (click)="run()"
            [disabled]="busy() || !r.ok || nothingChosen(r)"
          >
            <app-icon name="upload" />Import
          </button>
          <button os-button type="button" (click)="reset()">Cancel</button>
          @if (!r.ok) {
            <span class="quiet">Fix the slugs above first.</span>
          }
        </div>
      }
    </section>
  `,
})
export class TransferPage {
  readonly session = inject(Session);
  private api = inject(Api);
  private notices = inject(Notices);
  private switcher = inject(ContextSwitch);
  private router = inject(Router);
  readonly policies = POLICIES;
  readonly status = STATUS;
  readonly action = ACTION;

  readonly adminOrgs = computed(() =>
    this.session.orgs().filter((o) => this.session.canAdmin(o.id)),
  );
  readonly busy = signal(false);

  what = this.session.canAdmin(null) ? '' : (this.adminOrgs()[0]?.id ?? '');
  format: 'json' | 'zip' = 'json';
  readonly formats = [
    { value: 'json', label: 'JSON' },
    { value: 'zip', label: 'Markdown (.zip)' },
  ] as const;
  readonly targets = [
    { value: 'group', label: 'This group' },
    { value: 'new', label: 'A new group' },
  ] as const;
  includes: ExportIncludes = {
    history: true,
    proposals: true,
    api_specs: true,
    findings: true,
    people: false,
  };

  readonly upload = signal<ImportUpload | null>(null);
  readonly fileName = signal('');
  readonly asGroup = signal(false);
  readonly report = signal<ImportReport | null>(null);
  readonly done = signal<ImportReport | null>(null);
  readonly choices = signal<Record<string, ImportOrgChoice>>({});
  readonly changes = signal<ImportChangePolicy>('propose');
  readonly sectionChanges = signal<Record<string, ImportChangePolicy>>({});
  readonly removeMissing = signal(false);
  readonly groupContent = signal(false);
  readonly merging = computed(() =>
    Object.values(this.choices()).some((c) => c.action === 'merge'),
  );
  groupName = '';
  groupSlug = '';

  async exportNow(): Promise<void> {
    this.busy.set(true);
    try {
      const { blob, name } = await this.api.exportFile({
        organizationId: this.what || null,
        format: this.format,
        includes: this.includes,
      });
      download(blob, name);
    } catch (e) {
      this.notices.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  async pick(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const upload = await readUpload(file);
      this.reset();
      this.upload.set(upload);
      this.fileName.set(file.name);
      await this.refresh(true);
    } catch (e) {
      this.notices.error(e instanceof Error && !('status' in e) ? e.message : e);
    }
  }

  setAsGroup(on: boolean): void {
    this.asGroup.set(on);
    this.groupName = '';
    this.groupSlug = '';
    void this.refresh(true);
  }

  useGroupSlug(slug: string): void {
    this.groupSlug = slug;
    void this.refresh();
  }

  choiceValue(key: string): string {
    const c = this.choices()[key];
    return !c ? 'new' : c.action === 'merge' ? `merge:${c.into}` : c.action;
  }

  choose(key: string, value: string): void {
    const choice: ImportOrgChoice = value.startsWith('merge:')
      ? { action: 'merge', into: value.slice(6) }
      : value === 'skip'
        ? { action: 'skip' }
        : { action: 'new' };
    this.choices.update((c) => ({ ...c, [key]: choice }));
    void this.refresh();
  }

  setSlug(key: string, slug: string): void {
    this.choices.update((c) => ({ ...c, [key]: { action: 'new', slug: slug.trim() } }));
    void this.refresh();
  }

  setChanges(policy: ImportChangePolicy): void {
    this.changes.set(policy);
    void this.refresh();
  }

  setSectionChange(key: string, policy: ImportChangePolicy): void {
    this.sectionChanges.update((s) => ({ ...s, [key]: policy }));
    void this.refresh();
  }

  /** Preview with the current choices. The first preview of a file also picks sensible choices. */
  async refresh(first = false): Promise<void> {
    const upload = this.upload();
    if (!upload) return;
    this.busy.set(true);
    try {
      if (this.asGroup()) {
        const r = await this.api.previewGroupImport(upload, this.groupOptions());
        if (first && r.group) {
          this.groupName = r.group.name;
          this.groupSlug = r.group.slug;
        }
        this.report.set(r);
        return;
      }
      let r = await this.api.previewImport(upload, this.importOptions());
      if (first) {
        this.choices.set(this.defaultChoices(r));
        r = await this.api.previewImport(upload, this.importOptions());
      }
      this.report.set(r);
    } catch (e) {
      this.notices.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  async run(): Promise<void> {
    const upload = this.upload();
    if (!upload) return;
    this.busy.set(true);
    try {
      const r = this.asGroup()
        ? await this.api.runGroupImport(upload, this.groupOptions())
        : await this.api.runImport(upload, this.importOptions());
      this.reset();
      this.done.set(r);
      this.session.me.set(await this.api.me());
    } catch (e) {
      this.notices.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  reset(): void {
    this.upload.set(null);
    this.fileName.set('');
    this.report.set(null);
    this.choices.set({});
    this.changes.set('propose');
    this.sectionChanges.set({});
    this.removeMissing.set(false);
    this.groupContent.set(false);
  }

  async openOrg(id: string): Promise<void> {
    await this.switcher.org(id);
    await this.router.navigate(['/organization']);
  }

  async openGroup(id: string): Promise<void> {
    await this.switcher.group(id);
    await this.router.navigate(['/']);
  }

  hasGroupContent(r: ImportReport): boolean {
    return r.group_content.documents + r.group_content.scopes + r.group_content.proposals > 0;
  }

  groupContentSize(r: ImportReport): string {
    const g = r.group_content;
    return [
      g.documents && `${g.documents} documents`,
      g.scopes && `${g.scopes} scopes`,
      g.proposals && `${g.proposals} proposals`,
    ]
      .filter(Boolean)
      .join(', ');
  }

  nothingChosen(r: ImportReport): boolean {
    return !r.group && r.organizations.every((o) => o.action === 'skip') && !this.groupContent();
  }

  /** One sentence of what the import adds and changes. */
  summary(r: ImportReport): string {
    const n = (count: number, one: string, many = `${one}s`) =>
      count ? `${count} ${count === 1 ? one : many}` : '';
    const list = (parts: string[]) => {
      const p = parts.filter(Boolean);
      return p.length < 2 ? (p[0] ?? '') : `${p.slice(0, -1).join(', ')} and ${p.at(-1)}`;
    };
    const c = r.counts;
    const m = r.merged;
    const added = list([
      n(r.organizations.filter((o) => o.action === 'new').length, 'organization'),
      n(c.projects, 'project'),
      n(c.scopes, 'scope'),
      n(c.documents, 'document'),
      n(c.sections, 'section'),
      n(c.api_specs, 'API spec'),
      n(c.proposals, 'proposal'),
      n(c.findings, 'finding'),
      n(c.people, 'person', 'people'),
    ]);
    const changed = list([
      n(m.proposed, 'proposed change'),
      n(m.updated, 'updated section'),
      n(m.removed, 'removed item'),
    ]);
    const verb = r.applied ? ['Added', 'Made'] : ['Adds', 'Makes'];
    const parts = [
      added && `${verb[0]} ${added}.`,
      changed && `${verb[1]} ${changed}.`,
      m.unchanged && `${m.unchanged} sections are already the same.`,
      m.conflicts && `${n(m.conflicts, 'section')} can't be matched.`,
    ].filter(Boolean);
    return parts.join(' ') || 'Nothing to import: everything in the file is already here.';
  }

  private importOptions() {
    return {
      organizations: this.choices(),
      changes: this.changes(),
      section_changes: this.sectionChanges(),
      remove_missing: this.removeMissing(),
      group_content: this.groupContent(),
    };
  }

  private groupOptions() {
    return { name: this.groupName.trim() || undefined, slug: this.groupSlug.trim() || undefined };
  }

  private defaultChoices(r: ImportReport): Record<string, ImportOrgChoice> {
    const out: Record<string, ImportOrgChoice> = {};
    for (const o of r.organizations) {
      if (o.existing && this.session.canAdmin(o.existing.id)) {
        out[o.key] = { action: 'merge', into: o.existing.id };
      } else if (this.session.canAdmin(null)) {
        out[o.key] = { action: 'new', slug: o.suggested_slug ?? o.slug };
      } else {
        out[o.key] = { action: 'skip' };
      }
    }
    return out;
  }
}
