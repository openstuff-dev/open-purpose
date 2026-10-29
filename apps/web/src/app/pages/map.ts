import {
  type AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  type OnDestroy,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { select, type Selection } from 'd3-selection';
import { type D3ZoomEvent, zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import 'd3-transition';
import { type D3DragEvent, drag } from 'd3-drag';
import { Button, Check, Checkbox, Control } from '@openstuff-dev/ui-angular';
import { Api } from '../core/api';
import type { Graph, GraphEdge, GraphNode, LinkRef, Project } from '../core/models';
import { Notices } from '../shared/notice';
import { Session } from '../core/session';
import { ContextSwitch } from '../core/switch';

interface SimNode extends SimulationNodeDatum, GraphNode {
  degree: number;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  edge: GraphEdge;
}

const RADIUS: Record<GraphNode['type'], number> = {
  group: 18,
  organization: 14,
  project: 9,
  term: 5,
  missing: 5,
};

@Component({
  selector: 'app-map',
  imports: [FormsModule, RouterLink, Button, Control, Check, Checkbox],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'map-page' },
  template: `
    <header class="map-bar">
      <h1>Map</h1>
      <label
        >Focus
        <select os-select [ngModel]="focus()" (ngModelChange)="setFocus($event)">
          <option value="">
            Everything {{ session.agentView() ? 'the agent' : 'I' }} can read
          </option>
          @for (p of projects(); track p.id) {
            <option [value]="p.id">{{ p.name }} ({{ p.organization_name }})</option>
          }
        </select>
      </label>
      @if (focus()) {
        <label
          >Reach
          <select os-select [ngModel]="depth()" (ngModelChange)="depth.set(+$event); reload()">
            <option [value]="1">Direct links</option>
            <option [value]="2">Two steps</option>
            <option [value]="3">Three steps</option>
          </select>
        </label>
      }
      <label os-check
        ><input
          os-checkbox
          type="checkbox"
          [ngModel]="showTerms()"
          (ngModelChange)="showTerms.set($event); draw()"
        />
        Terms</label
      >
      <label os-check
        ><input
          os-checkbox
          type="checkbox"
          [ngModel]="showMissing()"
          (ngModelChange)="showMissing.set($event); reload()"
        />
        Links to nothing yet</label
      >
      <span class="legend" aria-hidden="true">
        @for (o of legendOrgs(); track o.id) {
          <span><i class="dot" [style.background]="o.color"></i>{{ o.name }}</span>
        }
        <span><i class="dot term"></i>Term</span>
        <span><i class="dot restricted"></i>No access</span>
      </span>
    </header>

    <div class="map-stage">
      <svg #svg class="map-svg" role="img" [attr.aria-label]="ariaLabel()"></svg>
      @if (empty()) {
        <div class="map-empty">
          <p>
            No links yet. Write <code>[[project-slug]]</code> or <code>[[Term]]</code> in any
            document, and the connection appears here.
          </p>
        </div>
      }
      @if (selected(); as n) {
        <aside class="map-panel" aria-live="polite">
          <button
            os-button
            variant="link"
            size="sm"
            class="close"
            type="button"
            (click)="select(null)"
            aria-label="Close details"
          >
            Close
          </button>
          <span class="node-type">{{ typeLabel(n) }}</span>
          <h2>{{ n.label }}</h2>
          @if (n.restricted) {
            <p class="quiet">
              This belongs to {{ session.orgName(n.organization_id) }}, which you can't read. You
              see it because something you can read links to it.
            </p>
          } @else if (n.summary) {
            <p class="multiline">{{ n.summary }}</p>
          }
          <div class="form-actions">
            @if (n.type === 'project' && !n.restricted) {
              <a os-button [routerLink]="['/projects', n.project_id]">Open project</a>
              @if (focus() !== n.project_id) {
                <button os-button type="button" (click)="setFocus(n.project_id!)">
                  Focus here
                </button>
              }
            } @else if (n.type === 'term' && !n.restricted) {
              <a
                os-button
                [routerLink]="['/go', 'term:' + n.label]"
                [queryParams]="n.organization_id ? { org: n.organization_id } : {}"
                >Open term</a
              >
            } @else if (n.type === 'group') {
              <a os-button routerLink="/workspace">Open {{ n.label }}</a>
            } @else if (n.type === 'organization' && !n.restricted) {
              <button os-button type="button" (click)="openOrg(n.organization_id!)">
                Open {{ n.label }}
              </button>
            }
          </div>
          @if (outgoing().length) {
            <h3>Uses or refers to</h3>
            <ul>
              @for (c of outgoing(); track c.node.id) {
                <li>
                  <button
                    os-button
                    variant="link"
                    size="sm"
                    type="button"
                    (click)="select(c.node.id)"
                  >
                    {{ c.node.label }}
                  </button>
                  <span class="quiet">{{ refText(c.refs) }}</span>
                </li>
              }
            </ul>
          }
          @if (incoming().length) {
            <h3>Referenced by</h3>
            <ul>
              @for (c of incoming(); track c.node.id) {
                <li>
                  <button
                    os-button
                    variant="link"
                    size="sm"
                    type="button"
                    (click)="select(c.node.id)"
                  >
                    {{ c.node.label }}
                  </button>
                  <span class="quiet">{{ refText(c.refs) }}</span>
                </li>
              }
            </ul>
          }
        </aside>
      }
    </div>
  `,
})
export class MapPage implements AfterViewInit, OnDestroy {
  private api = inject(Api);
  private notices = inject(Notices);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private readonly svgRef = viewChild.required<ElementRef<SVGSVGElement>>('svg');
  readonly session = inject(Session);
  private switcher = inject(ContextSwitch);

  readonly projects = signal<Project[]>([]);
  readonly graph = signal<Graph>({ nodes: [], edges: [], organizations: [] });
  readonly orgColor = computed(() => {
    const m = new Map<string, string>();
    for (const o of this.graph().organizations) m.set(o.id, this.session.orgColor(o.id));
    return m;
  });

  readonly legendOrgs = computed(() => {
    const present = new Set(this.graph().nodes.map((n) => n.organization_id));
    return this.graph()
      .organizations.filter((o) => o.readable && present.has(o.id))
      .map((o) => ({ ...o, color: this.session.orgColor(o.id) }));
  });

  readonly focus = signal('');
  readonly depth = signal(1);
  readonly showTerms = signal(true);
  readonly showMissing = signal(false);
  readonly selectedId = signal<string | null>(null);
  readonly empty = computed(() => this.graph().edges.filter((e) => e.kind === 'link').length === 0);

  readonly selected = computed(
    () => this.graph().nodes.find((n) => n.id === this.selectedId()) ?? null,
  );

  private connections(dir: 'out' | 'in') {
    const id = this.selectedId();
    const nodes = new Map(this.graph().nodes.map((n) => [n.id, n]));
    return this.graph()
      .edges.filter((e) => e.kind === 'link' && (dir === 'out' ? e.source === id : e.target === id))
      .flatMap((e) => {
        const node = nodes.get(dir === 'out' ? e.target : e.source);
        return node ? [{ node, refs: e.refs }] : [];
      });
  }

  readonly outgoing = computed(() => this.connections('out'));
  readonly incoming = computed(() => this.connections('in'));
  readonly ariaLabel = computed(() => {
    const g = this.graph();
    return `Map of ${g.nodes.filter((n) => n.type === 'project').length} projects and ${g.edges.filter((e) => e.kind === 'link').length} links. Select a node from the details panel lists for keyboard navigation.`;
  });

  private sim: Simulation<SimNode, SimLink> | null = null;
  private fitted = false;
  private zoomer: ZoomBehavior<SVGSVGElement, unknown> | null = null;
  private resize = () => { this.draw(); };

  ngAfterViewInit(): void {
    const q = this.route.snapshot.queryParamMap;
    this.focus.set(q.get('focus') ?? '');
    this.depth.set(Number(q.get('depth') ?? 1) || 1);
    void this.api
      .projects({})
      .then((p) => { this.projects.set(p); })
      .catch((e: unknown) => {
        this.notices.error(e);
      });
    window.addEventListener('resize', this.resize);
    void this.reload();
  }

  ngOnDestroy(): void {
    this.sim?.stop();
    window.removeEventListener('resize', this.resize);
  }

  setFocus(projectId: string): void {
    this.focus.set(projectId);
    this.selectedId.set(null);
    void this.router.navigate([], {
      queryParams: { focus: projectId || null, depth: projectId ? this.depth() : null },
      replaceUrl: true,
    });
    void this.reload();
  }

  async openOrg(id: string): Promise<void> {
    await this.switcher.org(id);
    await this.router.navigate(['/organization']);
  }

  async reload(): Promise<void> {
    try {
      this.graph.set(
        await this.api.graph({
          focus: this.focus() || undefined,
          depth: this.depth(),
          missing: this.showMissing(),
        }),
      );
      if (this.focus()) {
        const node = this.graph().nodes.find(
          (n) => n.type === 'project' && (n.project_id === this.focus() || n.slug === this.focus()),
        );
        this.selectedId.set(node?.id ?? null);
      }
      this.draw();
    } catch (e) {
      this.notices.error(e);
    }
  }

  select(id: string | null): void {
    this.selectedId.set(id);
    this.highlight();
  }

  typeLabel(n: GraphNode): string {
    const where = n.organization_id
      ? this.session.orgName(n.organization_id)
      : (this.session.group()?.name ?? 'the workspace');
    return {
      group: 'Workspace',
      organization: 'Organization',
      project: `Project in ${where}`,
      term: `Term in ${where}`,
      missing: 'Linked, not created yet',
    }[n.type];
  }

  refText(refs: LinkRef[]): string {
    return refs.length
      ? `in ${refs
        .map((r) => `“${r.heading}”`)
        .slice(0, 2)
        .join(', ')}`
      : '';
  }

  draw(): void {
    const svgEl = this.svgRef().nativeElement;
    const width = svgEl.clientWidth || 800;
    const height = svgEl.clientHeight || 600;
    this.sim?.stop();

    const g = this.graph();
    const keep = (n: GraphNode) => this.showTerms() || n.type !== 'term';
    const nodes: SimNode[] = g.nodes.filter(keep).map((n) => ({ ...n, degree: 0 }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = g.edges.flatMap((e) => {
      const source = byId.get(e.source);
      const target = byId.get(e.target);
      return source && target ? [{ source, target, edge: e }] : [];
    });
    for (const l of links) {
      (l.source as SimNode).degree++;
      (l.target as SimNode).degree++;
    }
    const r = (n: SimNode) =>
      RADIUS[n.type] + (n.type === 'project' ? Math.min(n.degree, 8) * 1.2 : 0);
    const orgIds = [
      ...new Set(nodes.map((n) => n.organization_id).filter((x): x is string => !!x)),
    ];
    const spread = orgIds.length > 1 ? Math.min(width, height) * 0.3 : 0;
    const anchors = new Map(
      orgIds.map((id, i) => {
        const a = (i / orgIds.length) * Math.PI * 2 - Math.PI / 2;
        return [
          id,
          { x: width / 2 + Math.cos(a) * spread * 1.4, y: height / 2 + Math.sin(a) * spread },
        ];
      }),
    );
    const anchor = (d: SimNode) =>
      anchors.get(d.organization_id ?? '') ?? { x: width / 2, y: height / 2 };

    const svg = select(svgEl);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    const defs = svg.append('defs');
    for (const id of ['arrow', 'arrow-hot', 'arrow-dim']) {
      defs
        .append('marker')
        .attr('id', id)
        .attr('viewBox', '0 -4 8 8')
        .attr('refX', 8)
        .attr('refY', 0)
        .attr('markerWidth', 7)
        .attr('markerHeight', 7)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-4L8,0L0,4')
        .attr('class', id);
    }
    const root = svg.append('g');
    this.zoomer = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        root.attr('transform', ev.transform.toString());
      });
    svg.call(this.zoomer).on('dblclick.zoom', null);
    svg.on('click', (ev: MouseEvent) => {
      if (ev.target === svgEl) this.select(null);
    });

    const link = root
      .append('g')
      .attr('class', 'links')
      .selectAll<SVGLineElement, SimLink>('line')
      .data(links)
      .join('line')
      .attr('class', (d) => `edge ${d.edge.kind}`)
      .attr('stroke-width', (d) =>
        d.edge.kind === 'defines' ? 1 : Math.min(1.2 + d.edge.count * 0.6, 4),
      )
      .attr('marker-end', (d) => (d.edge.kind === 'link' ? 'url(#arrow)' : null));

    const node = root
      .append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, SimNode>('g')
      .data(nodes, (d) => d.id)
      .join('g')
      .attr('class', (d) => `node ${d.type}${d.restricted ? ' restricted' : ''}`)
      .attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-label', (d) => `${this.typeLabel(d)}: ${d.label}`)
      .on('click', (ev: MouseEvent, d) => {
        ev.stopPropagation();
        this.select(d.id);
      })
      .on('keydown', (ev: KeyboardEvent, d) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          this.select(d.id);
        }
      })
      .on('dblclick', (_ev, d) => {
        if (d.type === 'project' && !d.restricted)
          void this.router.navigate(['/projects', d.project_id]);
      });

    node
      .filter((d) => d.type === 'term')
      .append('rect')
      .attr('x', (d) => -r(d))
      .attr('y', (d) => -r(d))
      .attr('width', (d) => r(d) * 2)
      .attr('height', (d) => r(d) * 2)
      .attr('transform', 'rotate(45)');
    const colors = this.orgColor();
    const tint = (d: SimNode) =>
      d.restricted || d.type === 'group' || d.type === 'missing'
        ? null
        : (colors.get(d.organization_id ?? '') ?? null);
    if (this.session.agentView()) {
      // Agent mode draws boxes, like a terminal would: outlined in the organization's colour.
      node
        .filter((d) => d.type !== 'term')
        .append('rect')
        .attr('class', 'box')
        .attr('x', (d) => -r(d))
        .attr('y', (d) => -r(d))
        .attr('width', (d) => r(d) * 2)
        .attr('height', (d) => r(d) * 2)
        .style('--c', tint);
      node
        .append('text')
        .attr('x', (d) => r(d) + 6)
        .attr('y', 4)
        .text((d) => (d.type === 'term' ? d.label : `[${d.label}]`));
    } else {
      node
        .filter((d) => d.type !== 'term')
        .append('circle')
        .attr('r', r)
        .style('fill', tint);
      node
        .append('text')
        .attr('x', (d) => r(d) + 5)
        .attr('y', 4)
        .text((d) => d.label);
    }

    const sim = forceSimulation<SimNode, SimLink>(nodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) => (l.edge.kind === 'defines' ? 46 : 170))
          .strength((l) => (l.edge.kind === 'defines' ? 0.8 : 0.25)),
      )
      .force(
        'charge',
        forceManyBody<SimNode>().strength((d) =>
          d.type === 'term' ? -160 : d.type === 'organization' ? -900 : -700,
        ),
      )
      .force(
        'collide',
        forceCollide<SimNode>().radius((d) => r(d) + Math.min(d.label.length * 3.2, 60)),
      )
      .force('center', forceCenter(width / 2, height / 2))
      // Each organization gathers around its own point on a circle; group-wide things sit
      // in the middle.
      .force(
        'x',
        forceX<SimNode>((d) => anchor(d).x).strength((d) => (d.organization_id ? 0.07 : 0.04)),
      )
      .force(
        'y',
        forceY<SimNode>((d) => anchor(d).y).strength((d) => (d.organization_id ? 0.07 : 0.06)),
      );

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tick = () => {
      link.each(function (d) {
        const s = d.source as SimNode;
        const t = d.target as SimNode;
        const [sx, sy, tx, ty] = [s.x ?? 0, s.y ?? 0, t.x ?? 0, t.y ?? 0];
        const dx = tx - sx;
        const dy = ty - sy;
        const len = Math.hypot(dx, dy) || 1;
        const pad = r(t) + 3;
        select(this)
          .attr('x1', sx)
          .attr('y1', sy)
          .attr('x2', tx - (dx / len) * pad)
          .attr('y2', ty - (dy / len) * pad);
      });
      node.attr('transform', (d) => `translate(${d.x},${d.y})`);
    };
    const fit = () => {
      const zoomer = this.zoomer;
      if (!nodes.length || !zoomer) return;
      const xs = nodes.map((n) => n.x ?? 0);
      const ys = nodes.map((n) => n.y ?? 0);
      const [x0, x1, y0, y1] = [
        Math.min(...xs) - 40,
        Math.max(...xs) + 160,
        Math.min(...ys) - 40,
        Math.max(...ys) + 40,
      ];
      const usable = this.selectedId() && width > 900 ? width - 380 : width;
      const k = Math.min(1.25, 0.92 / Math.max((x1 - x0) / usable, (y1 - y0) / height));
      const t = zoomIdentity
        .translate(usable / 2 - (k * (x0 + x1)) / 2, height / 2 - (k * (y0 + y1)) / 2)
        .scale(k);
      svg
        .transition()
        .duration(reduced ? 0 : 450)
        .call((tr) => {
          zoomer.transform(tr, t);
        });
    };
    if (reduced) {
      sim.stop();
      for (let i = 0; i < 300; i++) sim.tick();
      tick();
      fit();
    } else {
      this.fitted = false;
      sim.on('tick', () => {
        tick();
        if (!this.fitted && sim.alpha() < 0.12) {
          this.fitted = true;
          fit();
        }
      });
    }

    node.call(
      drag<SVGGElement, SimNode>()
        .on('start', (ev: D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
          if (!ev.active) sim.alphaTarget(0.2).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (ev: D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
          d.fx = ev.x;
          d.fy = ev.y;
          if (reduced) tick();
        })
        .on('end', (ev: D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
          if (!ev.active) sim.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }),
    );

    this.sim = sim;
    this.nodeSel = node;
    this.linkSel = link;
    this.zoomer.transform(svg, zoomIdentity);
    this.highlight();
  }

  private nodeSel: Selection<SVGGElement, SimNode, SVGGElement, unknown> | null = null;
  private linkSel: Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null = null;

  private highlight(): void {
    const id = this.selectedId();
    if (!this.nodeSel || !this.linkSel) return;
    if (!id) {
      this.nodeSel.classed('dim', false).classed('hot', false);
      this.linkSel
        .classed('dim', false)
        .classed('hot', false)
        .attr('marker-end', (d) => (d.edge.kind === 'link' ? 'url(#arrow)' : null));
      return;
    }
    const near = new Set([id]);
    this.linkSel.each((d) => {
      const s = (d.source as SimNode).id;
      const t = (d.target as SimNode).id;
      if (s === id) near.add(t);
      if (t === id) near.add(s);
    });
    this.nodeSel.classed('dim', (d) => !near.has(d.id)).classed('hot', (d) => d.id === id);
    const hot = (d: SimLink) => (d.source as SimNode).id === id || (d.target as SimNode).id === id;
    this.linkSel
      .classed('dim', (d) => !hot(d))
      .classed('hot', hot)
      .attr('marker-end', (d) =>
        d.edge.kind === 'link' ? (hot(d) ? 'url(#arrow-hot)' : 'url(#arrow-dim)') : null,
      );
  }
}
