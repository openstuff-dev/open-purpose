import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { StatStyle } from '../core/stat-style';
import { day } from '../core/time';
import { Icon } from './icon';

/** Smaller changes than this read as "about the same". */
const FLAT = 0.05;

function weekdayMonFirst(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

/**
 * One activity figure (a total over some days), shown the way the viewer chose
 * in the StatStyle switcher: a number that counts up with a trend arrow,
 * GitHub-style dots (one per day, darker = more), or a sparkline.
 */
@Component({
  selector: 'app-activity-figure',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'figure', '[class.sm]': "size() === 'sm'", '[attr.data-style]': 'style.choice()' },
  template: `
    @switch (style.choice()) {
      @case ('dots') {
        <span
          class="dots"
          role="img"
          [attr.aria-label]="summary()"
          [style.grid-template-rows]="size() === 'sm' ? '1fr' : 'repeat(7, var(--dot))'"
        >
          @for (p of pad(); track $index) {
            <span class="dot pad"></span>
          }
          @for (c of cells(); track c.day) {
            <span class="dot" [attr.data-level]="c.level" [title]="c.title"></span>
          }
        </span>
        <span class="fig-small">{{ count() }}</span>
      }
      @case ('chart') {
        <svg
          class="spark"
          [attr.viewBox]="'0 0 ' + width() + ' 24'"
          preserveAspectRatio="none"
          role="img"
          [attr.aria-label]="summary()"
          (mouseleave)="hover.set(null)"
        >
          <path class="spark-area" [attr.d]="area()" />
          <path class="spark-line" [attr.d]="line()" vector-effect="non-scaling-stroke" />
          @if (hover(); as h) {
            <line
              class="spark-cross"
              [attr.x1]="h.x"
              [attr.x2]="h.x"
              y1="0"
              y2="24"
              vector-effect="non-scaling-stroke"
            />
          }
          @for (c of cells(); track c.day; let i = $index) {
            <rect
              class="spark-hit"
              [attr.x]="i - 0.5"
              y="0"
              width="1"
              height="24"
              (mouseenter)="hover.set({ x: i, text: c.title })"
            >
              <title>{{ c.title }}</title>
            </rect>
          }
        </svg>
        <span class="fig-small" aria-live="polite">{{ hover()?.text ?? count() }}</span>
      }
      @default {
        <span class="fig-num" [attr.aria-label]="count()">{{ shown() }}</span>
      }
    }
    @if (trend(); as t) {
      <span
        class="trend"
        [attr.data-dir]="t.dir"
        [title]="t.text"
        role="img"
        [attr.aria-label]="t.text"
        >{{ t.dir === 'up' ? '▲' : t.dir === 'down' ? '▼' : '–' }}</span
      >
    }
  `,
})
export class ActivityFigure {
  readonly style = inject(StatStyle);

  readonly count = input.required<number>();
  /** The same count for the period before; null hides the trend. */
  readonly previous = input<number | null>(null);
  /** What `previous` is compared with, when that isn't `count` (e.g. this week vs an all-time count). */
  readonly current = input<number | null>(null);
  readonly daily = input<number[]>([]);
  /** YYYY-MM-DD for each value of `daily`. */
  readonly days = input<string[]>([]);
  /** What `previous` covers, for the trend's tooltip, e.g. "the 7 days before". */
  readonly compare = input('the period before');
  /** What is being counted, e.g. "requests". */
  readonly unit = input('requests');
  readonly size = input<'lg' | 'sm'>('lg');

  readonly hover = signal<{ x: number; text: string } | null>(null);
  readonly shown = signal(0);

  readonly cells = computed(() => {
    const values = this.daily();
    const days = this.days();
    // Four shades from the busy days' quartiles, like GitHub; empty days stay blank.
    const busy = values.filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p: number) => busy[Math.min(busy.length - 1, Math.floor(p * busy.length))] ?? 0;
    const cuts = [q(0.25), q(0.5), q(0.75)];
    return values.map((v, i) => ({
      day: days[i] ?? String(i),
      level: v === 0 ? 0 : 1 + cuts.filter((c) => v > c).length,
      title: `${v} ${v === 1 ? this.unit().replace(/s$/, '') : this.unit()} on ${days[i] ? day(days[i]) : '?'}`,
    }));
  });

  /** Empty cells before the first day, so each row is one weekday (Monday on top). */
  readonly pad = computed(() =>
    this.size() === 'sm' || !this.days().length ? [] : Array(weekdayMonFirst(this.days()[0])),
  );

  readonly width = computed(() => Math.max(1, this.daily().length - 1));
  private readonly points = computed(() => {
    const values = this.daily();
    const max = Math.max(1, ...values);
    return values.map((v, i) => [i, 22 - (v / max) * 20] as const);
  });
  readonly line = computed(() =>
    this.points()
      .map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y.toFixed(2)}`)
      .join(''),
  );
  readonly area = computed(() => {
    const pts = this.points();
    return pts.length ? `${this.line()}L${pts.at(-1)![0]},24L0,24Z` : '';
  });

  readonly trend = computed(() => {
    const before = this.previous();
    if (before === null) return null;
    const now = this.current() ?? this.count();
    if (now === before) return { dir: 'flat', text: `Same as ${this.compare()}` };
    if (before === 0) return { dir: 'up', text: `Up from none in ${this.compare()}` };
    const change = (now - before) / before;
    const pct = Math.round(Math.abs(change) * 100);
    if (Math.abs(change) < FLAT)
      return { dir: 'flat', text: `About the same as ${this.compare()}` };
    return change > 0
      ? { dir: 'up', text: `Up ${pct} % from ${this.compare()}` }
      : { dir: 'down', text: `Down ${pct} % from ${this.compare()}` };
  });

  readonly summary = computed(() => {
    const busiest = this.cells().reduce<{ v: number; d: string } | null>((best, c, i) => {
      const v = this.daily()[i];
      return !best || v > best.v ? { v, d: c.day } : best;
    }, null);
    return `${this.count()} ${this.unit()}${busiest && busiest.v ? `, most on ${day(busiest.d)} (${busiest.v})` : ''}`;
  });

  constructor() {
    let frame = 0;
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(frame));
    // Count up from 0 whenever the number (or the style) changes.
    effect(() => {
      const target = this.count();
      if (this.style.choice() !== 'number') return;
      cancelAnimationFrame(frame);
      const still =
        typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (still || target === 0) {
        this.shown.set(target);
        return;
      }
      const start = performance.now();
      const duration = 600;
      const tick = (t: number) => {
        const p = Math.min(1, (t - start) / duration);
        this.shown.set(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) frame = requestAnimationFrame(tick);
      };
      this.shown.set(0);
      frame = requestAnimationFrame(tick);
    });
  }
}

/** The tiny switcher between number, dots and chart. One choice per person, everywhere. */
@Component({
  selector: 'app-stat-style-switch',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="stat-switch" role="group" aria-label="Show activity as">
      @for (o of options; track o.value) {
        <button
          type="button"
          [title]="o.label"
          [attr.aria-label]="o.label"
          [attr.aria-pressed]="style.choice() === o.value"
          (click)="style.set(o.value)"
        >
          <app-icon [name]="o.icon" [size]="12" />
        </button>
      }
    </span>
  `,
})
export class StatStyleSwitch {
  readonly style = inject(StatStyle);
  readonly options = [
    { value: 'number', icon: 'hash', label: 'Show as animated numbers' },
    { value: 'dots', icon: 'dots', label: 'Show as dots, one per day' },
    { value: 'chart', icon: 'chart', label: 'Show as a chart' },
  ] as const;
}
