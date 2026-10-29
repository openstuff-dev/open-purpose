/**
 * The sign-in providers this server knows, picked by OPENPURPOSE_AUTH_PROVIDER. Adding one means
 * a file next to this one and a line in `providers`.
 */
import type { AuthConfig } from '../../config.js';
import type { AuthProvider } from './provider.js';
import { createSupabaseProvider } from './supabase.js';

export type { AuthProvider, ExternalIdentity } from './provider.js';
export { SignInError } from './provider.js';

export type ProviderFactory = (config: AuthConfig) => AuthProvider;

const providers = new Map<string, ProviderFactory>([['supabase', createSupabaseProvider]]);

/** Make a provider available under `id`. Tests use this for a fake one. */
export function registerProvider(id: string, factory: ProviderFactory): void {
  providers.set(id, factory);
}

/** The configured provider, or null when only tokens sign in. Throws on an unknown name. */
export function createProvider(config: AuthConfig): AuthProvider | null {
  if (!config.provider) return null;
  const factory = providers.get(config.provider);
  if (!factory) {
    const known = [...providers.keys()];
    throw new Error(
      `OPENPURPOSE_AUTH_PROVIDER=${config.provider} is not supported` +
      (known.length ? `. Use one of: ${known.join(', ')}` : ''),
    );
  }
  return factory(config);
}
