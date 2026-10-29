import { type HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import type { ConfirmDialog } from '@openstuff-dev/ui-angular';
import type { Me, Organization } from './models';
import { orgColor } from './theme';

const TOKEN = 'openpurpose.token';
const GROUP = 'openpurpose.group';
const ORG = 'openpurpose.org';
const AGENT = 'openpurpose.agent';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable: keep it in memory only */
  }
}

/** The project and organization the page on screen belongs to, for ⌘K to search near. */
export interface Here {
  project: { id: string; name: string } | null;
  organization: { id: string; name: string } | null;
}

/**
 * Who is signed in, and which group and organization they are looking at.
 * The group decides which data the server shows at all; the organization is
 * the default place for new projects, the map focus and so on.
 */
@Injectable({ providedIn: 'root' })
export class Session {
  readonly token = signal<string | null>(read(TOKEN));
  readonly me = signal<Me | null>(null);
  /** Group id or slug the user picked; the server's default when null. */
  readonly groupChoice = signal<string | null>(read(GROUP));
  /** Bumped after the group or organization changed and /me reloaded, so pages are rebuilt. */
  readonly view = signal(0);

  readonly group = computed(() => this.me()?.group ?? null);
  readonly orgs = computed(() => (this.me()?.organizations ?? []).filter((o) => !o.archived_at));
  readonly readableOrgs = computed(() => this.orgs().filter((o) => o.readable));
  /**
   * A group with one organization is just that organization: the group layer
   * (its page, menu, breadcrumbs) only appears once there is a second one.
   */
  readonly groupShown = computed(() => (this.me()?.organizations.length ?? 0) > 1);
  readonly orgId = computed(() => this.me()?.current_organization_id ?? null);
  /** Agent mode: the UI shows exactly what an agent in the current organization reads. */
  readonly agentMode = signal(read(AGENT) === '1');
  /** Set by project, scope and document pages while they are open. */
  readonly here = signal<Here | null>(null);
  /** ⌘K: null = closed, otherwise the query it opens with. */
  readonly palette = signal<string | null>(null);
  readonly agentView = computed(() => this.me()?.agent_view ?? null);
  /** Organizations whose agents this person may look through the eyes of. */
  readonly agentOrgs = computed(() => {
    const ids = this.agentView()?.switchable_organization_ids ?? [];
    return this.orgs().filter((o) => ids.includes(o.id));
  });

  readonly org = computed<Organization | null>(
    () => this.orgs().find((o) => o.id === this.orgId()) ?? null,
  );

  setToken(token: string | null): void {
    write(TOKEN, token);
    this.token.set(token);
    if (!token) {
      this.me.set(null);
      this.setAgentMode(false);
    }
  }

  /** Header values for the interceptor. */
  orgChoice(): string | null {
    return read(ORG);
  }

  chooseGroup(id: string): void {
    write(GROUP, id);
    this.groupChoice.set(id);
  }

  chooseOrg(id: string | null): void {
    write(ORG, id);
  }

  setAgentMode(on: boolean): void {
    write(AGENT, on ? '1' : null);
    this.agentMode.set(on);
  }

  /** Identity colour of an organization (stable within the group). */
  orgColor(id: string | null): string {
    const i = (this.me()?.organizations ?? []).findIndex((o) => o.id === id);
    return i < 0 ? 'var(--muted)' : orgColor(i);
  }

  orgName(id: string | null): string {
    if (!id) return this.group()?.name ?? 'Workspace';
    return this.me()?.organizations.find((o) => o.id === id)?.name ?? 'Unknown organization';
  }

  /** Edit rights at a level (null = group-wide). Detail endpoints also return can_edit. */
  canEdit(orgId: string | null): boolean {
    const me = this.me();
    if (me?.actor.kind !== 'human' || me.agent_view) return false;
    if (orgId === null) return me.group.can_edit;
    const role = me.organizations.find((o) => o.id === orgId)?.role;
    return role === 'admin' || role === 'editor';
  }

  canAdmin(orgId: string | null): boolean {
    const me = this.me();
    if (me?.actor.kind !== 'human' || me.agent_view) return false;
    if (orgId === null) return me.group.can_admin;
    return me.organizations.find((o) => o.id === orgId)?.role === 'admin';
  }

  /** Admin of the group or of any organization in it. */
  get adminsAnything(): boolean {
    const me = this.me();
    return (
      !!me &&
      !me.agent_view &&
      (me.group.can_admin || me.organizations.some((o) => o.role === 'admin'))
    );
  }

  get isSuperadmin(): boolean {
    return !!this.me()?.actor.is_superadmin;
  }
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const session = inject(Session);
  const token = session.token();
  let out = req;
  if (token && req.url.startsWith('/api')) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const group = session.groupChoice();
    const org = session.orgChoice();
    // A request may name its group itself (e.g. exporting another group).
    if (group && !req.headers.has('X-OpenPurpose-Group')) headers['X-OpenPurpose-Group'] = group;
    if (org) headers['X-OpenPurpose-Org'] = org;
    if (session.agentMode()) headers['X-OpenPurpose-Agent-View'] = '1';
    out = req.clone({ setHeaders: headers });
  }
  return next(out).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401) session.setToken(null);
      return throwError(() => err);
    }),
  );
};

/** Set when a create or rename failed because the slug is still another one's old slug. */
export function aliasConflict(err: unknown): { id: string; name: string; slug: string } | null {
  const body = (err as HttpErrorResponse | undefined)?.error as
    { error?: string; alias_of?: { id: string; name: string; slug: string } } | undefined;
  return body?.error === 'conflict' && body.alias_of ? body.alias_of : null;
}

/**
 * Run a create that may land on another one's old slug. If it does, ask before
 * taking the slug over, since repositories and links using it would follow.
 * Resolves to undefined when the person says no.
 */
export async function claimingOldSlug<T>(
  confirmDialog: ConfirmDialog,
  run: (take_alias?: boolean) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (e) {
    if (!aliasConflict(e)) throw e;
    const take = await confirmDialog.confirm({
      title: 'Take this slug?',
      message: errorMessage(e),
      confirmLabel: 'Take the slug',
    });
    return take ? run(true) : undefined;
  }
}

/** Pull the server's message out of an HttpErrorResponse. */
export function errorMessage(err: unknown): string {
  const e = err as HttpErrorResponse | undefined;
  const body = e?.error as { message?: string } | undefined;
  if (body?.message) return body.message;
  if (e?.status === 0) return 'Cannot reach the OpenPurpose server.';
  return e?.message ?? String(err);
}

/** Tells ⌘K which project and organization this page is about, until the page closes. */
export function provideHere(source: () => Here | null): void {
  const session = inject(Session);
  let mine: Here | null = null;
  effect(() => {
    const here = source();
    untracked(() => {
      mine = here;
      session.here.set(here);
    });
  });
  inject(DestroyRef).onDestroy(() => {
    if (mine && session.here() === mine) session.here.set(null);
  });
}
