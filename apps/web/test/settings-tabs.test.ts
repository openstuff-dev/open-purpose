/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveTab, tabsFor } from '../src/app/pages/settings/settings-tabs';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const labels = (group: string, admin: boolean, serverAdmin: boolean): string[] =>
  tabsFor({ admin, serverAdmin })
    .filter((tab) => tab.group === group)
    .map((tab) => tab.label);

describe('Settings tabs', () => {
  it('UC-1/S1 an editor or viewer sees only their own settings', () => {
    expect(labels('you', false, false)).toEqual([
      'Account and tokens',
      'Appearance',
      'Connect an agent',
      'Test a repository',
    ]);
    expect(labels('tenant', false, false)).toEqual([]);
    expect(labels('server', false, false)).toEqual([]);
  });

  it('UC-1/S2 an organization admin sees what they manage', () => {
    expect(labels('tenant', true, false)).toEqual([
      'Organizations',
      'People and agents',
      'Export and import',
    ]);
    expect(labels('server', true, false)).toEqual([]);
  });

  it('UC-1/S5 a tab my role can\'t use sends me to Account', () => {
    expect(resolveTab('people', { admin: false, serverAdmin: false })).toBe('account');
    expect(resolveTab('server', { admin: true, serverAdmin: false })).toBe('account');
    expect(resolveTab('nonsense', { admin: true, serverAdmin: true })).toBe('account');
    expect(resolveTab('people', { admin: true, serverAdmin: false })).toBe('people');
  });

  it('UC-1/S6 old addresses still land on the matching tab', () => {
    const routes = read('../src/app/app.routes.ts');
    expect(routes).toContain("{ path: 'people', redirectTo: 'settings/people' }");
    expect(routes).toContain("{ path: 'groups', redirectTo: 'settings/server' }");
    expect(routes).toContain("{ path: 'preview', redirectTo: 'settings/test' }");
  });

  it('UC-1/S7 the current tab is announced', () => {
    expect(read('../src/app/pages/settings/settings.ts')).toContain('ariaCurrentWhenActive="page"');
  });
});
