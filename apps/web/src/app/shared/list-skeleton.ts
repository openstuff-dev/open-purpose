import { ChangeDetectionStrategy, Component, computed, input, numberAttribute } from '@angular/core';
import { Skeleton } from '@openstuff-dev/ui-angular';

/** Bar widths in rem, so placeholder rows don't all look the same. */
const WIDTHS = [11, 8, 13, 9.5, 12, 7.5];

/**
 * Placeholder rows for a doc, scope or project list while it loads. Each row uses the real
 * row's classes, so it is exactly as tall and nothing below it moves when the list arrives.
 */
@Component({
  selector: 'app-list-skeleton',
  imports: [Skeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul [class]="kind() + '-list'" aria-hidden="true">
      @for (w of widths(); track $index) {
        <li>
          @switch (kind()) {
            @case ('doc') {
              <div class="skeleton-row skeleton-wait">
                <span class="doc-glyph"></span>
                <span class="doc-name">
                  <span class="doc-title"><os-skeleton [style.inline-size.rem]="w" /></span>
                  <span class="doc-kind"><os-skeleton [style.inline-size.rem]="5" /></span>
                </span>
                <span class="doc-count"><os-skeleton [style.inline-size.rem]="5.5" /></span>
                <span><os-skeleton [style.inline-size.rem]="4" /></span>
              </div>
            }
            @case ('scope') {
              <span class="scope-name skeleton-wait"
                ><os-skeleton [style.inline-size.rem]="w * 0.8"
              /></span>
              <span class="scope-match skeleton-wait"
                ><os-skeleton [style.inline-size.rem]="w"
              /></span>
            }
            @case ('project') {
              <div class="skeleton-row skeleton-wait">
                <span class="project-id">
                  <span class="project-name"
                    ><os-skeleton [style.inline-size.rem]="w * 0.8"
                  /></span>
                  <span class="project-slug"
                    ><os-skeleton [style.inline-size.rem]="w * 0.6"
                  /></span>
                </span>
                <span class="project-summary"
                  ><os-skeleton [style.inline-size.rem]="w * 1.6"
                /></span>
                <span class="project-stats"><os-skeleton [style.inline-size.rem]="2" /></span>
              </div>
            }
          }
        </li>
      }
    </ul>
  `,
})
export class ListSkeleton {
  readonly kind = input.required<'doc' | 'scope' | 'project'>();
  readonly rows = input(3, { transform: numberAttribute });
  readonly widths = computed(() =>
    Array.from({ length: this.rows() }, (_, i) => WIDTHS[i % WIDTHS.length]),
  );
}

/** A page header and one list, for a detail page while its record loads. */
@Component({
  selector: 'app-page-skeleton',
  imports: [Skeleton, ListSkeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="skeleton-wait" aria-hidden="true">
      <header class="os-page-header">
        <div>
          <os-skeleton [style.inline-size.rem]="8" />
          <div class="os-page-title">
            <os-skeleton [style.inline-size.rem]="14" class="skeleton-xl" />
          </div>
          <div class="os-page-description">
            <os-skeleton [lines]="2" class="skeleton-fill" />
          </div>
        </div>
      </header>
      <div class="block">
        <div class="block-head">
          <os-skeleton [style.inline-size.rem]="9" class="skeleton-md" />
        </div>
        <app-list-skeleton kind="doc" [rows]="3" />
      </div>
    </div>
  `,
})
export class PageSkeleton {}
