import { inject } from '@angular/core';
import { type ActivatedRouteSnapshot, Router, type Routes } from '@angular/router';
import { Session } from './core/session';

/** In agent mode the agent console is the only page; outside it, there is no console. */
const agentOnly = () => inject(Session).agentMode() || inject(Router).parseUrl('/organization');
const openSearch = (route: ActivatedRouteSnapshot) => {
  inject(Session).palette.set(route.queryParamMap.get('q') ?? '');
  return inject(Router).parseUrl('/organization');
};
const notInAgentMode = () => !inject(Session).agentMode() || inject(Router).parseUrl('/agent');
const signedOut = () => !inject(Session).token() || inject(Router).parseUrl('/organization');

/** Pages that show on their own, signed in or not. Every other page needs someone signed in. */
export const isPublicUrl = (url: string) => /^\/(sign-in|sign-up|auth\/done)(?=[/?#]|$)/.test(url);

export const routes: Routes = [
  {
    path: 'sign-in',
    title: 'Sign in',
    canActivate: [signedOut],
    loadComponent: () => import('./pages/sign-in').then((m) => m.SignInPage),
  },
  {
    path: 'sign-up',
    title: 'Sign up',
    canActivate: [signedOut],
    data: { mode: 'sign-up' },
    loadComponent: () => import('./pages/sign-in').then((m) => m.SignInPage),
  },
  {
    path: 'auth/done',
    title: 'Signing in',
    loadComponent: () => import('./pages/auth-done').then((m) => m.AuthDonePage),
  },
  {
    path: 'agent',
    title: 'Agent mode',
    canMatch: [agentOnly],
    loadComponent: () => import('./pages/agent-console').then((m) => m.AgentConsolePage),
  },
  {
    path: '',
    canActivateChild: [notInAgentMode],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'organization' },
      {
        path: 'group',
        title: 'Workspace',
        loadComponent: () => import('./pages/group').then((m) => m.GroupPage),
      },
      {
        path: 'organization',
        title: 'Organization',
        loadComponent: () => import('./pages/organization').then((m) => m.OrganizationPage),
      },
      {
        path: 'projects',
        title: 'Projects',
        loadComponent: () => import('./pages/projects').then((m) => m.ProjectsPage),
      },
      {
        path: 'projects/:id',
        title: 'Project',
        loadComponent: () => import('./pages/project').then((m) => m.ProjectPage),
      },
      {
        path: 'scopes/:id',
        title: 'Scope',
        loadComponent: () => import('./pages/scope').then((m) => m.ScopePage),
      },
      {
        path: 'documents/:id',
        title: 'Document',
        loadComponent: () => import('./pages/document').then((m) => m.DocumentPage),
      },
      {
        path: 'inbox',
        title: 'Inbox',
        loadComponent: () => import('./pages/inbox').then((m) => m.InboxPage),
      },
      {
        path: 'findings',
        title: 'Findings',
        loadComponent: () => import('./pages/findings').then((m) => m.FindingsPage),
      },
      {
        path: 'map',
        title: 'Map',
        loadComponent: () => import('./pages/map').then((m) => m.MapPage),
      },
      { path: 'preview', redirectTo: 'settings/test' },
      // Search lives in ⌘K; old /search?q= links open it with their query.
      {
        path: 'search',
        canActivate: [openSearch],
        children: [],
      },
      { path: 'settings', pathMatch: 'full', redirectTo: 'settings/account' },
      {
        path: 'settings/:tab',
        title: 'Settings',
        loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage),
      },
      { path: 'people', redirectTo: 'settings/people' },
      { path: 'groups', redirectTo: 'settings/server' },
      { path: 'go/:target', loadComponent: () => import('./pages/go').then((m) => m.GoPage) },
      { path: '**', redirectTo: 'organization' },
    ],
  },
];
