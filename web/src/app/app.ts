import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { Api } from './core/api';
import { ROLE_LABEL } from './core/models';
import { Session, errorMessage } from './core/session';
import { ContextSwitch } from './core/switch';
import { Theme, initials } from './core/theme';
import { Icon } from './shared/icon';
import { Notices } from './shared/notice';
import { Palette } from './shared/palette';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule, Icon, Palette],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)', '(document:click)': 'wsOpen.set(false)' },
  template: `
    @if (!session.token()) {
      <main class="signin">
        <form class="signin-card" (ngSubmit)="signIn()">
          <svg class="signin-mark" viewBox="0 0 40 40" aria-hidden="true"><use href="#charter-mark"/></svg>
          <h1>Sign in to Charter</h1>
          <p>The shared rules, purpose and learnings your people and coding agents work from.</p>
          <label for="token">Access token</label>
          <input id="token" name="token" type="password" autocomplete="current-password" [(ngModel)]="tokenInput"
                 placeholder="chr_…" required>
          @if (signinError()) { <p class="field-error" role="alert">{{ signinError() }}</p> }
          <button class="btn primary" type="submit" [disabled]="!tokenInput.trim()">Sign in</button>
          <p class="quiet">An admin creates tokens under Settings. The first admin token is printed in the server log on first start.</p>
        </form>
      </main>
    } @else if (session.me(); as me) {
      <div class="shell" [class.rail-open]="railOpen()" [class.agent-mode]="!!me.agent_view">
        <nav class="rail" id="rail" aria-label="Main">
          <a class="brand" routerLink="/organization">
            <svg viewBox="0 0 40 40" width="22" height="22" aria-hidden="true"><use href="#charter-mark"/></svg>
            Charter
          </a>

          <div class="ws" (click)="$event.stopPropagation()">
            <button type="button" class="ws-button" (click)="wsOpen.set(!wsOpen())" [attr.aria-expanded]="wsOpen()" aria-haspopup="menu">
              @if (session.org(); as org) {
                <span class="badge" [style.background]="session.orgColor(org.id)">{{ initials(org.name) }}</span>
                <span class="ws-text"><strong>{{ org.name }}</strong><small>{{ me.agent_view ? 'Viewing as its agent' : me.group.name }}</small></span>
              } @else {
                <span class="badge group">{{ initials(me.group.name) }}</span>
                <span class="ws-text"><strong>{{ me.group.name }}</strong><small>Choose an organization</small></span>
              }
              <app-icon name="chevrons-up-down" />
            </button>
            @if (wsOpen()) {
              <div class="menu" role="menu">
                @if (me.agent_view) {
                  <div class="menu-label">View as an agent in</div>
                  @for (o of session.agentOrgs(); track o.id) {
                    <button type="button" class="menu-item" role="menuitemradio" [attr.aria-checked]="o.id === session.orgId()" (click)="pickOrg(o.id)">
                      <span class="badge sm" [style.background]="session.orgColor(o.id)">{{ initials(o.name) }}</span>
                      {{ o.name }}
                      @if (o.id === session.orgId()) { <app-icon name="check" /> }
                    </button>
                  }
                } @else if (session.readableOrgs().length) {
                  <div class="menu-label">Organizations in {{ me.group.name }}</div>
                  @for (o of session.readableOrgs(); track o.id) {
                    <button type="button" class="menu-item" role="menuitemradio" [attr.aria-checked]="o.id === session.orgId()" (click)="pickOrg(o.id)">
                      <span class="badge sm" [style.background]="session.orgColor(o.id)">{{ initials(o.name) }}</span>
                      {{ o.name }}
                      @if (o.id === session.orgId()) { <app-icon name="check" /> }
                    </button>
                  }
                }
                @if (me.groups.length > 1) {
                  <div class="menu-sep"></div>
                  <div class="menu-label">Groups</div>
                  @for (g of me.groups; track g.id) {
                    <button type="button" class="menu-item" role="menuitemradio" [attr.aria-checked]="g.id === me.group.id" (click)="pickGroup(g.id)">
                      <span class="badge sm group">{{ initials(g.name) }}</span>
                      {{ g.name }}
                      @if (g.id === me.group.id) { <app-icon name="check" /> }
                    </button>
                  }
                }
                @if (session.canAdmin(null)) {
                  <div class="menu-sep"></div>
                  <a class="menu-item" routerLink="/settings/group" (click)="wsOpen.set(false)"><app-icon name="settings" />Manage organizations</a>
                }
              </div>
            }
          </div>

          <ul>
            @if (session.org(); as org) {
              <li><a routerLink="/organization" routerLinkActive="active"><app-icon name="layers" />Overview</a></li>
            }
            <li><a routerLink="/projects" routerLinkActive="active"><app-icon name="repo" />Projects</a></li>
            <li><a routerLink="/map" routerLinkActive="active"><app-icon name="map" />Map</a></li>
            @if (!me.agent_view) {
              <li>
                <a routerLink="/inbox" routerLinkActive="active">
                  <app-icon name="inbox" />Inbox
                  @if (me.pending_proposals; as n) { <span class="count" [attr.aria-label]="n + ' waiting for review'">{{ n }}</span> }
                </a>
              </li>
            }
          </ul>
          <div class="nav-label">{{ me.group.name }}</div>
          <ul>
            <li><a routerLink="/group" routerLinkActive="active"><app-icon name="building" />Group-wide rules</a></li>
            <li><a routerLink="/search" routerLinkActive="active"><app-icon name="search" />Search</a></li>
          </ul>

          <div class="rail-foot">
            <ul>
              <li><a routerLink="/settings" routerLinkActive="active"><app-icon name="settings" />Settings</a></li>
            </ul>
            <div class="me-row">
              <span class="avatar">{{ initials(me.actor.name) }}</span>
              <span>{{ me.actor.name }}<small>{{ roleLine() }}</small></span>
              <button class="icon-btn" type="button" (click)="signOut()" aria-label="Sign out" title="Sign out"><app-icon name="logout" /></button>
            </div>
          </div>
        </nav>

        <div class="content">
          <header class="topbar">
            <button class="icon-btn menu-btn" type="button" (click)="railOpen.set(!railOpen())" [attr.aria-expanded]="railOpen()" aria-controls="rail" aria-label="Menu">
              <app-icon name="menu" [size]="18" />
            </button>
            <span class="topbar-title">{{ session.org()?.name ?? me.group.name }}</span>
            <button class="search-trigger" type="button" (click)="paletteOpen.set(true)" aria-label="Search and go to (Ctrl+K)">
              <app-icon name="search" /><span>Search or jump to…</span><kbd>{{ mac ? '⌘' : 'Ctrl' }} K</kbd>
            </button>
            <span class="tip-wrap">
              <button type="button" class="agent-switch" role="switch" [attr.aria-checked]="!!me.agent_view" (click)="toggleAgentMode()"
                      aria-describedby="agent-tip" [disabled]="switching()">
                <app-icon name="bot" [size]="15" /><span class="agent-switch-label">Agent mode</span><span class="track" aria-hidden="true"><span class="thumb"></span></span>
              </button>
              <span class="tip" role="tooltip" id="agent-tip">
                <strong>Agent mode</strong>
                See Charter exactly as an agent in {{ session.org()?.name ?? 'an organization' }} does: only the organizations, projects and
                rules it can read, with the same edit modes it works under. Other organizations' projects appear as names only, like they do for the agent.
                Read-only while it's on.
              </span>
            </span>
          </header>
          @if (me.agent_view) {
            <div class="agent-banner" role="status">
              <app-icon name="bot" [size]="16" />
              <p>
                <strong>Agent mode.</strong> You see what an agent in
                <b>{{ session.org()?.name }}</b> reads: {{ agentReads() }}. Nothing can be changed.
              </p>
              @if (session.agentOrgs().length > 1) {
                <label class="agent-org">Agent in
                  <select [ngModel]="session.orgId()" (ngModelChange)="pickOrg($event)" aria-label="View as an agent in">
                    @for (o of session.agentOrgs(); track o.id) { <option [value]="o.id">{{ o.name }}</option> }
                  </select>
                </label>
              }
              <button class="btn sm" type="button" (click)="toggleAgentMode()">Exit agent mode</button>
            </div>
          }
          <main class="main" id="main">
            @for (k of [session.view()]; track k) { <router-outlet /> }
          </main>
        </div>
      </div>
      @if (paletteOpen()) { <app-palette (close)="paletteOpen.set(false)" /> }
    } @else if (loadError()) {
      <main class="signin">
        <div class="signin-card">
          <h1>Charter</h1>
          <p role="alert">{{ loadError() }}</p>
          <button class="btn" type="button" (click)="signOut()">Sign out</button>
        </div>
      </main>
    }
    <div class="notices" aria-live="polite">
      @for (n of notices.list(); track n.id) {
        <div class="notice" [attr.data-tone]="n.tone" role="status">
          <span>{{ n.text }}</span>
          <button type="button" class="link-btn" (click)="notices.dismiss(n.id)" aria-label="Dismiss">Dismiss</button>
        </div>
      }
    </div>
    <svg width="0" height="0" style="position:absolute" aria-hidden="true">
      <symbol id="charter-mark" viewBox="0 0 40 40">
        <rect x="5" y="3" width="26" height="34" rx="5" fill="none" stroke="currentColor" stroke-width="2.6"/>
        <path d="M12 12h12M12 18.5h12M12 25h6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
        <circle cx="31" cy="30" r="7" fill="var(--accent)"/>
        <path d="M28 30l2 2 4-4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </symbol>
    </svg>
  `,
})
export class App {
  readonly session = inject(Session);
  readonly notices = inject(Notices);
  private api = inject(Api);
  private router = inject(Router);
  private switcher = inject(ContextSwitch);
  readonly theme = inject(Theme);
  readonly railOpen = signal(false);
  readonly wsOpen = signal(false);
  readonly paletteOpen = signal(false);
  readonly signinError = signal('');
  readonly loadError = signal('');
  readonly initials = initials;
  readonly mac = /Mac|iPhone|iPad/.test(navigator.platform);
  tokenInput = '';

  constructor() {
    // Agent mode restyles the whole document (drawers and dialogs live outside the shell).
    effect(() => document.documentElement.classList.toggle('agent-mode', !!this.session.me()?.agent_view));
    effect(() => {
      if (this.session.token()) untracked(() => void this.refreshMe());
    });
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => {
      this.railOpen.set(false);
      this.wsOpen.set(false);
      if (this.session.token()) void this.refreshMe();
    });
  }

  onKey(ev: KeyboardEvent): void {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k' && this.session.me()) {
      ev.preventDefault();
      this.paletteOpen.set(!this.paletteOpen());
    } else if (ev.key === 'Escape') {
      this.wsOpen.set(false);
    }
  }

  readonly switching = signal(false);

  /** Names of the organizations the simulated agent can read, plus "group-wide rules". */
  agentReads(): string {
    const v = this.session.agentView();
    if (!v) return '';
    const names = this.session.orgs().filter((o) => v.readable_organization_ids.includes(o.id)).map((o) => o.name);
    return [`${this.session.group()?.name} group-wide rules`, ...names].join(', ');
  }

  async toggleAgentMode(): Promise<void> {
    const on = !this.session.me()?.agent_view;
    this.switching.set(true);
    try {
      await this.switcher.agentMode(on);
      if (on && this.router.url.startsWith('/inbox')) await this.router.navigate(['/projects']);
    } catch (e) {
      this.notices.error(e);
    }
    this.switching.set(false);
  }

  roleLine(): string {
    const me = this.session.me();
    if (!me) return '';
    if (me.agent_view) return 'Viewing as an agent';
    if (me.actor.is_superadmin) return 'Server admin';
    if (me.group.role) return `${ROLE_LABEL[me.group.role]}, ${me.group.name}`;
    const org = this.session.org();
    return org?.role ? `${ROLE_LABEL[org.role]}, ${org.name}` : '';
  }

  async refreshMe(): Promise<void> {
    try {
      this.session.me.set(await this.api.me());
      this.loadError.set('');
    } catch (err) {
      const status = (err as HttpErrorResponse).status;
      // A remembered group or organization that no longer applies: forget it and try once more.
      if ((status === 400 || status === 403 || status === 404) && (this.session.groupChoice() || this.session.orgChoice() || this.session.agentMode())) {
        this.forgetChoices();
        try {
          this.session.me.set(await this.api.me());
          return;
        } catch (again) {
          err = again;
        }
      }
      if ((err as HttpErrorResponse).status !== 401) this.loadError.set(errorMessage(err));
    }
  }

  private forgetChoices(): void {
    try {
      localStorage.removeItem('charter.group');
      localStorage.removeItem('charter.org');
    } catch {
      /* ignore */
    }
    this.session.groupChoice.set(null);
    this.session.setAgentMode(false);
  }

  async pickGroup(id: string): Promise<void> {
    this.wsOpen.set(false);
    try {
      await this.switcher.group(id);
      await this.router.navigate(['/organization']);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async pickOrg(id: string): Promise<void> {
    this.wsOpen.set(false);
    try {
      await this.switcher.org(id || null);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async signIn(): Promise<void> {
    this.signinError.set('');
    this.session.setToken(this.tokenInput.trim());
    try {
      const me = await this.api.me();
      if (me.actor.kind === 'agent') {
        this.session.setToken(null);
        this.signinError.set('That is an agent token. Agents connect over MCP; sign in with a personal token.');
        return;
      }
      this.session.me.set(me);
      this.tokenInput = '';
    } catch (err) {
      const msg = errorMessage(err);
      this.session.setToken(null);
      this.signinError.set(msg === 'Invalid or revoked token' ? 'That token is not valid or has been revoked.' : msg);
    }
  }

  signOut(): void {
    this.session.setToken(null);
    this.loadError.set('');
  }
}
