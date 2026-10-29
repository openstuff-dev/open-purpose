import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Badge, Button, Chip } from '@openstuff-dev/ui-angular';
import { ROLE_LABEL, type Organization } from '../core/models';
import { Session } from '../core/session';
import { ContextSwitch } from '../core/switch';
import { initials } from '../core/theme';
import { DocList } from '../shared/doc-list';
import { Icon } from '../shared/icon';
import { ScopeList } from '../shared/scope-list';

@Component({
  selector: 'app-group',
  imports: [DocList, ScopeList, RouterLink, Icon, Button, Badge, Chip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (session.group(); as g) {
      <header class="os-page-header">
        <div>
          <div class="title-row">
            <span class="badge lg group">{{ initials(g.name) }}</span>
            <h1 class="os-page-title">{{ g.name }}</h1>
          </div>
          <p class="os-page-description">
            Rules here reach every agent in every organization, before any organization or project
            rules.
          </p>
        </div>
        <div class="os-page-actions">
          @if (g.can_admin) {
            <a os-button routerLink="/settings/group"><app-icon name="settings" />Manage</a>
          }
        </div>
      </header>

      <section class="block">
        <div class="block-head">
          <div>
            <h2>Organizations</h2>
            <p class="quiet">
              Each keeps its own rules, projects and inbox, and is private to its members unless
              shared.
            </p>
          </div>
        </div>
        <ul class="org-list">
          @for (o of orgs(); track o.id) {
            <li>
              <div class="org-main">
                <span
                  class="badge"
                  [style.background]="o.readable ? session.orgColor(o.id) : 'var(--faint)'"
                  >{{ initials(o.name) }}</span
                >
                @if (o.readable) {
                  <button
                    type="button"
                    os-button
                    variant="link"
                    size="sm"
                    class="org-name"
                    (click)="open(o)"
                  >
                    {{ o.name }}
                  </button>
                } @else {
                  <span class="org-name">{{ o.name }}</span
                  ><span os-badge><app-icon name="lock" [size]="11" />No access</span>
                }
                @if (o.role) {
                  <span os-chip>{{ roleLabel[o.role] }}</span>
                }
                <span class="quiet org-count">
                  @if (o.projects !== null) {
                    {{ o.projects }} {{ o.projects === 1 ? 'project' : 'projects' }}
                  }
                </span>
              </div>
              @if (o.summary) {
                <p class="quiet multiline">{{ o.summary }}</p>
              }
              @if (readersOf(o).length) {
                <p class="org-readers">
                  <app-icon name="share" [size]="12" />Shared with {{ readersOf(o).join(', ') }}
                </p>
              }
            </li>
          }
        </ul>
      </section>

      <section class="block">
        <div class="block-head">
          <div>
            <h2>Workspace documents</h2>
            <p class="quiet">
              Purpose, rules and glossary that hold in every organization: security, privacy, legal,
              shared terms.
            </p>
          </div>
        </div>
        <app-doc-list
          [organizationId]="null"
          [canEdit]="g.can_edit"
          emptyTitle="No workspace documents yet"
        />
      </section>

      <section class="block">
        <div class="block-head">
          <div>
            <h2>Workspace-wide scopes</h2>
            <p class="quiet">
              Rules for a kind of code in every organization, such as all .NET services. Matched by
              stack tags or paths.
            </p>
          </div>
        </div>
        <app-scope-list
          [organizationId]="null"
          [canEdit]="g.can_edit"
          emptyTitle="No workspace-wide scopes yet"
          emptyText="A typical first one is “.NET services” with the stack tag dotnet."
        />
      </section>
    }
  `,
})
export class GroupPage {
  readonly session = inject(Session);
  private switcher = inject(ContextSwitch);
  private router = inject(Router);
  readonly roleLabel = ROLE_LABEL;
  readonly initials = initials;
  readonly orgs = computed(() => this.session.orgs());

  readersOf(o: Organization): string[] {
    return o.readers.map((id) => this.session.orgName(id));
  }

  async open(o: Organization): Promise<void> {
    await this.switcher.org(o.id);
    await this.router.navigate(['/organization']);
  }
}
