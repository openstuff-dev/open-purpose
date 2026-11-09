import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SectionHeader, SettingCard, SettingCardBody, ThemePicker } from '@openstuff-dev/ui-angular';

@Component({
  selector: 'app-settings-appearance',
  imports: [SectionHeader, SettingCard, SettingCardBody, ThemePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'settings-tab' },
  template: `
    <section>
      <header
        os-section-header
        title="Appearance"
        description="Stored in this browser only. Other devices keep their own choice."
      ></header>
      <div os-setting-card>
        <div os-setting-card-body><os-theme-picker /></div>
      </div>
    </section>
  `,
})
export class AppearanceTab {}
