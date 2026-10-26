import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import type { Project } from '../core/models';
import { Session } from '../core/session';
import { initials } from '../core/theme';
import { DocList } from '../shared/doc-list';
import { Icon } from '../shared/icon';
import { ScopeList } from '../shared/scope-list';

@Component({
  selector: 'app-organization',
  imports: [DocList, ScopeList, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (session.org(); as org) {
      <header class="page-head">
        @if (session.groupShown()) {
          <nav class="crumbs" aria-label="Breadcrumb">
            <a routerLink="/group">{{ session.group()?.name }}</a>
          </nav>
        }
        <div class="title-row">
          <span
            class="badge"
            style="width:2.25rem;height:2.25rem;font-size:0.8rem"
            [style.background]="session.orgColor(org.id)"
            >{{ initials(org.name) }}</span
          >
          <h1>{{ org.name }}</h1>
          @if (session.canAdmin(org.id)) {
            <a class="btn" routerLink="/settings/group"><app-icon name="settings" />Manage</a>
          }
          @if (session.canEdit(org.id)) {
            <a class="btn primary" routerLink="/projects"><app-icon name="plus" />New project</a>
          }
        </div>
        <p class="lede">
          {{
            org.summary ||
              'Rules here reach every agent in ' +
                org.name +
                (session.groupShown() ? ', after the group rules and' : ',') +
                ' before project rules.'
          }}
        </p>
      </header>

      @if (recent().length) {
        <section class="block">
          <div class="block-head">
            <div><h2>Projects</h2></div>
            <a routerLink="/projects" class="link-btn">All {{ org.projects }} projects</a>
          </div>
          <ul class="project-list">
            @for (p of recent(); track p.id) {
              <li>
                <a [routerLink]="['/projects', p.id]">
                  <span class="project-id">
                    <span class="project-name"
                      >{{ p.name }}
                      @if (!p.reviewed) {
                        <span class="flag">Needs review</span>
                      }
                    </span>
                    <code class="project-slug">{{ p.slug }}</code>
                  </span>
                  <span class="project-summary">{{ p.summary || 'No summary yet' }}</span>
                  <span class="project-stats">
                    @if (p.pending_proposals) {
                      <span class="pending">{{ p.pending_proposals }} to review</span>
                    }
                    <span><app-icon name="branch" [size]="12" /> {{ p.repository_count }}</span>
                  </span>
                </a>
              </li>
            }
          </ul>
        </section>
      }

      <section class="block">
        <div class="block-head">
          <div>
            <h2>Organization documents</h2>
            <p class="quiet">
              Purpose, business logic, glossary and guidelines for every project in {{ org.name }}.
            </p>
          </div>
        </div>
        <app-doc-list
          [organizationId]="org.id"
          [canEdit]="session.canEdit(org.id)"
          emptyText="No organization documents yet."
        />
      </section>

      <section class="block">
        <div class="block-head">
          <div>
            <h2>Organization-wide scopes</h2>
            <p class="quiet">
              Rules for a kind of code in every {{ org.name }} project, such as every Angular app.
            </p>
          </div>
        </div>
        <app-scope-list
          [organizationId]="org.id"
          [canEdit]="session.canEdit(org.id)"
          emptyText="No organization-wide scopes yet."
        />
      </section>
    } @else {
      <header class="page-head">
        <h1>Choose an organization</h1>
        <p class="lede">
          Pick one in the switcher at the top of the menu, or start from
          <a routerLink="/group">{{ session.group()?.name }}</a
          >.
        </p>
      </header>
    }
  `,
})
export class OrganizationPage {
  readonly session = inject(Session);
  private api = inject(Api);
  readonly initials = initials;
  readonly recent = signal<Project[]>([]);

  constructor() {
    effect(() => {
      const id = this.session.orgId();
      if (id)
        void this.api
          .projects({ organizationId: id })
          .then((p) => this.recent.set(p.slice(0, 6)))
          .catch(() => {});
    });
  }
}
