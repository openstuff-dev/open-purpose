/**
 * Every tab in Settings, in the order of the menu, and who may use it. The menu and the page both
 * read this list, and the server still decides what each person may change.
 */
export type SettingsTabId =
  | 'account' |
  'appearance' |
  'connect' |
  'test' |
  'workspace' |
  'people' |
  'integrations' |
  'transfer' |
  'server';

export type SettingsGroupId = 'you' | 'tenant' | 'server';

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  /** A name from shared/icon.ts. */
  icon: string;
  group: SettingsGroupId;
}

export interface SettingsAccess {
  /** Admins the workspace or at least one organization. */
  admin: boolean;
  serverAdmin: boolean;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: 'account', label: 'Account and tokens', icon: 'user', group: 'you' },
  { id: 'appearance', label: 'Appearance', icon: 'palette', group: 'you' },
  { id: 'connect', label: 'Connect an agent', icon: 'plug', group: 'you' },
  { id: 'test', label: 'Test a repository', icon: 'eye', group: 'you' },
  { id: 'workspace', label: 'Organizations', icon: 'building', group: 'tenant' },
  { id: 'people', label: 'People and agents', icon: 'users', group: 'tenant' },
  { id: 'integrations', label: 'Integrations', icon: 'plug', group: 'tenant' },
  { id: 'transfer', label: 'Export and import', icon: 'transfer', group: 'tenant' },
  { id: 'server', label: 'All workspaces', icon: 'server', group: 'server' },
];

export function tabsFor(access: SettingsAccess): SettingsTab[] {
  return SETTINGS_TABS.filter(({ id, group }) => {
    // Only server connections for now, so only server admins see Integrations.
    if (id === 'integrations') return access.serverAdmin;
    if (group === 'tenant') return access.admin;
    if (group === 'server') return access.serverAdmin;
    return true;
  });
}

/** The tab to show for an address: one this person can't use, or that doesn't exist, is Account. */
export function resolveTab(requested: string | undefined, access: SettingsAccess): SettingsTabId {
  return tabsFor(access).find(({ id }) => id === requested)?.id ?? 'account';
}
