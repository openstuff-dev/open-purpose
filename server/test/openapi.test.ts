import { describe, expect, it } from 'vitest';
import { BILLING_SWAGGER_YAML, ORDER_API } from '../src/demo-specs.js';
import { matchOperations, parseSpecText, readApi, renderOperation, renderOverview, renderSchemaDetail, SpecError } from '../src/domain/openapi.js';

describe('OpenAPI and Swagger specs', () => {
  const order = readApi(ORDER_API);
  const billing = readApi(parseSpecText(BILLING_SWAGGER_YAML).doc);

  it('reads OpenAPI 3 and Swagger 2, JSON and YAML', () => {
    expect(order.specVersion).toBe('OpenAPI 3.0.3');
    expect(order.operations.map((o) => o.key)).toEqual([
      'GET /orders', 'POST /orders', 'GET /orders/{orderId}', 'DELETE /orders/{orderId}', 'GET /orders/{orderId}/shipments',
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
    expect(text).toContain('- `POST /orders` — Create an order (body: CreateOrderRequest) → 201 OrderDto');
    expect(text).toContain('- `GET /orders/{orderId}/shipments` — Shipments of an order → ShipmentDto[]');
    expect(text).toContain('- `DELETE /orders/{orderId}` — Cancel an order that is not shipped yet → 204 no content');
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
    expect(text).toContain('type OrderStatus = "Draft" | "Placed" | "Shipped" | "Delivered" | "Cancelled";');
    expect(text).toContain('  note?: string | null;');
    expect(text).toContain('  id: string<uuid>;  // read-only');
    expect(text).toContain('// An amount in øre. Never use floats for money.');
    // Path-level parameters apply to every method on the path.
    expect(renderOperation(order, matchOperations(order, 'deleteOrder'.replace('delete', 'cancel'))[0])).toContain('`orderId` (path)');
  });

  it('turns Swagger 2 body parameters into a request body', () => {
    const text = renderOperation(billing, matchOperations(billing, 'createInvoice')[0]);
    expect(text).toContain('### Request body (application/json)');
    expect(text).toContain('`CreateInvoice`');
    expect(text).toContain('  paidAt?: string<date-time> | null;');
    expect(renderSchemaDetail(billing, 'invoice')).toContain('Used directly by:\n- `GET /invoices/{invoiceNo}`');
  });
});
