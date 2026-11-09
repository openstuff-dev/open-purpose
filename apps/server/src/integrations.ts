import {
  type ConnectionDetails,
  type IntegrationOffer,
  openAnnounce,
  openVersion,
} from '@openstuff-dev/server';
import type { Config } from './config.js';

/**
 * The connections this server offers, with the environment's values where they're set. An
 * environment value always wins, and its card shows read-only.
 */
export function integrationOffers(config: Config): IntegrationOffer[] {
  const { openVersion: version, openAnnounce: announce } = config;
  const versionEnv: ConnectionDetails | null =
    version.url && version.publicKey
      ? {
          url: version.url,
          publicKey: version.publicKey,
          ...(version.deployToken ? { deployToken: version.deployToken } : {}),
        }
      : null;
  const announceEnv: ConnectionDetails | null =
    announce.url && announce.publicKey
      ? {
          url: announce.url,
          publicKey: announce.publicKey,
          ...(announce.signingSecret ? { signingSecret: announce.signingSecret } : {}),
        }
      : null;
  return [
    {
      kind: openVersion,
      signingSecret: false,
      deployToken: true,
      environment: versionEnv,
      envPrefix: 'OPENPURPOSE_OPENVERSION',
    },
    {
      kind: openAnnounce,
      signingSecret: true,
      environment: announceEnv,
      envPrefix: 'OPENPURPOSE_OPENANNOUNCE',
    },
  ];
}
