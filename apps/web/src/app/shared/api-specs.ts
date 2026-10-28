import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Button,
  Chip,
  ConfirmDialog,
  Control,
  Field,
  SegmentedControl,
} from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { ApiSpec, ApiSpecDetail } from '../core/models';
import { Icon } from './icon';
import { MarkdownView } from './markdown';
import { Notices } from './notice';

const MAX_BYTES = 20 * 1024 * 1024;

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/**
 * A project's OpenAPI / Swagger specs: add them from a link or a file, keep
 * them fresh, and browse them exactly as agents get them from get_api.
 */
@Component({
  selector: 'app-api-specs',
  imports: [
    FormsModule,
    DatePipe,
    Icon,
    MarkdownView,
    Button,
    Field,
    Control,
    Chip,
    SegmentedControl,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (specs().length) {
      <ul class="api-list">
        @for (s of specs(); track s.id) {
          <li class="api-card" [class.open]="openId() === s.id">
            <button
              type="button"
              class="api-card-main"
              (click)="toggle(s.id)"
              [attr.aria-expanded]="openId() === s.id"
            >
              <span class="api-icon"><app-icon name="plug" [size]="16" /></span>
              <span class="api-text">
                <span class="api-name"
                  >{{ s.name }}
                  @if (s.version) {
                    <span class="quiet">{{ s.version }}</span>
                  }
                </span>
                <span class="api-sub">
                  <span os-chip>{{ s.spec_version }}</span>
                  {{ s.endpoint_count }} endpoints · {{ s.schema_count }} schemas ·
                  @if (s.source_url) {
                    <span [title]="s.source_url">from link, fetched {{ ago(s.fetched_at) }}</span>
                  } @else {
                    <span
                      >file {{ s.filename }}, updated {{ s.updated_at | date: 'd MMM' }}
                      @if (s.updated_by_name) {
                        by {{ s.updated_by_name }}
                      }
                    </span>
                  }
                </span>
                @if (s.fetch_error) {
                  <span class="api-error"
                    ><app-icon name="x" [size]="12" />Last fetch failed: {{ s.fetch_error }}. Agents
                    get the last version that worked.</span
                  >
                }
              </span>
              <app-icon name="chevron-down" [size]="16" class="api-chevron" />
            </button>

            @if (openId() === s.id) {
              <div class="api-body">
                <div class="api-actions">
                  @if (s.source_url) {
                    <code class="api-url" [title]="s.source_url">{{ s.source_url }}</code>
                  }
                  <span class="api-actions-btns">
                    @if (canEdit() && s.source_url) {
                      <button
                        os-button
                        size="sm"
                        type="button"
                        (click)="refresh(s)"
                        [disabled]="busy()"
                      >
                        Fetch now
                      </button>
                    }
                    @if (canEdit()) {
                      <label class="os-button file-btn" data-size="sm"
                        >Replace with file<input
                          type="file"
                          accept=".json,.yaml,.yml,application/json,application/yaml"
                          (change)="replace(s, $event)"
                      /></label>
                    }
                    <button os-button size="sm" type="button" (click)="download(s)">
                      <app-icon name="copy" [size]="13" />Download
                    </button>
                    @if (canEdit()) {
                      <button
                        os-button
                        variant="danger"
                        size="sm"
                        type="button"
                        (click)="remove(s)"
                      >
                        Remove
                      </button>
                    }
                  </span>
                </div>

                @if (detail(); as d) {
                  <div class="api-browser">
                    <nav class="api-nav" aria-label="Endpoints and schemas">
                      <label class="search-field"
                        ><app-icon name="search" />
                        <input
                          os-input
                          type="search"
                          placeholder="Filter endpoints and schemas"
                          aria-label="Filter"
                          [ngModel]="filter()"
                          (ngModelChange)="filter.set($event)"
                        />
                      </label>
                      <button
                        type="button"
                        class="api-nav-item overview"
                        [class.active]="!view()"
                        (click)="show(null)"
                      >
                        Overview <span class="quiet">all endpoints</span>
                      </button>
                      @for (g of groups(); track g.tag) {
                        <div class="api-nav-tag">{{ g.tag }}</div>
                        @for (op of g.ops; track op.key) {
                          <button
                            type="button"
                            class="api-nav-item"
                            [class.active]="view()?.endpoint === op.key"
                            (click)="show({ endpoint: op.key })"
                            [title]="op.summary"
                          >
                            <span class="method" [attr.data-method]="op.method">{{
                              op.method
                            }}</span>
                            <span class="api-path" [class.deprecated]="op.deprecated">{{
                              op.path
                            }}</span>
                          </button>
                        }
                      }
                      @if (schemas().length) {
                        <div class="api-nav-tag">Schemas</div>
                        @for (n of schemas(); track n) {
                          <button
                            type="button"
                            class="api-nav-item"
                            [class.active]="view()?.schema === n"
                            (click)="show({ schema: n })"
                          >
                            <span class="method schema">DTO</span
                            ><span class="api-path">{{ n }}</span>
                          </button>
                        }
                      }
                      @if (!groups().length && !schemas().length) {
                        <p class="quiet">Nothing matches.</p>
                      }
                    </nav>
                    <div class="api-view">
                      <p class="api-view-note">
                        <app-icon name="bot" [size]="13" />What an agent gets from
                        <code>get_api</code>
                        @if (view()?.endpoint) {
                          <code>endpoint: "{{ view()!.endpoint }}"</code>
                        } @else if (view()?.schema) {
                          <code>schema: "{{ view()!.schema }}"</code>
                        }
                      </p>
                      @if (text(); as t) {
                        <app-md class="api-md" [text]="t" />
                      } @else {
                        <p class="quiet">Loading…</p>
                      }
                    </div>
                  </div>
                } @else {
                  <p class="quiet">Loading…</p>
                }
              </div>
            }
          </li>
        }
      </ul>
    } @else {
      <p class="empty">
        No API spec yet. Add the project's <code>swagger.json</code> or
        <code>openapi.yaml</code> and agents get its endpoints and DTOs, here and in every project
        that uses this one.
      </p>
    }

    @if (canEdit()) {
      <form class="api-add" (ngSubmit)="add()">
        <div class="api-add-head">
          <h3>Add an API spec</h3>
          <os-segmented-control label="Source" size="sm" [options]="sources" [(value)]="mode" />
        </div>
        <div class="inline-form">
          @if (mode() === 'url') {
            <os-field label="URL of swagger.json or openapi.yaml" class="grow"
              ><input
                os-input
                name="url"
                class="mono"
                type="url"
                [(ngModel)]="url"
                placeholder="https://orders.acme.internal/swagger/v1/swagger.json"
            /></os-field>
          } @else {
            <label class="grow"
              >File (JSON or YAML)
              <input
                name="file"
                type="file"
                accept=".json,.yaml,.yml,application/json,application/yaml"
                (change)="pickFile($event)"
            /></label>
          }
          <label class="os-field"
            ><span class="os-label">Name <span class="quiet">(optional)</span></span
            ><input
              os-input
              name="name"
              [(ngModel)]="name"
              placeholder="Defaults to the spec's title"
          /></label>
          <div class="form-actions">
            <button
              os-button
              variant="primary"
              type="submit"
              [disabled]="busy() || (mode() === 'url' ? !url.trim() : !file())"
            >
              <app-icon name="plus" />Add API
            </button>
          </div>
        </div>
        <p class="quiet api-add-hint">
          @if (mode() === 'url') {
            OpenPurpose fetches the link now, and again in the background when agents read it and
            it's over an hour old. The server must be able to reach it.
          } @else {
            OpenAPI 3 or Swagger 2, up to 20 MB. Upload a new version whenever the API changes.
          }
        </p>
      </form>
    }
  `,
})
export class ApiSpecs {
  readonly projectId = input.required<string>();
  readonly specs = input<ApiSpec[]>([]);
  readonly canEdit = input(false);
  readonly changed = output<void>();
  private api = inject(Api);
  private readonly confirmDialog = inject(ConfirmDialog);
  private notices = inject(Notices);
  readonly ago = ago;

  readonly openId = signal<string | null>(null);
  readonly detail = signal<ApiSpecDetail | null>(null);
  readonly view = signal<{ endpoint?: string; schema?: string } | null>(null);
  readonly text = signal<string | null>(null);
  readonly filter = signal('');
  readonly busy = signal(false);
  readonly mode = signal<'url' | 'file'>('url');
  readonly sources = [
    { value: 'url', label: 'From a link' },
    { value: 'file', label: 'Upload a file' },
  ] as const;
  readonly file = signal<File | null>(null);
  url = '';
  name = '';

  readonly groups = computed(() => {
    const d = this.detail();
    if (!d) return [];
    const q = this.filter().trim().toLowerCase();
    const m = new Map<string, ApiSpecDetail['operations']>();
    for (const op of d.operations) {
      if (
        q &&
        !`${op.key} ${op.summary} ${op.operation_id} ${op.tags.join(' ')}`.toLowerCase().includes(q)
      )
        continue;
      const tag = op.tags[0] ?? 'Other';
      m.set(tag, [...(m.get(tag) ?? []), op]);
    }
    return [...m].map(([tag, ops]) => ({ tag, ops }));
  });
  readonly schemas = computed(() => {
    const q = this.filter().trim().toLowerCase();
    return (this.detail()?.schemas ?? []).filter((n) => !q || n.toLowerCase().includes(q));
  });

  constructor() {
    // Open the only spec straight away.
    effect(() => {
      const list = this.specs();
      untracked(() => {
        if (this.openId() && !list.some((s) => s.id === this.openId())) this.openId.set(null);
        if (!this.openId() && list.length === 1) void this.open(list[0].id);
      });
    });
  }

  toggle(id: string): void {
    if (this.openId() === id) this.openId.set(null);
    else void this.open(id);
  }

  private async open(id: string): Promise<void> {
    this.openId.set(id);
    this.detail.set(null);
    this.filter.set('');
    try {
      this.detail.set(await this.api.apiSpec(id));
      await this.show(null);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async show(v: { endpoint?: string; schema?: string } | null): Promise<void> {
    const id = this.openId();
    if (!id) return;
    this.view.set(v);
    this.text.set(null);
    try {
      this.text.set((await this.api.apiText(id, v ?? {})).text);
    } catch (e) {
      this.notices.error(e);
    }
  }

  pickFile(ev: Event): void {
    this.file.set((ev.target as HTMLInputElement).files?.[0] ?? null);
  }

  private async readFile(f: File): Promise<string> {
    if (f.size > MAX_BYTES) throw new Error('The file is larger than 20 MB');
    return f.text();
  }

  async add(): Promise<void> {
    this.busy.set(true);
    try {
      const body =
        this.mode() === 'url'
          ? { url: this.url.trim(), name: this.name.trim() || undefined }
          : {
              content: await this.readFile(this.file()!),
              filename: this.file()!.name,
              name: this.name.trim() || undefined,
            };
      const s = await this.api.addApi(this.projectId(), body);
      this.notices.ok(`Added ${s.name}: ${s.endpoint_count} endpoints, ${s.schema_count} schemas`);
      this.url = '';
      this.name = '';
      this.file.set(null);
      this.openId.set(s.id);
      this.changed.emit();
      void this.open(s.id);
    } catch (e) {
      this.notices.error(e);
    }
    this.busy.set(false);
  }

  async refresh(s: ApiSpec): Promise<void> {
    this.busy.set(true);
    try {
      const r = await this.api.refreshApi(s.id);
      if (r.fetch_error) this.notices.error(`Couldn't fetch: ${r.fetch_error}`);
      else this.notices.ok(`Fetched ${r.name}: ${r.endpoint_count} endpoints`);
      this.changed.emit();
      void this.open(s.id);
    } catch (e) {
      this.notices.error(e);
    }
    this.busy.set(false);
  }

  async replace(s: ApiSpec, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const r = await this.api.updateApi(s.id, {
        content: await this.readFile(f),
        filename: f.name,
      });
      this.notices.ok(
        `Replaced ${r.name}: ${r.endpoint_count} endpoints, ${r.schema_count} schemas`,
      );
      this.changed.emit();
      void this.open(s.id);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async download(s: ApiSpec): Promise<void> {
    try {
      const raw = await this.api.apiRaw(s.id);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      a.download = (s.filename ?? `${s.name}.json`).replace(/\.ya?ml$/i, '.json');
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async remove(s: ApiSpec): Promise<void> {
    const remove = await this.confirmDialog.confirm({
      title: `Remove ${s.name}?`,
      message: 'Agents no longer get its endpoints and DTOs.',
      confirmLabel: 'Remove API',
      danger: true,
    });
    if (!remove) return;
    try {
      await this.api.deleteApi(s.id);
      this.notices.ok(`Removed ${s.name}`);
      this.changed.emit();
    } catch (e) {
      this.notices.error(e);
    }
  }
}
