import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Button } from '@openstuff-dev/ui-angular';
import type { AuthStatus } from '../core/models';

/** What someone who signed up sees until a server admin approves them. */
@Component({
  selector: 'app-pending',
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="signin">
      <div class="signin-card">
        <svg class="signin-mark" viewBox="0 0 40 40" aria-hidden="true">
          <use href="#openpurpose-mark" />
        </svg>
        <h1>You're on the list</h1>
        <p>
          An admin of this server approves new accounts. Once yours is approved, you get your own
          workspace. Sign in again later, or check now.
        </p>
        <p class="quiet">
          Signed in as {{ status().name }}
          @if (status().email; as email) {
            ({{ email }})
          }
        </p>
        <button os-button variant="primary" type="button" (click)="check.emit()">
          Check again
        </button>
        <button os-button variant="ghost" type="button" (click)="signOut.emit()">Sign out</button>
      </div>
    </main>
  `,
})
export class PendingPage {
  readonly status = input.required<AuthStatus>();
  readonly check = output();
  readonly signOut = output();
}
