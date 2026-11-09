import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
} from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import {
  NavLink,
  PageHeader,
  Settings,
  SettingsGroup,
  SettingsNav,
} from '@openstuff-dev/ui-angular';
import { Session } from '../../core/session';
import { Signups } from '../../core/signups';
import { iconNode } from '../../shared/icon';
import { GroupsPage } from '../groups';
import { PeoplePage } from '../people';
import { PreviewPage } from '../preview';
import { SignupsList } from '../signups';
import { TransferPage } from '../transfer';
import { AccountTab } from './account';
import { AppearanceTab } from './appearance';
import { ConnectTab } from './connect';
import { IntegrationsTab } from './integrations';
import { OrganizationsTab } from './organizations';
import { resolveTab, tabsFor, type SettingsAccess, type SettingsGroupId } from './settings-tabs';

@Component({
  selector: 'app-settings',
  imports: [
    AccountTab,
    AppearanceTab,
    ConnectTab,
    IntegrationsTab,
    GroupsPage,
    NavLink,
    OrganizationsTab,
    PageHeader,
    PeoplePage,
    PreviewPage,
    RouterLink,
    RouterLinkActive,
    Settings,
    SettingsGroup,
    SettingsNav,
    SignupsList,
    TransferPage,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header os-page-header title="Settings"></header>

    <os-settings>
      <nav os-settings-nav>
        @for (group of menu(); track group.id) {
          <os-settings-group [label]="group.label">
            @for (tab of group.tabs; track tab.id) {
              <a
                os-settings-link
                [routerLink]="['/settings', tab.id]"
                routerLinkActive
                ariaCurrentWhenActive="page"
                [icon]="icon(tab.icon)"
                [count]="tab.id === 'server' ? waiting() : null"
                [attr.aria-label]="
                  tab.id === 'server' && waiting()
                    ? tab.label + ', ' + waiting() + ' sign-ups waiting'
                    : null
                "
                >{{ tab.label }}</a
              >
            }
          </os-settings-group>
        }
      </nav>

      @switch (current()) {
        @case ('account') {
          <app-settings-account />
        }
        @case ('appearance') {
          <app-settings-appearance />
        }
        @case ('connect') {
          <app-settings-connect />
        }
        @case ('workspace') {
          <app-settings-organizations />
        }
        @case ('test') {
          <app-preview />
        }
        @case ('people') {
          <app-people />
        }
        @case ('integrations') {
          <app-settings-integrations />
        }
        @case ('transfer') {
          <app-transfer />
        }
        @case ('server') {
          <app-signups (approved)="groups.load()" />
          <app-groups #groups />
        }
      }
    </os-settings>
  `,
})
export class SettingsPage {
  readonly tab = input<string | undefined>();
  private readonly session = inject(Session);
  private readonly signups = inject(Signups);
  private readonly router = inject(Router);
  protected readonly icon = iconNode;

  private readonly access = computed(
    (): SettingsAccess => ({
      admin: this.session.adminsAnything,
      serverAdmin: this.session.isSuperadmin,
    }),
  );

  protected readonly current = computed(() => resolveTab(this.tab(), this.access()));
  protected readonly waiting = computed(() => this.signups.pending().length || null);

  private readonly groupLabels = computed((): Record<SettingsGroupId, string> => ({
    you: 'You',
    tenant:
      (this.session.groupShown() ? this.session.group()?.name : this.session.org()?.name) ?? '',
    server: 'Server',
  }));

  protected readonly menu = computed(() => {
    const tabs = tabsFor(this.access());
    return (['you', 'tenant', 'server'] as const).map((id) => ({
      id,
      label: this.groupLabels()[id],
      tabs: tabs.filter((tab) => tab.group === id),
    }));
  });

  constructor() {
    this.signups.load().catch(() => undefined);
    effect(() => {
      if (this.tab() && this.tab() !== this.current())
        void this.router.navigate(['/settings', this.current()], { replaceUrl: true });
    });
  }
}
