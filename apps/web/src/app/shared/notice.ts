import { Injectable, signal } from '@angular/core';
import { errorMessage } from '../core/session';

export interface Notice {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}

/** Short confirmations and errors, shown bottom-left and announced to screen readers. */
@Injectable({ providedIn: 'root' })
export class Notices {
  readonly list = signal<Notice[]>([]);
  private next = 1;

  ok(text: string): void {
    this.push(text, 'ok');
  }

  error(err: unknown): void {
    this.push(typeof err === 'string' ? err : errorMessage(err), 'error');
  }

  dismiss(id: number): void {
    this.list.update((l) => l.filter((n) => n.id !== id));
  }

  private push(text: string, tone: Notice['tone']): void {
    const id = this.next++;
    this.list.update((l) => [...l.slice(-3), { id, text, tone }]);
    setTimeout(() => this.dismiss(id), tone === 'error' ? 8000 : 3500);
  }
}
