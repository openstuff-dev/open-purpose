import { Injectable, inject, signal } from '@angular/core';
import { Api } from './api';
import { MAX_AGE_MS } from './get-cache';
import type { Counts } from './models';

/**
 * The counts on the Inbox and Findings links. They change when others act (an agent proposes a
 * learning or reports a finding), so they're refreshed while someone moves around, at most once
 * a minute (the same window as Api's store, so a refresh inside it costs no request).
 * Who-am-I (/me) only reloads when the person changes something.
 */
@Injectable({ providedIn: 'root' })
export class Badges {
  private api = inject(Api);
  readonly counts = signal<Counts | null>(null);
  private loadedAt = 0;
  private loading = false;
  private seq = 0;

  /** Loads the counts now, e.g. after a decision. The newest call wins; failures change nothing. */
  async refresh(): Promise<void> {
    const mine = ++this.seq;
    this.loading = true;
    try {
      const counts = await this.api.counts((fresh) => {
        if (mine === this.seq) this.counts.set(fresh);
      });
      if (mine !== this.seq) return;
      this.counts.set(counts);
      this.loadedAt = Date.now();
    } catch {
      /* the badges just stay as they were */
    } finally {
      if (mine === this.seq) this.loading = false;
    }
  }

  refreshStale(): void {
    if (!this.loading && Date.now() - this.loadedAt > MAX_AGE_MS) void this.refresh();
  }

  clear(): void {
    this.seq++;
    this.loading = false;
    this.counts.set(null);
    this.loadedAt = 0;
  }
}
