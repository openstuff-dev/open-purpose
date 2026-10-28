import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { EDIT_MODES, MODE_HELP, MODE_LABEL, type EditMode } from '../core/models';
import { Icon } from './icon';

const ICONS: Record<EditMode, string> = { locked: 'lock', propose: 'pencil', open: 'unlock' };

@Component({
  selector: 'app-mode-icon',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<app-icon [name]="icon()" [size]="13" />',
  host: { class: 'mode-icon' },
})
export class ModeIcon {
  readonly mode = input.required<EditMode>();
  icon = () => ICONS[this.mode()];
}

@Component({
  selector: 'app-mode-badge',
  imports: [ModeIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<app-mode-icon [mode]="mode()" />{{ label[mode()] }}',
  host: { class: 'os-badge', '[attr.data-mode]': 'mode()', '[attr.title]': 'help[mode()]' },
})
export class ModeBadge {
  readonly mode = input.required<EditMode>();
  readonly label = MODE_LABEL;
  readonly help = MODE_HELP;
}

let nextPicker = 0;

/** Three-way switch for what agents may do. Disabled for people without edit rights. */
@Component({
  selector: 'app-mode-picker',
  imports: [ModeIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The toolkit's segmented control holds plain labels; this one needs an icon and a
  // colour per mode.
  template: ` <div
    class="os-segmented mode-picker"
    data-size="sm"
    role="radiogroup"
    [attr.aria-label]="label()"
  >
    @for (m of modes; track m) {
      <label [attr.data-mode]="m" [attr.title]="help[m]">
        <input
          type="radio"
          [name]="name"
          [value]="m"
          [checked]="m === mode()"
          [disabled]="disabled()"
          (change)="changed.emit(m)"
        />
        <app-mode-icon [mode]="m" />{{ names[m] }}
      </label>
    }
  </div>`,
})
export class ModePicker {
  readonly mode = input.required<EditMode>();
  readonly disabled = input(false);
  readonly label = input('What agents may do');
  readonly changed = output<EditMode>();
  readonly modes = EDIT_MODES;
  readonly help = MODE_HELP;
  readonly names: Record<EditMode, string> = { locked: 'Locked', propose: 'Propose', open: 'Open' };
  readonly name = `mode-${nextPicker++}`;
}
