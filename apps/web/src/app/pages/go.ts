import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Session } from '../core/session';

/** Resolves a [[wikilink]] and redirects to the project or term. */
@Component({
  selector: 'app-go',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (restricted(); as r) {
      <header class="page-head">
        <h1>{{ r.name }}</h1>
        <p class="lede">
          This belongs to {{ r.org }}, which you can't read. A group admin can share it with your
          organization.
        </p>
      </header>
      <p><a routerLink="/group">See who can read what</a></p>
    } @else if (missing()) {
      <header class="page-head">
        <h1>“{{ missing() }}” does not exist yet</h1>
        <p class="lede">
          Something links here, but there is no project or glossary term with that name.
        </p>
      </header>
      <p>
        Create a project with this name on the <a routerLink="/projects">Projects</a> page, or add
        it as a term to a Glossary document. The link starts working right away. To point into
        another organization, write <code>[[org-slug/project-slug]]</code>.
      </p>
    }
  `,
})
export class GoPage {
  readonly target = input.required<string>();
  readonly session = inject(Session);
  private api = inject(Api);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  readonly missing = signal('');
  readonly restricted = signal<{ name: string; org: string } | null>(null);

  constructor() {
    effect(() => void this.resolve(this.target()));
  }

  private async resolve(target: string): Promise<void> {
    const q = this.route.snapshot.queryParamMap;
    const r = await this.api.resolveLink(target, {
      project: q.get('from'),
      organization: q.get('org'),
    });
    if (r.type === 'missing') {
      this.missing.set(target.replace(/^(project|term)\s*:\s*/i, ''));
    } else if (r.restricted) {
      const name = r.type === 'project' ? r.name : r.heading;
      const org =
        r.type === 'project' && r.organization_slug
          ? (this.session.orgs().find((o) => o.slug === r.organization_slug)?.name ??
            r.organization_slug)
          : 'another organization';
      this.restricted.set({ name, org });
    } else if (r.type === 'project') {
      await this.router.navigate(['/projects', r.id], { replaceUrl: true });
    } else {
      await this.router.navigate(['/documents', r.document_id], {
        fragment: 's-' + r.section_id.slice(0, 8),
        replaceUrl: true,
      });
    }
  }
}
