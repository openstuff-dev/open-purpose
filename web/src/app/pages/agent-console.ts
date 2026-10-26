import { ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Api } from '../core/api';
import type { Project } from '../core/models';
import { Session } from '../core/session';
import { Notices } from '../shared/notice';
import { splitList } from '../shared/scope-list';

type Args = Record<string, unknown>;

interface Call {
  id: number;
  name: string;
  args: Args;
  text: string | null;
  error: boolean;
  /** Calls the output points to, offered as buttons. */
  next: Array<{ name: string; args: Args }>;
}

/** "get_context(project="x", path="y")": a tool call written the way it reads in a transcript. */
function signature(name: string, args: Args): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `${name}(${parts.join(', ')})`;
}

/**
 * Tool calls an agent could make next, read from markers the tools themselves print:
 * section ids, `get_api project="…"`, project refs in backticks and endpoint lines.
 */
function followUps(call: { name: string; args: Args; text: string }): Array<{ name: string; args: Args }> {
  const text = call.text;
  const out = new Map<string, { name: string; args: Args }>();
  const add = (name: string, args: Args) => out.set(signature(name, args), { name, args });
  for (const m of text.matchAll(/\[s:([0-9a-f]{8})\b|"section_id": "([0-9a-f]{8})"/g)) add('read_section', { section_id: m[1] ?? m[2] });
  for (const m of text.matchAll(/get_api project="([^"]+)"(?: api="([^"]+)")?/g)) add('get_api', m[2] ? { project: m[1], api: m[2] } : { project: m[1] });
  for (const m of text.matchAll(/\(`([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?)`\)|"ref": "([^"]+)"/g)) {
    const project = m[1] ?? m[2];
    add('get_context', { project });
    add('get_related', { project });
  }
  if (call.name === 'get_api' && call.args['project']) {
    const base: Args = { project: call.args['project'], ...(call.args['api'] ? { api: call.args['api'] } : {}) };
    for (const m of text.matchAll(/^- `([A-Z]+ \/[^`]*)`/gm)) add('get_api', { ...base, endpoint: m[1] });
    for (const m of text.matchAll(/^- \*\*([^*]+)\*\* \(\d+\)$/gm)) add('get_api', { ...base, tag: m[1] });
  }
  // A call never suggests itself.
  out.delete(signature(call.name, call.args));
  return [...out.values()].slice(0, 40);
}

/**
 * Agent mode: nothing but what an agent in the chosen organization gets back from
 * OpenPurpose. Every call runs the real MCP read tool on the server, so the text
 * is exactly what the agent reads.
 */
@Component({
  selector: 'app-agent-console',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <h1>What an agent in {{ session.org()?.name }} sees</h1>
      <p class="quiet">Ask like an agent would. Each answer below is the MCP tool's output, word for word. Write tools aren't available here.</p>
    </header>

    <form class="inline-form panel console-form" (ngSubmit)="getContext()">
      <label>Project
        <select name="project" [(ngModel)]="project">
          <option value="">Find it from the git remote</option>
          @for (p of projects(); track p.id) { <option [value]="ref(p)">{{ p.name }} ({{ ref(p) }})</option> }
        </select>
      </label>
      @if (!project) {
        <label class="grow">Git remote URL <input name="remote" class="mono" [(ngModel)]="remote" placeholder="git@ssh.dev.azure.com:v3/org/project/repo"></label>
      }
      <label class="grow">Path <span class="quiet">(file or folder)</span><input name="path" class="mono" [(ngModel)]="path" placeholder="frontend/src/app"></label>
      <label>Stacks <span class="quiet">(optional)</span><input name="stacks" [(ngModel)]="stacks" placeholder="angular"></label>
      <details class="full console-manifest">
        <summary>Manifest <span class="quiet">(optional: package.json, *.csproj… to detect stacks)</span></summary>
        <div class="inline-form">
          <label>File name <input name="mpath" class="mono" [(ngModel)]="manifestPath" placeholder="frontend/package.json"></label>
          <label class="full">Content <textarea name="manifest" class="mono" rows="4" [(ngModel)]="manifest"></textarea></label>
        </div>
      </details>
      <div class="form-actions full">
        <button class="btn primary" type="submit">get_context</button>
        <button class="btn" type="button" (click)="call('list_projects', {})">list_projects</button>
        <button class="btn" type="button" (click)="call('list_organizations', {})">list_organizations</button>
        <button class="btn" type="button" (click)="call('list_scopes', project ? { project } : {})">list_scopes</button>
      </div>
    </form>

    <form class="console-search" (ngSubmit)="search()" role="search">
      <input name="q" [(ngModel)]="query" placeholder="search: words an agent would look for" aria-label="Search as the agent">
      <button class="btn" type="submit" [disabled]="!query.trim()">search</button>
    </form>

    <section class="transcript" aria-live="polite">
      @for (c of calls(); track c.id) {
        <article class="call" [class.error]="c.error">
          <div class="call-head"><code class="call-sig">$ {{ sig(c) }}</code></div>
          @if (c.text === null) {
            <p class="quiet">Running…</p>
          } @else {
            <pre class="call-out"><code>{{ c.text }}</code></pre>
            @if (c.next.length) {
              <div class="call-next">
                <span class="quiet">Next:</span>
                @for (f of c.next; track sig(f)) {
                  <button type="button" class="btn sm" (click)="call(f.name, f.args)">{{ label(f) }}</button>
                }
              </div>
            }
          }
        </article>
      } @empty {
        <p class="empty">Pick a project or paste a git remote, then run <code>get_context</code>. That's the first call an agent makes.</p>
      }
      @if (calls().length) {
        <button type="button" class="link-btn" (click)="calls.set([])">Clear transcript</button>
      }
    </section>
  `,
})
export class AgentConsolePage {
  readonly session = inject(Session);
  private api = inject(Api);
  private notices = inject(Notices);
  private host = inject(ElementRef<HTMLElement>);
  readonly projects = signal<Project[]>([]);
  readonly calls = signal<Call[]>([]);
  private seq = 0;
  project = '';
  remote = '';
  path = '';
  stacks = '';
  manifestPath = '';
  manifest = '';
  query = '';

  constructor() {
    const start = inject(ActivatedRoute).snapshot.queryParamMap.get('project');
    void this.api.projects().then((list) => {
      this.projects.set(list);
      const p = start ? list.find((x) => x.id === start || this.ref(x) === start) : null;
      if (p) {
        this.project = this.ref(p);
        void this.getContext();
      }
    }).catch((e) => this.notices.error(e));
  }

  ref(p: Project): string {
    return p.organization_slug ? `${p.organization_slug}/${p.slug}` : p.slug;
  }

  sig(c: { name: string; args: Args }): string {
    return signature(c.name, c.args);
  }

  /** Short button text: the tool and its most telling argument. */
  label(c: { name: string; args: Args }): string {
    const a = c.args;
    return `${c.name} ${a['endpoint'] ?? a['tag'] ?? a['section_id'] ?? a['api'] ?? a['project'] ?? ''}`.trim();
  }

  getContext(): Promise<void> {
    const args: Args = {};
    if (this.project) args['project'] = this.project;
    else if (this.remote.trim()) args['remote_url'] = this.remote.trim();
    if (this.path.trim()) args['path'] = this.path.trim();
    const stacks = splitList(this.stacks);
    if (stacks.length) args['stacks'] = stacks;
    if (this.manifest.trim()) args['manifests'] = [{ path: this.manifestPath.trim() || 'package.json', content: this.manifest }];
    return this.call('get_context', args);
  }

  search(): Promise<void> {
    const args: Args = { query: this.query.trim() };
    if (this.project) args['project'] = this.project;
    return this.call('search', args);
  }

  async call(name: string, args: Args): Promise<void> {
    const entry: Call = { id: ++this.seq, name, args, text: null, error: false, next: [] };
    this.calls.update((list) => [...list, entry]);
    this.scrollToEnd();
    try {
      const r = await this.api.agentTool(name, args);
      const next = followUps({ name, args, text: r.text });
      this.calls.update((list) => list.map((c) => (c.id === entry.id ? { ...entry, text: r.text, error: r.is_error, next } : c)));
    } catch (e) {
      this.calls.update((list) => list.filter((c) => c.id !== entry.id));
      this.notices.error(e);
    }
  }

  private scrollToEnd(): void {
    setTimeout(() => this.host.nativeElement.querySelector('.call:last-of-type')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
}
