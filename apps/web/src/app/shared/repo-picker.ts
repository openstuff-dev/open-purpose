import { ChangeDetectionStrategy, Component, inject, input, model, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import type { Repository } from '../core/models';
import { Notices } from './notice';
import { Icon } from './icon';

/** Which of a project's repositories a scope is bound to, with a shortcut to register another one. */
@Component({
  selector: 'app-repo-picker',
  imports: [FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="repo-picker">
      <legend>Repositories</legend>
      @for (r of repositories(); track r.id) {
        <label class="check"
          ><input
            type="checkbox"
            [checked]="selected().includes(r.id)"
            (change)="toggle(r.id)"
          /><code>{{ r.remote_key }}</code></label
        >
      } @empty {
        <p class="quiet">The project has no repositories yet.</p>
      }
      <div class="repo-add">
        <input
          class="mono"
          name="repo-picker-remote"
          [(ngModel)]="remote"
          aria-label="Git remote URL of another repository"
          placeholder="Add a git remote URL"
          (keydown.enter)="$event.preventDefault(); add()"
        />
        <button class="btn sm" type="button" [disabled]="!remote.trim()" (click)="add()">
          <app-icon name="plus" />Add
        </button>
      </div>
      <p class="quiet">
        Tick none to use paths and stacks in any of the project's repositories, as in a monorepo.
      </p>
    </fieldset>
  `,
})
export class RepoPicker {
  readonly projectId = input.required<string>();
  readonly repositories = model<Repository[]>([]);
  readonly selected = model<string[]>([]);
  readonly added = output<Repository>();
  private api = inject(Api);
  private notices = inject(Notices);
  remote = '';

  toggle(id: string): void {
    this.selected.update((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async add(): Promise<void> {
    if (!this.remote.trim()) return;
    try {
      const repo = await this.api.addRepository(this.projectId(), this.remote.trim());
      this.repositories.update((rs) => (rs.some((r) => r.id === repo.id) ? rs : [...rs, repo]));
      this.selected.update((ids) => (ids.includes(repo.id) ? ids : [...ids, repo.id]));
      this.remote = '';
      this.added.emit(repo);
    } catch (e) {
      this.notices.error(e);
    }
  }
}
