import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { publishOwnVersion, publishVersionOnStart, type Queryable } from '@openstuff-dev/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { integrationOffers } from '../src/integrations.js';

// A stand-in OpenVersion on localhost. Localhost is internal, so the test policy allows it, as a
// self-hosted server with OPENPURPOSE_FETCH=private would.
const policy = { mode: 'private' as const, allow: [], envPrefix: 'OPENPURPOSE' };
const log = { info: () => undefined, warn: () => undefined };
const GOOD = 'ov_live_good_token';

interface Seen {
  path?: string;
  auth?: string;
  idempotency?: string;
  body: string;
}
let seen: Seen[] = [];
let answer = 201;
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      seen.push({
        path: request.url,
        auth: request.headers.authorization,
        idempotency: request.headers['idempotency-key'] as string | undefined,
        body,
      });
      response.writeHead(request.headers.authorization === `Bearer ${GOOD}` ? answer : 401, {
        'content-type': 'application/json',
      });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

beforeEach(() => {
  seen = [];
  answer = 201;
});

const options = { policy, appName: 'OpenPurpose', log };
const noRows: Queryable = { query: () => Promise.resolve({ rows: [] }) };

/** Starts OpenPurpose's publish hook with the environment's connection and waits for its call. */
async function startWith(version: string) {
  const config = loadConfig({
    VERSION: version,
    OPENPURPOSE_OPENVERSION_URL: base,
    OPENPURPOSE_OPENVERSION_PUBLIC_KEY: 'pk_purpose_12345678',
    OPENPURPOSE_OPENVERSION_DEPLOY_TOKEN: GOOD,
  });
  const app = Fastify();
  publishVersionOnStart(app, {
    db: noRows,
    vault: () => Promise.reject(new Error('no saved secrets in this test')),
    offer: integrationOffers(config)[0],
    policy,
    appName: 'OpenPurpose',
    version: config.appVersion,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  for (let i = 0; i < 50 && seen.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await app.close();
}

describe('publishing OpenPurpose’s version to OpenVersion', () => {
  it('UC-5/S3 publishes a newer image’s version on start, once per version', async () => {
    await startWith('1.4.0');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      path: '/api/v1/releases',
      auth: `Bearer ${GOOD}`,
      idempotency: 'openpurpose-1.4.0',
    });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ version: '1.4.0', notes: '' });
  });

  it('UC-5/S4 leaves the live version alone when an older image starts', async () => {
    answer = 409;
    const outcome = await publishOwnVersion({ url: base, deployToken: GOOD }, '1.3.0', options);
    expect(outcome).toBe('not-newer');
  });

  it('UC-5/S7 starts as usual when OpenVersion doesn’t answer', async () => {
    const closed = { url: 'http://127.0.0.1:1', deployToken: GOOD };
    expect(await publishOwnVersion(closed, '1.4.0', options)).toBe('failed');
  });

  it('UC-5/S8 publishes nothing from a build that doesn’t know its version', async () => {
    await startWith('');
    expect(seen).toEqual([]);
  });
});
