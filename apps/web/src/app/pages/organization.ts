import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Badge, Button, SegmentedControl, EmptyState, Breadcrumbs } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type {
  ActivityFigure as Figure,
  ActivityPeriod,
  OrgActivity,
  Project,
} from '../core/models';
import { Session } from '../core/session';
import { StatStyle } from '../core/stat-style';
import { initials } from '../core/theme';
import { ActivityFigure, StatStyleSwitch } from '../shared/activity-figure';
import { DocList } from '../shared/doc-list';
import { Icon } from '../shared/icon';
import { ScopeList } from '../shared/scope-list';

const PERIOD_KEY = 'openpurpose.activityPeriod';

function readPeriod(): ActivityPeriod {
  try {
    const v = localStorage.getItem(PERIOD_KEY);
    return v === '7d' || v === 'all' ? v : '30d';
  } catch {
    return '30d';
  }
}

@Component({
  selector: 'app-organization',
  imports: [
    Breadcrumbs,
    EmptyState,
    DocList,
    ScopeList,
    RouterLink,
    Icon,
    ActivityFigure,
    StatStyleSwitch,
    Button,
    Badge,
    SegmentedControl,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (session.org(); as org) {
      <header class="os-page-header">
        <div>
          @if (session.groupShown()) {
            <nav os-breadcrumbs>
              <ol>
                <li>
                  <a routerLink="/group">{{ session.group()?.name }}</a>
                </li>
              </ol>
            </nav>
          }
          <div class="title-row">
            <span class="badge lg" [style.background]="session.orgColor(org.id)">{{
              initials(org.name)
            }}</span>
            <h1 class="os-page-title">{{ org.name }}</h1>
          </div>
          <p class="os-page-description">
            {{
              org.summary ||
                'Rules here reach every agent in ' +
                  org.name +
                  (session.groupShown() ? ', after the workspace rules and' : ',') +
                  ' before project rules.'
            }}
          </p>
        </div>
        <div class="os-page-actions">
          @if (session.canAdmin(org.id)) {
            <a os-button routerLink="/settings/group"><app-icon name="settings" />Manage</a>
          }
          @if (session.canEdit(org.id)) {
            <a os-button variant="primary" routerLink="/projects"
              ><app-icon name="plus" />New project</a
            >
          }
        </div>
      </header>

      <section class="block activity" aria-labelledby="activity-h">
        <div class="block-head">
          <div>
            <h2 id="activity-h">Agent activity</h2>
            <p class="quiet">What agents in {{ org.name }} requested over MCP.</p>
          </div>
          <div class="activity-controls">
            <os-segmented-control label="Period" size="sm" [options]="periods" [(value)]="period" />
            <app-stat-style-switch />
          </div>
        </div>
        @if (activity(); as a) {
          @if (!a.tracking_since) {
            <os-empty-state title="No agent requests yet" bordered>
              Counts start when an agent calls <code>get_context</code>.
            </os-empty-state>
          } @else {
            <div class="os-stat-grid">
              <div class="os-stat-tile">
                <span class="os-stat-label">Read requests</span>
                <app-activity-figure
                  [count]="a.reads.count"
                  [previous]="a.reads.previous"
                  [daily]="a.reads.daily"
                  [days]="a.days"
                  [compare]="compare()"
                  unit="reads"
                />
              </div>
              <div class="os-stat-tile">
                <span class="os-stat-label">Write requests</span>
                <app-activity-figure
                  [count]="a.writes.count"
                  [previous]="a.writes.previous"
                  [daily]="a.writes.daily"
                  [days]="a.days"
                  [compare]="compare()"
                  unit="writes"
                />
              </div>
              @for (t of tops(a); track t.label) {
                <div class="os-stat-tile">
                  <span class="os-stat-label">{{ t.label }}</span>
                  @if (t.items[0]; as top) {
                    <a class="stat-name" [routerLink]="top.link">{{ top.name }}</a>
                    @if (top.where) {
                      <span class="stat-where">{{ top.where }}</span>
                    }
                    <app-activity-figure
                      [count]="top.count"
                      [previous]="top.previous"
                      [daily]="top.daily"
                      [days]="a.days"
                      [compare]="compare()"
                      [unit]="t.unit"
                      size="sm"
                    />
                    @if (t.items.length > 1) {
                      <ol class="stat-rest" start="2">
                        @for (r of t.items.slice(1); track r.name) {
                          <li>
                            @if (r.link) {
                              <a [routerLink]="r.link">{{ r.name }}</a>
                            } @else {
                              {{ r.name }}
                            }
                            @if (r.where) {
                              <span class="quiet">{{ r.where }}</span>
                            }
                            <span class="stat-count">{{ r.count }}</span>
                          </li>
                        }
                      </ol>
                    }
                  } @else {
                    <span class="quiet">Nothing in this period</span>
                  }
                </div>
              }
              <div class="os-stat-tile" [class.warn]="a.stale_documents.length">
                <span class="os-stat-label"
                  >Not requested in the last {{ period() === '7d' ? 'week' : 'month' }}</span
                >
                @if (a.stale_documents.length) {
                  <span class="fig-num static">{{ a.stale_documents.length }}</span>
                  <ul class="stat-rest">
                    @for (d of a.stale_documents.slice(0, 4); track d.id) {
                      <li>
                        <a [routerLink]="['/documents', d.id]">{{ d.title }}</a>
                        @if (d.where) {
                          <span class="quiet">{{ d.where }}</span>
                        }
                      </li>
                    }
                  </ul>
                  <span class="quiet"
                    >Disable them to stop sending them to agents and save tokens.</span
                  >
                } @else {
                  <span class="quiet">Agents use every document.</span>
                }
              </div>
            </div>
            @if (style.choice() === 'dots') {
              <p class="dots-legend" aria-hidden="true">
                Less <span class="dot" data-level="0"></span><span class="dot" data-level="1"></span
                ><span class="dot" data-level="2"></span><span class="dot" data-level="3"></span
                ><span class="dot" data-level="4"></span> More
              </p>
            }
          }
        }
      </section>

      @if (recent().length) {
        <section class="block">
          <div class="block-head">
            <div><h2>Projects</h2></div>
            <a routerLink="/projects" os-button variant="link" size="sm"
              >All {{ org.projects }} projects</a
            >
          </div>
          <ul class="project-list">
            @for (p of recent(); track p.id) {
              <li>
                <a [routerLink]="['/projects', p.id]">
                  <span class="project-id">
                    <span class="project-name"
                      >{{ p.name }}
                      @if (!p.reviewed) {
                        <span os-badge tone="warning">Needs review</span>
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
          emptyTitle="No organization documents yet"
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
          emptyTitle="No organization-wide scopes yet"
        />
      </section>
    } @else {
      <header class="os-page-header">
        <div>
          <h1 class="os-page-title">Choose an organization</h1>
          <p class="os-page-description">
            Pick one in the switcher at the top of the menu, or start from
            <a routerLink="/group">{{ session.group()?.name }}</a
            >.
          </p>
        </div>
      </header>
    }
  `,
})
export class OrganizationPage {
  readonly session = inject(Session);
  private api = inject(Api);
  readonly initials = initials;
  readonly recent = signal<Project[]>([]);
  readonly style = inject(StatStyle);
  readonly activity = signal<OrgActivity | null>(null);
  readonly period = signal<ActivityPeriod>(readPeriod());
  readonly periods: { value: ActivityPeriod; label: string }[] = [
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: 'all', label: 'All time' },
  ];

  readonly compare = computed(() =>
    this.period() === '7d' ? 'the 7 days before' : 'the 30 days before',
  );

  /** The "most …" tiles: one leader, with the runners-up below it. */
  tops(a: OrgActivity): {
    label: string;
    unit: string;
    items: (Figure & { name: string; where?: string; link: unknown[] | null })[];
  }[] {
    return [
      {
        label: 'Most read document',
        unit: 'requests',
        items: a.most_read_documents.map((d) => ({
          ...d,
          name: d.title,
          link: ['/documents', d.id],
        })),
      },
      {
        label: 'Most read project',
        unit: 'requests',
        items: a.most_read_projects.map((p) => ({ ...p, link: ['/projects', p.id] })),
      },
      {
        label: 'Written most',
        unit: 'writes',
        items: a.most_written_documents.map((d) => ({
          ...d,
          name: d.title,
          link: ['/documents', d.id],
        })),
      },
      {
        label: 'Most active writing agent',
        unit: 'writes',
        items: a.top_writers.map((w) => ({ ...w, link: null })),
      },
    ];
  }

  constructor() {
    effect(() => {
      const id = this.session.orgId();
      const period = this.period();
      try {
        localStorage.setItem(PERIOD_KEY, period);
      } catch {
        /* storage unavailable */
      }
      if (id)
        void this.api
          .orgActivity(id, period)
          .then((a) => { this.activity.set(a); })
          .catch(() => { this.activity.set(null); });
    });
    effect(() => {
      const id = this.session.orgId();
      if (id)
        void this.api
          .projects({ organizationId: id })
          .then((p) => { this.recent.set(p.slice(0, 6)); })
          .catch(() => undefined);
    });
  }
}
