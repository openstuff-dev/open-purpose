import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { ContextResult, Scope } from '../core/models';
import { Session } from '../core/session';
import { Icon } from './icon';
import { MarkdownView } from './markdown';
import { ModeBadge } from './mode';
import { Notices } from './notice';
import { splitList } from './scope-list';

const LAYER: Record<string, string> = {
  group: 'Group',
  'group-scope': 'Group scope',
  organization: 'Organization',
  'organization-scope': 'Organization scope',
  project: 'Project',
  'project-scope': 'Project scope',
};

/** A path an agent working in this scope would send: "frontend/**" → "frontend/app". */
function samplePath(glob: string): string {
  const clean = glob
    .replace(/\/\*\*.*$/, '')
    .replace(/\*.*$/, '')
    .replace(/\/$/, '');
  return clean || '';
}

/**
 * Exactly what an agent gets from get_context for one project, for a chosen
 * part of the code: group, organization, project and scope layers, in order.
 */
@Component({
  selector: 'app-agent-view',
  imports: [FormsModule, Icon, MarkdownView, ModeBadge, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="agent-view">
      <div class="av-pick">
        <div class="segmented" role="tablist" aria-label="Part of the code">
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="choice() === 'root'"
            (click)="pick('root')"
          >
            Whole project
          </button>
          @for (s of scopes(); track s.id) {
            <button
              type="button"
              role="tab"
              [attr.aria-selected]="choice() === s.id"
              (click)="pick(s.id)"
            >
              {{ s.name }}
            </button>
          }
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="choice() === 'custom'"
            (click)="pick('custom')"
          >
            Other path…
          </button>
        </div>
        @if (choice() === 'custom') {
          <form class="av-custom" (ngSubmit)="run()">
            <input
              name="path"
              class="mono"
              [(ngModel)]="path"
              placeholder="src/Api/Controllers/OrdersController.cs"
              aria-label="File or folder"
            />
            <input
              name="stacks"
              [(ngModel)]="stacks"
              placeholder="Stacks, e.g. dotnet, angular"
              aria-label="Stacks"
            />
            <button os-button type="submit">Show</button>
          </form>
        }
      </div>

      @if (result(); as r) {
        <div class="av-summary">
          <span
            ><span class="quiet">Path</span> <code>{{ r.path || 'repository root' }}</code></span
          >
          @if (r.stacks.length) {
            <span
              ><span class="quiet">Stacks</span>
              @for (t of r.stacks; track t) {
                <span class="chip stack">{{ t }}</span>
              }
            </span>
          }
          <span><span class="quiet">New learnings go to</span> {{ r.learning_target.label }}</span>
          <span><span class="quiet">Size</span> {{ size(r) }}</span>
          <span class="av-actions">
            <div class="segmented sm" role="tablist" aria-label="View">
              <button
                type="button"
                role="tab"
                [attr.aria-selected]="!raw()"
                (click)="raw.set(false)"
              >
                Layers
              </button>
              <button type="button" role="tab" [attr.aria-selected]="raw()" (click)="raw.set(true)">
                Exactly as sent
              </button>
            </div>
            <button os-button size="sm" type="button" (click)="copy(r.markdown)">
              <app-icon name="copy" [size]="13" />Copy
            </button>
          </span>
        </div>

        @if (raw()) {
          <pre class="raw"><code>{{ r.markdown }}</code></pre>
        } @else {
          <ol class="layers">
            @for (b of nonEmpty(); track b.label) {
              <li class="layer" [attr.data-level]="b.level">
                <div class="layer-head">
                  <span class="layer-tag">{{ layerName(b.level) }}</span>
                  <strong>{{ b.label }}</strong>
                  @if (b.scope) {
                    <span class="quiet">matched by {{ b.scope.reason }}</span>
                  }
                  <span class="quiet layer-count"
                    >{{ count(b) }} {{ count(b) === 1 ? 'section' : 'sections' }}</span
                  >
                </div>
                @for (d of b.documents; track d.id) {
                  <details
                    class="layer-doc"
                    [open]="b.level.includes('scope') || b.level === 'project'"
                  >
                    <summary>
                      {{ d.title }} <span class="quiet">· {{ d.sections.length }}</span>
                    </summary>
                    @for (s of d.sections; track s.id) {
                      <div class="layer-section">
                        <div class="layer-section-head">
                          <strong>{{ s.heading }}</strong
                          ><app-mode-badge [mode]="s.mode" />
                          @if (s.shortened) {
                            <span
                              class="flag muted"
                              title="Agents get the first sentence only, to stay within the context budget"
                              >Shortened</span
                            >
                          }
                        </div>
                        <app-md [text]="s.body" />
                      </div>
                    }
                  </details>
                }
              </li>
            } @empty {
              <li class="empty">No rules apply here yet.</li>
            }
          </ol>
          @if (r.apis.length) {
            <div class="av-apis">
              <p class="quiet">Agents can look up these APIs with <code>get_api</code>:</p>
              <ul>
                @for (s of r.apis; track s.id) {
                  <li>
                    <app-icon name="plug" [size]="13" /><strong>{{ s.name }}</strong>
                    @if (s.version) {
                      {{ s.version }}
                    }
                    <span class="quiet"
                      >· {{ s.relation === 'this' ? 'this project' : s.project_name }} ·
                      {{ s.endpoint_count }} endpoints, {{ s.schema_count }} schemas</span
                    >
                  </li>
                }
              </ul>
            </div>
          }
          @if (r.related.length) {
            <p class="quiet av-related">
              Agents are also told about {{ r.related.length }} linked
              {{ r.related.length === 1 ? 'project or term' : 'projects and terms' }} and can fetch
              them with <code>get_related</code>.
            </p>
          }
        }
      } @else if (loading()) {
        <p class="quiet">Loading…</p>
      }
    </div>
  `,
})
export class AgentView {
  readonly project = input.required<string>();
  readonly scopes = input<Scope[]>([]);
  private api = inject(Api);
  private notices = inject(Notices);
  readonly session = inject(Session);
  readonly choice = signal<string>('root');
  readonly result = signal<ContextResult | null>(null);
  readonly loading = signal(false);
  readonly raw = signal(false);
  path = '';
  stacks = '';

  readonly nonEmpty = computed(() =>
    (this.result()?.blocks ?? []).filter((b) => b.documents.length),
  );

  constructor() {
    effect(() => {
      this.project();
      untracked(() => void this.run());
    });
  }

  layerName(level: string): string {
    return LAYER[level] ?? level;
  }

  /** "~3,200 tokens of 16,000 · 4 sections shortened" */
  size(r: ContextResult): string {
    const n = (v: number) => v.toLocaleString('en-US');
    const of = r.budget.max_tokens === null ? ', no budget' : ` of ${n(r.budget.max_tokens)}`;
    const cut = r.budget.shortened
      ? ` · ${r.budget.shortened} ${r.budget.shortened === 1 ? 'section' : 'sections'} shortened`
      : '';
    return `~${n(r.budget.tokens)} tokens${of}${cut}`;
  }

  count(b: ContextResult['blocks'][number]): number {
    return b.documents.reduce((n, d) => n + d.sections.length, 0);
  }

  pick(choice: string): void {
    this.choice.set(choice);
    if (choice !== 'custom') void this.run();
  }

  async run(): Promise<void> {
    const c = this.choice();
    let path: string | undefined;
    let stacks: string[] = [];
    let scopes: string[] | undefined;
    if (c === 'custom') {
      path = this.path.trim() || undefined;
      stacks = splitList(this.stacks);
    } else if (c !== 'root') {
      const s = this.scopes().find((x) => x.id === c);
      if (s) {
        path = s.path_globs.length ? samplePath(s.path_globs[0]) || undefined : undefined;
        stacks = s.stacks;
        if (!s.path_globs.length && !s.stacks.length) scopes = [s.slug];
      }
    }
    this.loading.set(true);
    try {
      this.result.set(await this.api.context({ project: this.project(), path, stacks, scopes }));
    } catch (e) {
      this.notices.error(e);
    }
    this.loading.set(false);
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.notices.ok('Copied what agents see');
    } catch {
      this.notices.error('Copying is blocked in this browser. Select the text instead.');
    }
  }
}
