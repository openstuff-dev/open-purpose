import { type Signal, signal } from '@angular/core';

/**
 * True only while something has been loading for longer than `delay` ms, so fast loads don't
 * flash a skeleton.
 */
export interface SlowLoading {
  slow: Signal<boolean>;
  track<T>(promise: Promise<T>): Promise<T>;
}

export function slowLoading(delay = 300): SlowLoading {
  const slow = signal(false);
  return {
    slow,
    track<T>(promise: Promise<T>): Promise<T> {
      const timer = setTimeout(() => {
        slow.set(true);
      }, delay);
      return promise.finally(() => {
        clearTimeout(timer);
        slow.set(false);
      });
    },
  };
}

/** Calls `fn` when the window gets focus again or the network comes back. */
export function onReturn(fn: () => void): () => void {
  const handler = () => {
    if (document.visibilityState === 'visible') fn();
  };
  window.addEventListener('focus', handler);
  window.addEventListener('online', handler);
  return () => {
    window.removeEventListener('focus', handler);
    window.removeEventListener('online', handler);
  };
}
