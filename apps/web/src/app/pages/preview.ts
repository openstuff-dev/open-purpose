import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Button, Chip, Control, Field, Tab, Tabs } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { ContextResult, Project } from '../core/models';
import { MarkdownView } from '../shared/markdown';
import { Notices } from '../shared/notice';
import { Session } from '../core/session';
import { splitList } from '../shared/scope-list';

@Component({
  selector: 'app-preview',
  imports: [FormsModule, RouterLink, MarkdownView, Button, Field, Control, Chip, Tabs, Tab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h2>Test a repository</h2>
      <p class="quiet">
        See which project a git remote resolves to and what an agent working there would get. Useful
        when setting up a new repository. For known projects, each project page shows the same under
        “What agents see”.
      </p>
    </section>

    <form class="inline-form os-panel os-panel-body" (ngSubmit)="run()">
      <os-field label="Project"
        ><select os-select name="project" [(ngModel)]="project">
          <option value="">Find it from the git remote</option>
          @for (p of projects(); track p.id) {
            <option [value]="p.id">{{ p.name }} ({{ p.organization_name }})</option>
          }
        </select></os-field
      >
      <os-field label="Git remote URL" class="grow"
        ><input
          os-input
          name="remote"
          class="mono"
          [(ngModel)]="remote"
          [disabled]="!!project"
          placeholder="git@ssh.dev.azure.com:v3/org/project/repo"
      /></os-field>
      <os-field label="File or folder in the repository" class="full"
        ><input
          os-input
          name="path"
          class="mono"
          [(ngModel)]="path"
          placeholder="frontend/src/app/editor/toolbar.ts"
      /></os-field>
      <os-field label="Manifest file name"
        ><input
          os-input
          name="mpath"
          class="mono"
          [(ngModel)]="manifestPath"
          placeholder="frontend/package.json"
      /></os-field>
      <label class="os-field grow"
        ><span class="os-label">Stacks <span class="quiet">(optional, comma separated)</span></span
        ><input os-input name="stacks" [(ngModel)]="stacks" placeholder="angular"
      /></label>
      <label class="os-field full"
        ><span class="os-label"
          >Manifest content
          <span class="quiet"
            >(optional: paste package.json or a .csproj to detect stacks like an agent would)</span
          ></span
        ><textarea
          os-textarea
          name="manifest"
          class="mono"
          rows="4"
          [(ngModel)]="manifest"
        ></textarea>
      </label>
      <div class="form-actions full">
        <button os-button variant="primary" type="submit">Show context</button>
      </div>
    </form>

    @if (result(); as r) {
      <section class="block">
        <dl class="facts">
          <dt>Organization</dt>
          <dd>
            {{ r.organization?.name ?? 'None' }} <span class="quiet">in {{ r.group.name }}</span>
          </dd>
          <dt>Project</dt>
          <dd>
            @if (r.project) {
              <a [routerLink]="['/projects', r.project.id]">{{ r.project.name }}</a>
              <span class="quiet"
                >found via
                {{ r.resolution.via === 'project' ? 'project name' : 'git remote' }}</span
              >
            } @else {
              <span>None found.</span>
              @if (r.resolution.remote) {
                <code>{{ r.resolution.remote.key }}</code> is not mapped to a project.
              }
            }
          </dd>
          <dt>Stacks</dt>
          <dd>
            @for (t of r.stacks; track t) {
              <span os-chip>{{ t }}</span>
            } @empty {
              <span class="quiet">None</span>
            }
          </dd>
          <dt>Scopes</dt>
          <dd>
            @for (b of scoped(r); track b.label) {
              <span os-chip>{{ b.label }}</span>
              <span class="quiet">{{ b.scope?.reason }}</span
              ><br />
            } @empty {
              <span class="quiet">No scope matched</span>
            }
          </dd>
          <dt>New learnings go to</dt>
          <dd>{{ r.learning_target.label }}</dd>
          <dt>Size</dt>
          <dd>{{ size(r) }}</dd>
        </dl>
        <div class="preview-copy">
          <button type="button" os-button variant="link" size="sm" (click)="copy(r.markdown)">
            Copy
          </button>
        </div>
        <os-tabs label="Show the context">
          <ng-template os-tab="rendered" label="Rendered">
            <app-md class="preview-render" [text]="r.markdown" />
          </ng-template>
          <ng-template os-tab="raw" label="Exactly as sent">
            <pre class="raw"><code>{{ r.markdown }}</code></pre>
          </ng-template>
        </os-tabs>
      </section>
    }
  `,
})
export class PreviewPage {
  readonly session = inject(Session);
  private api = inject(Api);
  private notices = inject(Notices);
  readonly projects = signal<Project[]>([]);
  readonly result = signal<ContextResult | null>(null);
  project = '';
  remote = '';
  path = '';
  stacks = '';
  manifestPath = '';
  manifest = '';

  constructor() {
    void this.api
      .projects()
      .then((p) => { this.projects.set(p); })
      .catch((e: unknown) => {
        this.notices.error(e);
      });
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

  scoped(r: ContextResult) {
    return r.blocks.filter((b) => b.scope);
  }

  async run(): Promise<void> {
    try {
      this.result.set(
        await this.api.context({
          project: this.project || undefined,
          remote_url: this.project ? undefined : this.remote.trim() || undefined,
          path: this.path.trim() || undefined,
          stacks: splitList(this.stacks),
          manifests: this.manifest.trim()
            ? [{ path: this.manifestPath.trim() || 'package.json', content: this.manifest }]
            : undefined,
        }),
      );
    } catch (e) {
      this.notices.error(e);
    }
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.notices.ok('Copied context');
    } catch {
      this.notices.error('Copying is blocked in this browser. Select the text instead.');
    }
  }
}
