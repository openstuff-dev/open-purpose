import { inject, Injectable } from '@angular/core';
import { Toaster } from '@openstuff-dev/ui-angular';
import { errorMessage } from '../core/session';

/** Short confirmations and errors, shown as toasts and announced to screen readers. */
@Injectable({ providedIn: 'root' })
export class Notices {
  private readonly toaster = inject(Toaster);

  ok(text: string): void {
    this.toaster.show(text, { tone: 'success' });
  }

  error(err: unknown): void {
    this.toaster.show(typeof err === 'string' ? err : errorMessage(err), {
      tone: 'danger',
      duration: 8000,
    });
  }
}
