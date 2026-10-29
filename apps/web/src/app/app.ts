import {
  ChangeDetectionStrategy,
  Component,
  effect,
  type ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { type HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import {
  Button,
  Field,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  PopoverTrigger,
} from '@openstuff-dev/ui-angular';
import { positionAnchors } from '@openstuff-dev/ui';
import { Api } from './core/api';
import { Badges } from './core/badges';
import { isPublicUrl } from './app.routes';
import { type AuthStatus, ROLE_LABEL } from './core/models';
import { Session, errorMessage } from './core/session';
import { ContextSwitch } from './core/switch';
import { Theme, initials } from './core/theme';
import { Icon } from './shared/icon';
import { Notices } from './shared/notice';
import { Palette } from './shared/palette';
import { PendingPage } from './pages/pending';
import { SignInPage } from './pages/sign-in';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    FormsModule,
    Icon,
    Palette,
    Button,
    IconButton,
    Field,
    Menu,
    MenuItem,
    MenuLabel,
    MenuSeparator,
    PopoverTrigger,
    SignInPage,
    PendingPage,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    @if (publicPage()) {
      <router-outlet />
    } @else if (!session.token()) {
      <app-sign-in />
    } @else if (pending(); as status) {
      <app-pending [status]="status" (check)="refreshMe()" (signOut)="signOut()" />
    } @else if (session.me(); as me) {
      @if (me.agent_view) {
        <!-- Agent mode: only what the agent itself gets back, nothing of the regular UI. -->
        <div class="agent-shell">
          <header class="agent-bar">
            <span class="brand">
              <svg viewBox="0 0 40 40" width="22" height="22" aria-hidden="true">
                <use href="#openpurpose-mark" />
              </svg>
              OpenPurpose
            </span>
            @if (session.agentOrgs().length > 1) {
              <os-field label="Agent in" class="agent-org"
                ><select
                  os-select
                  [ngModel]="session.orgId()"
                  (ngModelChange)="pickOrg($event)"
                  aria-label="View as an agent in"
                >
                  @for (o of session.agentOrgs(); track o.id) {
                    <option [value]="o.id">{{ o.name }}</option>
                  }
                </select></os-field
              >
            } @else {
              <span class="agent-org"
                >Agent in <strong>{{ session.org()?.name }}</strong></span
              >
            }
            <button
              os-button
              size="sm"
              type="button"
              (click)="toggleAgentMode()"
              [disabled]="switching()"
            >
              Exit agent mode
            </button>
          </header>
          <main class="main" id="main">
            @for (k of [session.view()]; track k) {
              <router-outlet />
            }
          </main>
        </div>
      } @else {
        <div class="shell" [class.rail-open]="railOpen()">
          <nav class="rail" id="rail" aria-label="Main">
            <a class="brand" routerLink="/organization">
              <svg viewBox="0 0 40 40" width="22" height="22" aria-hidden="true">
                <use href="#openpurpose-mark" />
              </svg>
              OpenPurpose
            </a>

            <div class="ws">
              <button type="button" class="ws-button" [os-popover-trigger]="wsMenu">
                @if (session.org(); as org) {
                  <span class="badge" [style.background]="session.orgColor(org.id)">{{
                    initials(org.name)
                  }}</span>
                  <span class="ws-text"
                    ><strong>{{ org.name }}</strong>
                    @if (session.groupShown()) {
                      <small>{{ me.group.name }}</small>
                    }
                  </span>
                } @else {
                  <span class="badge group">{{ initials(me.group.name) }}</span>
                  <span class="ws-text"
                    ><strong>{{ me.group.name }}</strong
                    ><small>Choose an organization</small></span
                  >
                }
                <app-icon name="chevrons-up-down" />
              </button>
              <div os-menu #wsMenu="osPopover" class="ws-menu" aria-label="Switch organization">
                @if (session.groupShown() && session.readableOrgs().length) {
                  <div os-menu-label>Organizations in {{ me.group.name }}</div>
                  @for (o of session.readableOrgs(); track o.id) {
                    <button
                      type="button"
                      os-menu-item
                      role="menuitemradio"
                      [attr.aria-checked]="o.id === session.orgId()"
                      (click)="pickOrg(o.id)"
                    >
                      <span class="badge sm" [style.background]="session.orgColor(o.id)">{{
                        initials(o.name)
                      }}</span>
                      {{ o.name }}
                      @if (o.id === session.orgId()) {
                        <app-icon name="check" />
                      }
                    </button>
                  }
                }
                @if (me.groups.length > 1) {
                  <hr os-menu-separator />
                  <div os-menu-label>Workspaces</div>
                  @for (g of me.groups; track g.id) {
                    <button
                      type="button"
                      os-menu-item
                      role="menuitemradio"
                      [attr.aria-checked]="g.id === me.group.id"
                      (click)="pickGroup(g.id)"
                    >
                      <span class="badge sm group">{{ initials(g.name) }}</span>
                      {{ g.name }}
                      @if (g.id === me.group.id) {
                        <app-icon name="check" />
                      }
                    </button>
                  }
                }
                @if (session.canAdmin(null)) {
                  <hr os-menu-separator />
                  <a os-menu-item routerLink="/settings/workspace"
                    ><app-icon name="settings" />{{
                      session.groupShown() ? 'Manage organizations' : 'Add an organization'
                    }}</a
                  >
                }
              </div>
            </div>

            <ul>
              @if (session.org(); as org) {
                <li>
                  <a routerLink="/organization" routerLinkActive="active"
                    ><app-icon name="layers" />Overview</a
                  >
                </li>
              }
              <li>
                <a routerLink="/projects" routerLinkActive="active"
                  ><app-icon name="repo" />Projects</a
                >
              </li>
              <li>
                <a routerLink="/map" routerLinkActive="active"><app-icon name="map" />Map</a>
              </li>
              <li>
                <a routerLink="/inbox" routerLinkActive="active">
                  <app-icon name="inbox" />Inbox
                  @if (badges.counts()?.pending_proposals; as n) {
                    <span class="count" [attr.aria-label]="n + ' waiting for review'">{{ n }}</span>
                  }
                </a>
              </li>
              <li>
                <a routerLink="/findings" routerLinkActive="active">
                  <app-icon name="bug" />Findings
                  @if (badges.counts()?.new_findings; as n) {
                    <span class="count" [attr.aria-label]="n + ' new, not sorted yet'">{{
                      n
                    }}</span>
                  }
                </a>
              </li>
            </ul>
            @if (session.groupShown()) {
              <div class="nav-label">{{ me.group.name }}</div>
            }
            <ul>
              @if (session.groupShown()) {
                <li>
                  <a routerLink="/workspace" routerLinkActive="active"
                    ><app-icon name="building" />Workspace-wide rules</a
                  >
                </li>
              }
            </ul>

            <div class="rail-foot">
              <ul>
                <li>
                  <a routerLink="/settings" routerLinkActive="active"
                    ><app-icon name="settings" />Settings</a
                  >
                </li>
              </ul>
              <div class="me-row">
                <span class="avatar">{{ initials(me.actor.name) }}</span>
                <span
                  >{{ me.actor.name }}<small>{{ roleLine() }}</small></span
                >
                <button
                  os-icon-button
                  variant="ghost"
                  type="button"
                  (click)="signOut()"
                  label="Sign out"
                  title="Sign out"
                >
                  <app-icon name="logout" />
                </button>
              </div>
            </div>
          </nav>

          <div class="content">
            <header class="topbar">
              <button
                os-icon-button
                variant="ghost"
                class="menu-btn"
                type="button"
                (click)="railOpen.set(!railOpen())"
                [attr.aria-expanded]="railOpen()"
                aria-controls="rail"
                label="Menu"
              >
                <app-icon name="menu" [size]="18" />
              </button>
              <span class="topbar-title">{{ session.org()?.name ?? me.group.name }}</span>
              <button
                class="search-trigger"
                type="button"
                (click)="session.palette.set('')"
                aria-label="Search and go to (Ctrl+K)"
              >
                <app-icon name="search" /><span>Search or jump to…</span
                ><kbd>{{ mac ? '⌘' : 'Ctrl' }} K</kbd>
              </button>
              <button
                type="button"
                class="agent-switch"
                role="switch"
                aria-checked="false"
                (click)="toggleAgentMode()"
                [disabled]="switching()"
                interestfor="agent-tip"
                aria-describedby="agent-tip"
                #agentSwitch
              >
                <app-icon name="bot" [size]="15" /><span class="agent-switch-label">Agent mode</span
                ><span class="track" aria-hidden="true"><span class="thumb"></span></span>
              </button>
              <div class="os-tooltip agent-tip" popover="hint" id="agent-tip" #agentTip>
                See exactly what an agent in {{ session.org()?.name ?? 'an organization' }} gets
                back from OpenPurpose: the text of get_context and the other read tools, word for
                word, and nothing else.
              </div>
            </header>
            <main class="main" id="main">
              @for (k of [session.view()]; track k) {
                <router-outlet />
              }
            </main>
          </div>
        </div>
        @if (session.palette() !== null) {
          <app-palette (closed)="session.palette.set(null)" />
        }
      }
    } @else if (loadError()) {
      <main class="signin">
        <div class="signin-card">
          <h1>OpenPurpose</h1>
          <p role="alert">{{ loadError() }}</p>
          <button os-button type="button" (click)="signOut()">Sign out</button>
        </div>
      </main>
    }
    <svg class="sprite" width="0" height="0" aria-hidden="true">
      <symbol id="openpurpose-mark" viewBox="0 0 40 40">
        <rect
          x="5"
          y="3"
          width="26"
          height="34"
          rx="5"
          fill="none"
          stroke="currentColor"
          stroke-width="2.6"
        />
        <path
          d="M12 12h12M12 18.5h12M12 25h6"
          stroke="currentColor"
          stroke-width="2.6"
          stroke-linecap="round"
        />
        <circle cx="31" cy="30" r="7" fill="var(--accent)" />
        <path
          d="M28 30l2 2 4-4"
          fill="none"
          stroke="#fff"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </symbol>
    </svg>
  `,
})
export class App {
  readonly session = inject(Session);
  private notices = inject(Notices);
  private api = inject(Api);
  private router = inject(Router);
  private switcher = inject(ContextSwitch);
  readonly badges = inject(Badges);
  readonly theme = inject(Theme);
  readonly railOpen = signal(false);
  readonly loadError = signal('');
  /** Set while the person signed in is waiting for a server admin to approve their sign-up. */
  readonly pending = signal<AuthStatus | null>(null);
  /** Sign-in, sign-up and the sign-in callback show on their own, signed in or not. */
  readonly publicPage = signal(isPublicUrl(location.pathname));
  readonly initials = initials;
  readonly mac = /Mac|iPhone|iPad/.test(navigator.platform);

  constructor() {
    // Agent mode restyles the whole document (drawers and dialogs live outside the shell).
    effect(() =>
      document.documentElement.classList.toggle('agent-mode', !!this.session.me()?.agent_view),
    );
    // Agent mode can also end without the switch (e.g. the organization went away):
    // leave the console then.
    effect(() => {
      const me = this.session.me();
      if (me && !me.agent_view && this.router.url.startsWith('/agent'))
        untracked(() => void this.router.navigate(['/organization']));
    });
    effect(() => {
      if (this.session.token()) untracked(() => void this.refreshMe());
      else this.pending.set(null);
    });
    // New who-am-I (sign-in, a switch, a settings change): the badges count for that view now.
    effect(() => {
      if (this.session.me()) untracked(() => void this.badges.refresh());
      else
        untracked(() => {
          this.badges.clear();
        });
    });
    // The agent tip is anchored in CSS; the polyfill (where needed) has to see it once it renders.
    effect(() => {
      const trigger = this.agentSwitch()?.nativeElement;
      const tip = this.agentTip()?.nativeElement;
      if (trigger && tip) void positionAnchors([trigger, tip]);
    });
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe((e) => {
      this.railOpen.set(false);
      this.publicPage.set(isPublicUrl(e.urlAfterRedirects));
      this.refreshStaleBadges();
    });
    // Back on the tab after a while: pick up what others changed meanwhile.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.refreshStaleBadges();
    });
  }

  private refreshStaleBadges(): void {
    if (this.session.me() && !this.publicPage()) this.badges.refreshStale();
  }

  onKey(ev: KeyboardEvent): void {
    if (
      (ev.metaKey || ev.ctrlKey) &&
      ev.key.toLowerCase() === 'k' &&
      this.session.me() &&
      !this.session.agentView()
    ) {
      ev.preventDefault();
      this.session.palette.set(this.session.palette() === null ? '' : null);
    }
  }

  readonly switching = signal(false);
  private readonly agentSwitch = viewChild<ElementRef<HTMLElement>>('agentSwitch');
  private readonly agentTip = viewChild<ElementRef<HTMLElement>>('agentTip');

  async toggleAgentMode(): Promise<void> {
    const on = !this.session.me()?.agent_view;
    this.switching.set(true);
    // Turned on from a project page, the console starts with that project's context.
    const project = /^\/projects\/([^/?#]+)/.exec(this.router.url)?.[1];
    try {
      await this.switcher.agentMode(on);
      if (on) await this.router.navigate(['/agent'], { queryParams: project ? { project } : {} });
      else await this.router.navigate(['/organization']);
    } catch (e) {
      this.notices.error(e);
    }
    this.switching.set(false);
  }

  roleLine(): string {
    const me = this.session.me();
    if (!me) return '';
    if (me.actor.is_superadmin) return 'Server admin';
    const org = this.session.org();
    if (me.group.role)
      return `${ROLE_LABEL[me.group.role]}, ${this.session.groupShown() ? me.group.name : (org?.name ?? me.group.name)}`;
    return org?.role ? `${ROLE_LABEL[org.role]}, ${org.name}` : '';
  }

  private meLoading: Promise<void> | null = null;

  /** Reloads /me; calls while one is running share it. */
  refreshMe(): Promise<void> {
    this.meLoading ??= this.loadMe().finally(() => {
      this.meLoading = null;
    });
    return this.meLoading;
  }

  private async loadMe(): Promise<void> {
    try {
      this.session.me.set(await this.api.me());
      this.pending.set(null);
      this.loadError.set('');
    } catch (err) {
      const status = (err as HttpErrorResponse).status;
      // Someone who signed up has no workspace until a server admin approves them.
      if (status === 403 && (await this.signupPending())) return;
      // A remembered group or organization that no longer applies: forget it and try once more.
      if (
        (status === 400 || status === 403 || status === 404) &&
        (this.session.groupChoice() || this.session.orgChoice() || this.session.agentMode())
      ) {
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
      localStorage.removeItem('openpurpose.group');
      localStorage.removeItem('openpurpose.org');
    } catch {
      /* ignore */
    }
    this.session.groupChoice.set(null);
    this.session.setAgentMode(false);
  }

  async pickGroup(id: string): Promise<void> {
    try {
      await this.switcher.group(id);
      await this.router.navigate(['/organization']);
    } catch (e) {
      this.notices.error(e);
    }
  }

  async pickOrg(id: string): Promise<void> {
    try {
      await this.switcher.org(id || null);
    } catch (e) {
      this.notices.error(e);
    }
  }

  private async signupPending(): Promise<boolean> {
    try {
      const status = await this.api.authStatus();
      this.pending.set(status.signup === 'pending' ? status : null);
    } catch {
      this.pending.set(null);
    }
    return !!this.pending();
  }

  /** Ends a browser session on the server too; an access token stays valid. */
  async signOut(): Promise<void> {
    try {
      await this.api.signOut();
    } catch {
      /* signed out here either way */
    }
    this.session.setToken(null);
    this.loadError.set('');
  }
}
