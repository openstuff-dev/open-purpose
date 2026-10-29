import { Injectable, inject, signal } from '@angular/core';
import { Api } from './api';
import type { PendingSignup, SignupMode } from './models';
import { Session } from './session';

/**
 * Sign-ups waiting for a server admin. Shared by the Settings nav (the count) and the Server tab
 * (the list), so approving one updates both.
 */
@Injectable({ providedIn: 'root' })
export class Signups {
  private api = inject(Api);
  private session = inject(Session);
  readonly mode = signal<SignupMode>('off');
  readonly pending = signal<PendingSignup[]>([]);

  /** Server admins only; anyone else keeps an empty list. */
  async load(): Promise<void> {
    if (!this.session.isSuperadmin) return;
    const [config, pending] = await Promise.all([this.api.authConfig(), this.api.signups()]);
    this.mode.set(config.signup);
    this.pending.set(pending);
  }

  async approve(s: PendingSignup, workspace: string): Promise<void> {
    await this.api.approveSignup(s.id, workspace);
    this.drop(s);
  }

  async reject(s: PendingSignup): Promise<void> {
    await this.api.rejectSignup(s.id);
    this.drop(s);
  }

  private drop(s: PendingSignup): void {
    this.pending.update((list) => list.filter((p) => p.id !== s.id));
  }
}
