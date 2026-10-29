import { ChangeDetectionStrategy, Component, type OnInit, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Button } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import { Session, errorMessage } from '../core/session';

/**
 * Where the sign-in callback lands: swaps the one-time code for a session token, so no token
 * ever sits in a URL, then opens the app.
 */
@Component({
  selector: 'app-auth-done',
  imports: [RouterLink, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="signin">
      <div class="signin-card">
        <svg class="signin-mark" viewBox="0 0 40 40" aria-hidden="true">
          <use href="#openpurpose-mark" />
        </svg>
        @if (failed(); as message) {
          <h1>That sign-in didn't work</h1>
          <p role="alert">{{ message }}</p>
          <a os-button variant="primary" routerLink="/sign-in">Sign in again</a>
        } @else {
          <h1>Signing you in…</h1>
          <p role="status">This takes a second.</p>
        }
      </div>
    </main>
  `,
})
export class AuthDonePage implements OnInit {
  readonly code = input<string>();
  private api = inject(Api);
  private session = inject(Session);
  private router = inject(Router);
  readonly failed = signal('');

  ngOnInit(): void {
    void this.exchange();
  }

  private async exchange(): Promise<void> {
    const code = this.code();
    if (!code) {
      this.failed.set('This page needs the code from a sign-in link. Sign in again.');
      return;
    }
    try {
      const { token } = await this.api.exchangeCode(code);
      this.session.setToken(token);
      await this.router.navigateByUrl('/organization', { replaceUrl: true });
    } catch (err) {
      this.failed.set(errorMessage(err));
    }
  }
}
