import { inject } from '@angular/core';
import { Router, type Routes } from '@angular/router';
import { Session } from './core/session';

/** In agent mode the agent console is the only page; outside it, there is no console. */
const agentOnly = () => inject(Session).agentMode() || inject(Router).parseUrl('/organization');
const notInAgentMode = () => !inject(Session).agentMode() || inject(Router).parseUrl('/agent');

export const routes: Routes = [
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
        title: 'Group',
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
        path: 'map',
        title: 'Map',
        loadComponent: () => import('./pages/map').then((m) => m.MapPage),
      },
      { path: 'preview', redirectTo: 'settings/test' },
      {
        path: 'search',
        title: 'Search',
        loadComponent: () => import('./pages/search').then((m) => m.SearchPage),
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
