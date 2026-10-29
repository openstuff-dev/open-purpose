import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Button,
  ConfirmDialog,
  Control,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
} from '@openstuff-dev/ui-angular';
import type { PendingSignup } from '../core/models';
import { Signups } from '../core/signups';
import { Notices } from '../shared/notice';

/** Server admins: people who signed up and wait for approval (OPENPURPOSE_SIGNUP=approval). */
@Component({
  selector: 'app-signups',
  imports: [
    DatePipe,
    FormsModule,
    Button,
    Control,
    Dialog,
    DialogBody,
    DialogClose,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Field,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shown()) {
      <section>
        <h2>Sign-ups</h2>
        <p class="quiet">
          People who signed up wait here until you approve them. Approving gives them a workspace of
          their own, with them as its admin. They're in the next time they sign in.
        </p>
        @if (signups.pending().length) {
          <div class="os-setting-card">
            @for (s of signups.pending(); track s.id) {
              <div class="os-setting-row" data-inline>
                <div class="os-setting-text">
                  <h3>{{ s.name }}</h3>
                  <p>
                    {{ s.email ?? 'No email' }} · {{ signedInWith(s) }} · signed up
                    {{ s.signup_at | date: 'd MMM y, HH:mm' }}
                  </p>
                </div>
                <div class="form-actions">
                  <button os-button variant="primary" size="sm" type="button" (click)="start(s)">
                    Approve
                  </button>
                  <button os-button variant="ghost" size="sm" type="button" (click)="reject(s)">
                    Reject
                  </button>
                </div>
              </div>
            }
          </div>
        } @else {
          <os-empty-state title="No sign-ups waiting" level="3" bordered>
            New sign-ups show up here, and next to Server in the menu.
          </os-empty-state>
        }
      </section>
    }

    <dialog os-dialog size="sm" [open]="!!approving()" (openChange)="$event || approving.set(null)">
      @if (approving(); as s) {
        <form (ngSubmit)="approve(s)">
          <header os-dialog-header>
            <h2 os-dialog-title>Approve {{ s.name }}</h2>
          </header>
          <div os-dialog-body>
            <os-field label="Workspace name" hint="They can rename it later.">
              <input os-input name="workspace" [(ngModel)]="workspace" required />
            </os-field>
          </div>
          <footer os-dialog-footer>
            <button os-button type="button" os-dialog-close>Cancel</button>
            <button
              os-button
              variant="primary"
              type="submit"
              [disabled]="!workspace.trim() || busy()"
            >
              Approve and create workspace
            </button>
          </footer>
        </form>
      }
    </dialog>
  `,
})
export class SignupsList {
  readonly signups = inject(Signups);
  private confirmDialog = inject(ConfirmDialog);
  private notices = inject(Notices);
  /** After an approval, so the caller can show the new workspace. */
  readonly approved = output();

  readonly approving = signal<PendingSignup | null>(null);
  readonly busy = signal(false);
  workspace = '';

  /** In approval mode; or when people still wait after the mode changed, so they aren't stuck. */
  readonly shown = computed(
    () => this.signups.mode() === 'approval' || this.signups.pending().length > 0,
  );

  constructor() {
    this.signups.load().catch((e: unknown) => {
      this.notices.error(e);
    });
  }

  signedInWith(s: PendingSignup): string {
    if (s.method === 'email') return 'Email link';
    if (s.method === 'github') return 'GitHub';
    const p = s.method ?? s.provider;
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  start(s: PendingSignup): void {
    this.workspace = s.name;
    this.approving.set(s);
  }

  async approve(s: PendingSignup): Promise<void> {
    const workspace = this.workspace.trim();
    this.busy.set(true);
    try {
      await this.signups.approve(s, workspace);
      this.approving.set(null);
      this.notices.ok(`Approved ${s.name}. Their workspace ${workspace} is ready the next time they sign in.`);
      this.approved.emit();
    } catch (e) {
      this.notices.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  async reject(s: PendingSignup): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: `Reject ${s.name}?`,
      message: "They can't sign in with this account again, and any session they have ends now.",
      confirmLabel: 'Reject sign-up',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.signups.reject(s);
      this.notices.ok(`Rejected ${s.name}`);
    } catch (e) {
      this.notices.error(e);
    }
  }
}
