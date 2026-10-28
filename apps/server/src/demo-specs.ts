/** Example API specs for the demo data and the tests. */

export const ORDER_API = {
  openapi: '3.0.3',
  info: {
    title: 'Order Service API',
    version: '1.4.0',
    description: 'Orders and shipments. Amounts are integer øre.',
  },
  servers: [{ url: 'https://orders.acme.internal' }],
  security: [{ bearer: [] }],
  paths: {
    '/orders': {
      get: {
        tags: ['Orders'],
        operationId: 'listOrders',
        summary: 'List orders for a customer',
        parameters: [
          {
            name: 'customerId',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
          { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/OrderStatus' } },
          { $ref: '#/components/parameters/Page' },
        ],
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderPage' } } },
          },
        },
      },
      post: {
        tags: ['Orders'],
        operationId: 'createOrder',
        summary: 'Create an order',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            description: 'Retries with the same key create one order',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateOrderRequest' } },
          },
        },
        responses: {
          201: {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderDto' } } },
          },
          400: { $ref: '#/components/responses/Problem' },
        },
      },
    },
    '/orders/{orderId}': {
      parameters: [
        { name: 'orderId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      get: {
        tags: ['Orders'],
        operationId: 'getOrder',
        summary: 'Get an order',
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderDto' } } },
          },
          404: { $ref: '#/components/responses/Problem' },
        },
      },
      delete: {
        tags: ['Orders'],
        operationId: 'cancelOrder',
        summary: 'Cancel an order that is not shipped yet',
        responses: {
          204: { description: 'Cancelled' },
          409: { $ref: '#/components/responses/Problem' },
        },
      },
    },
    '/orders/{orderId}/shipments': {
      get: {
        tags: ['Shipments'],
        operationId: 'listShipments',
        summary: 'Shipments of an order',
        parameters: [
          {
            name: 'orderId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/ShipmentDto' } },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    parameters: {
      Page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
    },
    responses: {
      Problem: {
        description: 'Problem',
        content: {
          'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
        },
      },
    },
    schemas: {
      OrderStatus: {
        type: 'string',
        enum: ['Draft', 'Placed', 'Shipped', 'Delivered', 'Cancelled'],
      },
      Money: {
        type: 'object',
        description: 'An amount in øre. Never use floats for money.',
        required: ['amountOre', 'currency'],
        properties: {
          amountOre: { type: 'integer', format: 'int64' },
          currency: { type: 'string', default: 'DKK', maxLength: 3 },
        },
      },
      OrderLineDto: {
        type: 'object',
        required: ['sku', 'quantity', 'unitPrice'],
        properties: {
          sku: { type: 'string', description: 'Article number from the product catalogue' },
          quantity: { type: 'integer', minimum: 1 },
          unitPrice: { $ref: '#/components/schemas/Money' },
        },
      },
      OrderDto: {
        type: 'object',
        required: ['id', 'customerId', 'status', 'lines', 'total'],
        properties: {
          id: { type: 'string', format: 'uuid', readOnly: true },
          customerId: { type: 'string', format: 'uuid' },
          status: { $ref: '#/components/schemas/OrderStatus' },
          lines: { type: 'array', items: { $ref: '#/components/schemas/OrderLineDto' } },
          total: { $ref: '#/components/schemas/Money' },
          note: { type: 'string', nullable: true },
          placedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      CreateOrderRequest: {
        type: 'object',
        required: ['customerId', 'lines'],
        properties: {
          customerId: { type: 'string', format: 'uuid' },
          lines: {
            type: 'array',
            minItems: 1,
            items: { $ref: '#/components/schemas/OrderLineDto' },
          },
          note: { type: 'string', maxLength: 500 },
        },
      },
      OrderPage: {
        allOf: [
          { $ref: '#/components/schemas/PageInfo' },
          {
            type: 'object',
            required: ['items'],
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/OrderDto' } },
            },
          },
        ],
      },
      PageInfo: {
        type: 'object',
        required: ['page', 'total'],
        properties: { page: { type: 'integer' }, total: { type: 'integer' } },
      },
      ShipmentDto: {
        type: 'object',
        required: ['id', 'carrier'],
        properties: {
          id: { type: 'string' },
          carrier: { type: 'string', enum: ['PostNord', 'GLS', 'DAO'] },
          trackingUrl: { type: 'string', format: 'uri' },
        },
      },
      ProblemDetails: {
        type: 'object',
        description: 'RFC 9457 problem details',
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  },
};

export const BILLING_SWAGGER_YAML = `swagger: "2.0"
info:
  title: Billing API
  version: "2.1"
host: billing.acme.internal
basePath: /api
schemes: [https]
paths:
  /invoices/{invoiceNo}:
    get:
      tags: [Invoices]
      operationId: getInvoice
      summary: Get an invoice
      produces: [application/json]
      parameters:
        - name: invoiceNo
          in: path
          required: true
          type: string
      responses:
        "200":
          description: OK
          schema:
            $ref: "#/definitions/Invoice"
  /invoices:
    post:
      tags: [Invoices]
      operationId: createInvoice
      summary: Invoice an order
      parameters:
        - name: body
          in: body
          required: true
          schema:
            $ref: "#/definitions/CreateInvoice"
      responses:
        "201":
          description: Created
          schema:
            $ref: "#/definitions/Invoice"
definitions:
  CreateInvoice:
    type: object
    required: [orderId]
    properties:
      orderId:
        type: string
        format: uuid
  Invoice:
    type: object
    required: [invoiceNo, totalOre]
    properties:
      invoiceNo:
        type: string
      totalOre:
        type: integer
        format: int64
        description: Including VAT
      paidAt:
        type: string
        format: date-time
        x-nullable: true
`;
