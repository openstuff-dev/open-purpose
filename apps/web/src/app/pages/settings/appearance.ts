import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SectionHeader, SettingCard, ThemePicker } from '@openstuff-dev/ui-angular';

@Component({
  selector: 'app-settings-appearance',
  imports: [SectionHeader, SettingCard, ThemePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'settings-tab' },
  template: `
    <section>
      <header
        os-section-header
        title="Appearance"
        description="Stored in this browser only."
      ></header>
      <div os-setting-card>
        <div class="setting-card-pad"><os-theme-picker /></div>
      </div>
    </section>
  `,
})
export class AppearanceTab {}
