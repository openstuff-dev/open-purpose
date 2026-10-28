import { Injectable, signal } from '@angular/core';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'openpurpose.theme';

/**
 * Light, dark or follow the system. Stored per browser. data-theme on <html> only sets
 * color-scheme (see tokens.css), which picks a side of every light-dark() token.
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly choice = signal<ThemeChoice>(this.read());

  constructor() {
    this.apply(this.choice());
  }

  set(choice: ThemeChoice): void {
    try {
      if (choice === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      /* storage unavailable: applies to this tab only */
    }
    this.choice.set(choice);
    this.apply(choice);
  }

  private read(): ThemeChoice {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  }

  private apply(choice: ThemeChoice): void {
    const root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  }
}

/**
 * Each organization's identity colour, picked by its position in the group, so it
 * is the same on every page and on the map. The colours are --os-identity-0 … 7
 * from @openstuff-dev/tokens.
 */
const IDENTITY_COLORS = 8;

/** An organization's colour as a CSS variable, so agent mode can re-tint it. */
export function orgColor(index: number): string {
  return `var(--os-identity-${((index % IDENTITY_COLORS) + IDENTITY_COLORS) % IDENTITY_COLORS})`;
}

export function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (
    words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)
  ).toUpperCase();
}
