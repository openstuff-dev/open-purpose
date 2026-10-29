import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { type HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Button, Callout, Control, Field } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { AuthConfig, AuthMethod, SignInErrorCode } from '../core/models';
import { Session, errorMessage } from '../core/session';

/** What /sign-in?error=… means, in words. */
const ERRORS: Record<SignInErrorCode, string> = {
  'no-account': 'There is no account for that sign-in. Ask an admin of this server to add you.',
  rejected: 'Your sign-up was not approved. Ask an admin of this server if you think that is wrong.',
  disabled: 'Your account is turned off. Ask an admin of this server to turn it back on.',
  'other-browser':
    'Open the sign-in link in the same browser you asked for it in, or ask for a new link here.',
  failed: 'Signing in did not work. Try again.',
};

/**
 * Sign in, or sign up with sign-up copy. It is the page at /sign-in and /sign-up, and what
 * every other page shows while nobody is signed in.
 */
@Component({
  selector: 'app-sign-in',
  imports: [FormsModule, RouterLink, Button, Callout, Control, Field],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="signin">
      <div class="signin-card">
        <svg class="signin-mark" viewBox="0 0 40 40" aria-hidden="true">
          <use href="#openpurpose-mark" />
        </svg>
        @if (signingUp()) {
          <h1>Create your OpenPurpose account</h1>
          <p>
            @if (config()?.signup === 'open') {
              Sign up and you get your own workspace right away.
            } @else {
              Sign up, and an admin approves your account. Then you get your own workspace.
            }
          </p>
        } @else {
          <h1>Sign in to OpenPurpose</h1>
          <p>The shared rules, purpose and learnings your people and coding agents work from.</p>
        }

        @if (errorText(); as text) {
          <os-callout tone="danger" role="alert"
            ><p>{{ text }}</p></os-callout
          >
        }

        @if (config(); as c) {
          @for (m of oauth(); track m.provider) {
            <button os-button type="button" (click)="start(m)" [disabled]="busy()">
              Continue with {{ m.label }}
            </button>
          }

          @if (hasMagicLink()) {
            @if (sentTo(); as to) {
              <os-callout tone="success" title="Check your inbox" role="status">
                <p>
                  @if (c.signup === 'off') {
                    If you have an account, we sent a sign-in link to <strong>{{ to }}</strong
                    >.
                  } @else {
                    We sent a {{ signingUp() ? 'sign-up' : 'sign-in' }} link to
                    <strong>{{ to }}</strong
                    >.
                  }
                  Open it in this browser.
                </p>
              </os-callout>
              <button os-button variant="ghost" type="button" (click)="sentTo.set(null)">
                Use another email
              </button>
            } @else {
              <form class="signin-form" (ngSubmit)="sendLink()">
                <os-field label="Email" [error]="linkError()"
                  ><input
                    os-input
                    name="email"
                    type="email"
                    autocomplete="email"
                    [(ngModel)]="email"
                    required
                /></os-field>
                <button
                  os-button
                  [variant]="oauth().length ? 'default' : 'primary'"
                  type="submit"
                  [disabled]="busy() || !email.trim()"
                >
                  Email me a {{ signingUp() ? 'sign-up' : 'sign-in' }} link
                </button>
              </form>
            }
          }

          @if (!signingUp()) {
            @if (c.methods.length && !tokenOpen()) {
              <button os-button variant="ghost" type="button" (click)="tokenOpen.set(true)">
                Sign in with an access token
              </button>
            } @else {
              <form class="signin-form" (ngSubmit)="signInWithToken()">
                <os-field label="Access token" [error]="tokenError()"
                  ><input
                    os-input
                    name="token"
                    type="password"
                    autocomplete="current-password"
                    [(ngModel)]="tokenInput"
                    placeholder="chr_…"
                    required
                /></os-field>
                <button
                  os-button
                  [variant]="c.methods.length ? 'default' : 'primary'"
                  type="submit"
                  [disabled]="!tokenInput.trim()"
                >
                  Sign in
                </button>
              </form>
              <p class="quiet">
                An admin creates tokens under Settings. The first admin token is printed in the
                server log on first start.
              </p>
            }
          }

          @if (signupOffered()) {
            <p class="quiet">
              @if (signingUp()) {
                Already have an account? <a routerLink="/sign-in">Sign in</a>
              } @else {
                New here? <a routerLink="/sign-up">Create an account</a>
              }
            </p>
          }
          @if (siteHost(); as host) {
            <p class="quiet">
              <a [href]="c.site_url">Back to {{ host }}</a>
            </p>
          }
        }
      </div>
    </main>
  `,
})
export class SignInPage {
  /** Set by the /sign-up route. */
  readonly mode = input<'sign-in' | 'sign-up'>('sign-in');
  /** From /sign-in?error=…, where the callback sends people it couldn't sign in. */
  readonly error = input<string>();

  private api = inject(Api);
  private session = inject(Session);
  private router = inject(Router);

  readonly config = signal<AuthConfig | null>(null);
  readonly busy = signal(false);
  readonly sentTo = signal<string | null>(null);
  readonly linkError = signal('');
  readonly tokenError = signal('');
  readonly tokenOpen = signal(false);
  email = '';
  tokenInput = '';

  readonly oauth = computed(() =>
    (this.config()?.methods ?? []).filter(
      (m): m is Extract<AuthMethod, { kind: 'oauth' }> => m.kind === 'oauth',
    ),
  );

  readonly hasMagicLink = computed(() =>
    (this.config()?.methods ?? []).some((m) => m.kind === 'magic_link'),
  );

  /** Sign-up needs a provider and a server that takes new people. */
  readonly signupOffered = computed(() => {
    const c = this.config();
    return !!c && c.signup !== 'off' && c.methods.length > 0;
  });

  readonly signingUp = computed(() => this.mode() === 'sign-up' && this.signupOffered());
  /** A provider that refused to start, e.g. GitHub not set up. */
  readonly startError = signal('');
  readonly errorText = computed(() => {
    if (this.startError()) return this.startError();
    const e = this.error();
    return e ? ((ERRORS as Partial<Record<string, string>>)[e] ?? ERRORS.failed) : '';
  });

  readonly siteHost = computed(() => {
    const url = this.config()?.site_url;
    if (!url) return null;
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  });

  constructor() {
    this.api.authConfig().then(
      (c) => {
        this.config.set(c);
      },
      // An older server or a hiccup: tokens still work.
      () => {
        this.config.set({ signup: 'off', methods: [], site_url: null });
      },
    );
  }

  async start(method: AuthMethod): Promise<void> {
    this.startError.set('');
    this.busy.set(true);
    try {
      const res = await this.api.startSignIn(method);
      if (res.redirect) {
        location.assign(res.redirect);
        return;
      }
    } catch (err) {
      this.startError.set(errorMessage(err));
    }
    this.busy.set(false);
  }

  async sendLink(): Promise<void> {
    const email = this.email.trim();
    this.linkError.set('');
    this.busy.set(true);
    try {
      await this.api.startSignIn({ kind: 'magic_link' }, email);
      this.sentTo.set(email);
    } catch (err) {
      this.linkError.set(
        (err as HttpErrorResponse).status === 429
          ? 'Too many sign-in links. Try again in 15 minutes.'
          : errorMessage(err),
      );
    }
    this.busy.set(false);
  }

  async signInWithToken(): Promise<void> {
    this.tokenError.set('');
    this.session.setToken(this.tokenInput.trim());
    try {
      const me = await this.api.me();
      if (me.actor.kind === 'agent') {
        this.session.setToken(null);
        this.tokenError.set(
          'That is an agent token. Agents connect over MCP; sign in with a personal token.',
        );
        return;
      }
      this.session.me.set(me);
      this.tokenInput = '';
      if (/^\/sign-(in|up)\b/.test(this.router.url))
        await this.router.navigateByUrl('/organization');
    } catch (err) {
      const msg = errorMessage(err);
      this.session.setToken(null);
      this.tokenError.set(
        msg === 'Invalid or revoked token' ? 'That token is not valid or has been revoked.' : msg,
      );
    }
  }
}
