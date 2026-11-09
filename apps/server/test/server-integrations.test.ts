import { describe, expect, it } from 'vitest';
import { integrationFetchPolicy, loadConfig } from '../src/config.js';
import { integrationOffers } from '../src/integrations.js';

describe('server connections from configuration', () => {
  it('UC-5/S5 offers the environment connection, so the card shows it as set by the server', () => {
    const config = loadConfig({
      OPENPURPOSE_OPENVERSION_URL: 'https://versions.example.com/',
      OPENPURPOSE_OPENVERSION_PUBLIC_KEY: 'pk_live_example',
    });
    const [version, announce] = integrationOffers(config);
    expect(version.environment).toEqual({
      url: 'https://versions.example.com',
      publicKey: 'pk_live_example',
    });
    expect(version.envPrefix).toBe('OPENPURPOSE_OPENVERSION');
    expect(announce.environment).toBeNull();
  });

  it('takes the OpenVersion deploy token from the environment, and reads the image version', () => {
    const config = loadConfig({
      VERSION: ' 0.5.0 ',
      OPENPURPOSE_OPENVERSION_URL: 'https://versions.example.com',
      OPENPURPOSE_OPENVERSION_PUBLIC_KEY: 'pk_live',
      OPENPURPOSE_OPENVERSION_DEPLOY_TOKEN: 'ov_live_token',
    });
    const [version] = integrationOffers(config);
    expect(version.deployToken).toBe(true);
    expect(version.environment?.deployToken).toBe('ov_live_token');
    expect(version.environment).not.toHaveProperty('signingSecret');
    expect(config.appVersion).toBe('0.5.0');
    expect(loadConfig({}).appVersion).toBe('unknown');
  });

  it('UC-5/S5 keeps the OpenAnnounce signing secret out of the OpenVersion offer', () => {
    const config = loadConfig({
      OPENPURPOSE_OPENANNOUNCE_URL: 'https://news.example.com',
      OPENPURPOSE_OPENANNOUNCE_PUBLIC_KEY: 'pk_news',
      OPENPURPOSE_OPENANNOUNCE_SIGNING_SECRET: 'sig_news',
      OPENPURPOSE_OPENVERSION_URL: 'https://versions.example.com',
      OPENPURPOSE_OPENVERSION_PUBLIC_KEY: 'pk_live',
    });
    const [version, announce] = integrationOffers(config);
    expect(version.environment).not.toHaveProperty('signingSecret');
    expect(announce.environment).toEqual({
      url: 'https://news.example.com',
      publicKey: 'pk_news',
      signingSecret: 'sig_news',
    });
    expect(announce.signingSecret).toBe(true);
  });

  it('offers no connection until a variable sets one', () => {
    const offers = integrationOffers(loadConfig({}));
    expect(offers.every((offer) => offer.environment === null)).toBe(true);
  });

  it('reads the fetch policy and its allow list from the environment', () => {
    const config = loadConfig({
      OPENPURPOSE_FETCH: 'private',
      OPENPURPOSE_FETCH_ALLOW: ' Versions.Internal , 10.0.0.0/8 ,',
    });
    expect(integrationFetchPolicy(config)).toEqual({
      mode: 'private',
      allow: ['versions.internal', '10.0.0.0/8'],
      envPrefix: 'OPENPURPOSE',
    });
  });

  it('defaults to the public fetch policy', () => {
    expect(integrationFetchPolicy(loadConfig({})).mode).toBe('public');
  });
});
