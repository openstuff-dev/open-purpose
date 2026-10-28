import { Injectable, signal } from '@angular/core';

/** How activity figures render: a number that counts up, GitHub-style dots, or a sparkline. */
export type StatStyleChoice = 'number' | 'dots' | 'chart';
const KEY = 'openpurpose.statStyle';

/** Each person's choice of how to show activity. Stored per browser, like the theme. */
@Injectable({ providedIn: 'root' })
export class StatStyle {
  readonly choice = signal<StatStyleChoice>(this.read());

  set(choice: StatStyleChoice): void {
    try {
      if (choice === 'number') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      /* storage unavailable: applies to this tab only */
    }
    this.choice.set(choice);
  }

  private read(): StatStyleChoice {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'dots' || v === 'chart' ? v : 'number';
    } catch {
      return 'number';
    }
  }
}
