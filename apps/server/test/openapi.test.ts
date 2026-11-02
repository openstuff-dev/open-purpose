import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { downloadSpec, isPrivateAddress } from '../src/service/apis.js';
import { BILLING_SWAGGER_YAML, ORDER_API } from '../src/demo-specs.js';
import {
  matchOperations,
  parseSpecText,
  readApi,
  renderOperation,
  renderOverview,
  renderSchemaDetail,
  SpecError,
} from '../src/domain/openapi.js';

describe('OpenAPI and Swagger specs', () => {
  const order = readApi(ORDER_API);
  const billing = readApi(parseSpecText(BILLING_SWAGGER_YAML).doc);

  it('reads OpenAPI 3 and Swagger 2, JSON and YAML', () => {
    expect(order.specVersion).toBe('OpenAPI 3.0.3');
    expect(order.operations.map((o) => o.key)).toEqual([
      'GET /orders',
      'POST /orders',
      'GET /orders/{orderId}',
      'DELETE /orders/{orderId}',
      'GET /orders/{orderId}/shipments',
    ]);
    expect(billing.specVersion).toBe('Swagger 2.0');
    expect(parseSpecText(BILLING_SWAGGER_YAML).format).toBe('yaml');
    expect(billing.servers).toEqual(['https://billing.acme.internal/api']);
    expect(() => readApi({ hello: 'world' })).toThrow(SpecError);
    expect(() => parseSpecText('{ nope')).toThrow(SpecError);
  });

  it('lists endpoints one per line with their types', () => {
    const text = renderOverview(order);
    expect(text).toContain('### Orders');
    expect(text).toContain(
      '- `POST /orders` — Create an order (body: CreateOrderRequest) → 201 OrderDto',
    );
    expect(text).toContain(
      '- `GET /orders/{orderId}/shipments` — Shipments of an order → ShipmentDto[]',
    );
    expect(text).toContain(
      '- `DELETE /orders/{orderId}` — Cancel an order that is not shipped yet → 204 no content',
    );
    expect(text).toContain('## Schemas (9)');
    expect(renderOverview(order, { tag: 'Shipments' })).not.toContain('POST /orders');
  });

  it('renders one endpoint with its parameters and every DTO it uses', () => {
    const [op] = matchOperations(order, 'GET /orders');
    const text = renderOperation(order, op);
    expect(text).toContain('- `customerId` (query): string<uuid>');
    expect(text).toContain('- `status` (query, optional): OrderStatus');
    expect(text).toContain('- `page` (query, optional): integer');
    expect(text).toContain('Auth: bearer');
    expect(text).toContain('interface OrderPage extends PageInfo {');
    expect(text).toContain('  items: OrderDto[];');
    expect(text).toContain(
      'type OrderStatus = "Draft" | "Placed" | "Shipped" | "Delivered" | "Cancelled";',
    );
    expect(text).toContain('  note?: string | null;');
    expect(text).toContain('  id: string<uuid>;  // read-only');
    expect(text).toContain('// An amount in øre. Never use floats for money.');
    // Path-level parameters apply to every method on the path.
    expect(
      renderOperation(order, matchOperations(order, 'deleteOrder'.replace('delete', 'cancel'))[0]),
    ).toContain('`orderId` (path)');
  });

  it('turns Swagger 2 body parameters into a request body', () => {
    const text = renderOperation(billing, matchOperations(billing, 'createInvoice')[0]);
    expect(text).toContain('### Request body (application/json)');
    expect(text).toContain('`CreateInvoice`');
    expect(text).toContain('  paidAt?: string<date-time> | null;');
    expect(renderSchemaDetail(billing, 'invoice')).toContain(
      'Used directly by:\n- `GET /invoices/{invoiceNo}`',
    );
  });
});

const LOCAL_SPEC = 'openapi: 3.0.0\ninfo: { title: Local, version: "1" }\npaths: {}\n';

describe('fetching API specs', () => {
  let server: Server;
  let port = 0;
  const cfg = (allow: string[] = []) => ({ ...loadConfig({}).apiSpecs, allow });
  const failure = (url: string, allow?: string[]) =>
    downloadSpec(url, cfg(allow)).then(
      () => '',
      (e: unknown) => (e as Error).message,
    );

  beforeAll(async () => {
    server = createServer((req, res) => {
      const [, hops] = /^\/hop\/(\d+)/.exec(req.url ?? '') ?? [];
      if (req.url === '/to-private') {
        res.writeHead(302, { location: 'http://10.1.2.3/spec.yaml' }).end();
      } else if (hops) {
        res.writeHead(302, { location: `/hop/${Number(hops) + 1}` }).end();
      } else if (req.url === '/moved') {
        res.writeHead(301, { location: '/spec.yaml' }).end();
      } else {
        res.setHeader('content-type', 'application/yaml');
        res.end(LOCAL_SPEC);
      }
    });
    // Both IPv4 and IPv6, so "localhost" works whichever it resolves to first.
    await new Promise<void>((r) => {
      server.listen(0, () => {
        r();
      });
    });
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
  });

  it('knows which addresses are private', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.10', '169.254.169.254'])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['1.1.1.1', '140.82.112.3', '2606:4700::1111'])
      expect(isPrivateAddress(ip)).toBe(false);
  });

  it('refuses private addresses by default, by IP and by name', async () => {
    for (const url of [
      `http://127.0.0.1:${port}/spec.yaml`,
      `http://[::1]:${port}/spec.yaml`,
      `http://[::ffff:127.0.0.1]:${port}/spec.yaml`,
      'http://169.254.169.254/latest/meta-data/',
      `http://localhost:${port}/spec.yaml`,
    ])
      expect(await failure(url)).toMatch(/is a private network address.*OPENPURPOSE_API_FETCH_ALLOW/);
  });

  it('fetches from private addresses on the allow list, by address, range or name', async () => {
    expect(await downloadSpec(`http://127.0.0.1:${port}/spec.yaml`, cfg(['127.0.0.1']))).toBe(LOCAL_SPEC);
    expect(await downloadSpec(`http://127.0.0.1:${port}/moved`, cfg(['127.0.0.0/8']))).toBe(LOCAL_SPEC);
    expect(await downloadSpec(`http://localhost:${port}/spec.yaml`, cfg(['localhost']))).toBe(LOCAL_SPEC);
  });

  it('checks every redirect and stops after five', async () => {
    expect(await failure(`http://127.0.0.1:${port}/to-private`, ['127.0.0.1'])).toMatch(
      /^10\.1\.2\.3 is a private network address/,
    );
    expect(await failure(`http://127.0.0.1:${port}/hop/1`, ['127.0.0.1'])).toMatch(
      /redirected more than 5 times/,
    );
  });

  it('reads the allow list from OPENPURPOSE_API_FETCH_ALLOW', () => {
    expect(loadConfig({}).apiSpecs.allow).toEqual([]);
    expect(
      loadConfig({ OPENPURPOSE_API_FETCH_ALLOW: ' Specs.Internal, 10.0.0.0/8 ,' }).apiSpecs.allow,
    ).toEqual(['specs.internal', '10.0.0.0/8']);
  });
});
