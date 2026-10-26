import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { EDIT_MODES, MODE_HELP, MODE_LABEL, type EditMode } from '../core/models';
import { Icon } from './icon';

const ICONS: Record<EditMode, string> = { locked: 'lock', propose: 'pencil', open: 'unlock' };

@Component({
  selector: 'app-mode-icon',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-icon [name]="icon()" [size]="13" />`,
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
  template: `<app-mode-icon [mode]="mode()" />{{ label[mode()] }}`,
  host: { class: 'mode-badge', '[attr.data-mode]': 'mode()', '[attr.title]': 'help[mode()]' },
})
export class ModeBadge {
  readonly mode = input.required<EditMode>();
  readonly label = MODE_LABEL;
  readonly help = MODE_HELP;
}

/** Three-way switch for what agents may do. Disabled for people without edit rights. */
@Component({
  selector: 'app-mode-picker',
  imports: [ModeIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mode-picker" role="radiogroup" [attr.aria-label]="label()">
      @for (m of modes; track m) {
        <button type="button" role="radio" [attr.data-mode]="m" [attr.aria-checked]="m === mode()"
                [disabled]="disabled()" [attr.title]="help[m]" (click)="m !== mode() && changed.emit(m)">
          <app-mode-icon [mode]="m" /><span>{{ names[m] }}</span>
        </button>
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
}
