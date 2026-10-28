import { Injectable, inject } from '@angular/core';
import { Api } from './api';
import { Session } from './session';

/** Change the current group or organization, reload who-am-I, then rebuild the page. */
@Injectable({ providedIn: 'root' })
export class ContextSwitch {
  private api = inject(Api);
  private session = inject(Session);

  async org(id: string | null): Promise<void> {
    if (id === this.session.orgId()) return;
    this.session.chooseOrg(id);
    this.session.me.set(await this.api.me());
    this.session.view.update((n) => n + 1);
  }

  /**
   * Turn agent mode on or off. Agents always belong to one organization, so
   * turning it on without one picks the first the person can read.
   */
  async agentMode(on: boolean): Promise<void> {
    const before = this.session.orgChoice();
    this.session.setAgentMode(on);
    if (on && !this.session.orgId()) {
      const first = this.session.readableOrgs().at(0);
      if (first) this.session.chooseOrg(first.id);
    }
    try {
      this.session.me.set(await this.api.me());
    } catch (e) {
      this.session.setAgentMode(false);
      this.session.chooseOrg(before);
      this.session.me.set(await this.api.me());
      throw e;
    }
    this.session.view.update((n) => n + 1);
  }

  async group(id: string): Promise<void> {
    this.session.chooseGroup(id);
    this.session.me.set(await this.api.me());
    this.session.view.update((n) => n + 1);
  }
}
