import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Button,
  ConfirmDialog,
  Control,
  SectionHeader,
  SecretDialog,
  SettingCard,
  SettingItem,
  SettingRow,
} from '@openstuff-dev/ui-angular';
import { Api } from '../../core/api';
import type { TokenRow } from '../../core/models';
import { Session } from '../../core/session';
import { Icon } from '../../shared/icon';
import { Notices } from '../../shared/notice';

@Component({
  selector: 'app-settings-account',
  imports: [
    Button,
    Control,
    DatePipe,
    FormsModule,
    Icon,
    SectionHeader,
    SettingCard,
    SettingItem,
    SettingRow,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'settings-tab' },
  template: `
    <section>
      <header os-section-header title="Account"></header>
      <div os-setting-card>
        <os-setting-row
          label="Name"
          description="Shown in history, the inbox and on proposals your agents make."
        >
          <form class="setting-save" (ngSubmit)="saveName()">
            <input os-input name="name" [(ngModel)]="name" required />
            <button
              os-button
              type="submit"
              [disabled]="!name.trim() || name.trim() === session.me()?.actor?.name"
            >
              Save
            </button>
          </form>
        </os-setting-row>
        <os-setting-item title="Your access" [meta]="accessLine()" />
      </div>
    </section>

    <section>
      <header
        os-section-header
        title="Personal tokens"
        description="Use one per device. A personal token also works over MCP, for scripts or an agent that acts as you."
      ></header>
      <div os-setting-card>
        @for (t of tokens(); track t.id) {
          <os-setting-item [title]="t.label" [archived]="!!t.revoked_at">
            <app-icon os-setting-item-tag class="setting-item-lead" name="key" [size]="14" />
            <code os-setting-item-tag class="quiet">{{ t.prefix }}…</code>
            <p os-setting-item-meta class="os-setting-item-meta">
              Created {{ t.created_at | date: 'd MMM y' }} ·
              @if (t.revoked_at) {
                revoked {{ t.revoked_at | date: 'd MMM y' }}
              } @else if (t.last_used_at) {
                last used {{ t.last_used_at | date: 'd MMM y, HH:mm' }}
              } @else {
                never used
              }
              @if (isCurrent(t)) {
                · <strong>this browser</strong>
              }
            </p>
            @if (!t.revoked_at) {
              <button os-button variant="danger" size="sm" type="button" (click)="revoke(t)">
                Revoke
              </button>
            }
          </os-setting-item>
        }
        <form class="setting-card-form setting-save" (ngSubmit)="newToken()">
          <input
            os-input
            name="label"
            [(ngModel)]="tokenLabel"
            placeholder="Label, e.g. work laptop"
            aria-label="Token label"
          />
          <button os-button type="submit"><app-icon name="plus" />Create token</button>
        </form>
      </div>
    </section>
  `,
})
export class AccountTab {
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly confirmDialog = inject(ConfirmDialog);
  private readonly notices = inject(Notices);
  private readonly secretDialog = inject(SecretDialog);

  protected readonly tokens = signal<TokenRow[]>([]);
  protected name = '';
  protected tokenLabel = '';

  constructor() {
    void this.loadTokens();
    effect(() => {
      const me = this.session.me();
      if (me) this.name = me.actor.name;
    });
  }

  protected accessLine(): string {
    const me = this.session.me();
    if (!me) return '';
    const parts: string[] = [];
    if (me.actor.is_superadmin) parts.push('server admin');
    if (me.group.role) parts.push(`${me.group.role} of ${me.group.name} (every organization)`);
    for (const o of me.organizations) {
      if (o.role && !me.group.role) parts.push(`${o.role} in ${o.name}`);
    }
    const shared = me.organizations.filter((o) => o.readable && !o.role).map((o) => o.name);
    if (shared.length) parts.push(`can read ${shared.join(', ')}`);
    const s = parts.join('; ');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) + '.' : 'No roles yet.';
  }

  protected isCurrent(t: TokenRow): boolean {
    return !!this.session.token()?.startsWith(t.prefix);
  }

  private async loadTokens(): Promise<void> {
    try {
      this.tokens.set(
        await this.api.myTokens((fresh) => {
          this.tokens.set(fresh);
        }),
      );
    } catch (e) {
      this.notices.error(e);
    }
  }

  protected async saveName(): Promise<void> {
    try {
      await this.api.renameMe(this.name.trim());
      this.session.me.set(await this.api.me());
      this.notices.ok('Saved your name');
    } catch (e) {
      this.notices.error(e);
    }
  }

  protected async newToken(): Promise<void> {
    try {
      const { token } = await this.api.createMyToken(this.tokenLabel.trim());
      this.tokenLabel = '';
      void this.loadTokens();
      await this.secretDialog.show({
        title: 'Your new personal token',
        secret: token,
        what: 'personal token',
        instructions:
          'Sign in with it on one device, or give it to a script or an agent that acts as you over MCP.',
      });
    } catch (e) {
      this.notices.error(e);
    }
  }

  protected async revoke(t: TokenRow): Promise<void> {
    const current = this.isCurrent(t);
    const revoke = await this.confirmDialog.confirm(
      current
        ? {
            title: 'Revoke the token you are signed in with?',
            message: 'You are signed out, and anything else using it stops working.',
            confirmLabel: 'Revoke and sign out',
            danger: true,
          }
        : {
            title: `Revoke ${t.label}?`,
            message: 'Anything using it stops working immediately.',
            confirmLabel: 'Revoke token',
            danger: true,
          },
    );
    if (!revoke) return;
    try {
      await this.api.revokeMyToken(t.id);
      if (current) {
        this.session.setToken(null);
        return;
      }
      this.notices.ok('Revoked token');
      await this.loadTokens();
    } catch (e) {
      this.notices.error(e);
    }
  }
}
