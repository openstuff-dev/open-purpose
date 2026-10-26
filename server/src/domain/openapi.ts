/**
 * Read OpenAPI 3.x and Swagger 2.0 documents and render them compactly for
 * agents: endpoints as one line each, DTOs as TypeScript-like interfaces.
 * Pure functions; no I/O.
 */
import { parse as parseYaml } from 'yaml';

// Specs are arbitrary JSON; we read them defensively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

export interface ApiParam {
  name: string;
  in: string;
  required: boolean;
  description: string;
  schema: Json;
}

export interface ApiOperation {
  /** "GET /orders/{id}" */
  key: string;
  method: string;
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  params: ApiParam[];
  body: { contentType: string; required: boolean; schema: Json; description: string } | null;
  responses: Array<{ status: string; description: string; contentType: string; schema: Json }>;
  security: string[];
}

export interface Api {
  kind: 'openapi' | 'swagger';
  specVersion: string;
  title: string;
  version: string;
  description: string;
  servers: string[];
  operations: ApiOperation[];
  schemas: Record<string, Json>;
  doc: Json;
}

export class SpecError extends Error {}

/** Parse JSON or YAML text into a document. */
export function parseSpecText(text: string): { doc: Json; format: 'json' | 'yaml' } {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) throw new SpecError('The file is empty');
  if (trimmed.startsWith('{')) {
    try {
      return { doc: JSON.parse(trimmed), format: 'json' };
    } catch (e) {
      throw new SpecError(`Not valid JSON: ${(e as Error).message}`);
    }
  }
  try {
    return { doc: parseYaml(trimmed, { maxAliasCount: 1000 }), format: 'yaml' };
  } catch (e) {
    throw new SpecError(`Not valid JSON or YAML: ${(e as Error).message.split('\n')[0]}`);
  }
}

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function pointer(doc: Json, ref: string): Json {
  if (!ref.startsWith('#/')) return undefined;
  let cur = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Json)[key];
  }
  return cur;
}

/** The DTO name a $ref points at, if it is a named schema. */
function schemaRefName(ref: string): string | null {
  const m = /^#\/(?:components\/schemas|definitions)\/(.+)$/.exec(ref);
  return m ? decodeURIComponent(m[1]).replace(/~1/g, '/').replace(/~0/g, '~') : null;
}

/** Follow non-schema refs (parameters, responses, request bodies). */
function deref(doc: Json, v: Json, seen = 0): Json {
  while (isObj(v) && typeof v.$ref === 'string' && seen++ < 20) {
    if (schemaRefName(v.$ref)) return v;
    const next = pointer(doc, v.$ref);
    if (next === undefined) return v;
    v = next;
  }
  return v;
}

function pickContent(content: Json): { contentType: string; schema: Json } | null {
  if (!isObj(content)) return null;
  const types = Object.keys(content);
  if (!types.length) return null;
  const type = types.find((t) => /json/i.test(t)) ?? types[0];
  return { contentType: type, schema: content[type]?.schema };
}

/** Normalize a parsed document. Throws SpecError when it isn't OpenAPI or Swagger. */
export function readApi(doc: Json): Api {
  if (!isObj(doc)) throw new SpecError('Not an OpenAPI or Swagger document');
  const isV3 = typeof doc.openapi === 'string' && doc.openapi.startsWith('3');
  const isV2 = String(doc.swagger) === '2.0';
  if (!isV3 && !isV2) {
    throw new SpecError('Not an OpenAPI 3 or Swagger 2 document (no "openapi: 3.x" or "swagger: 2.0" field)');
  }
  if (!isObj(doc.paths)) throw new SpecError('The document has no "paths"');
  const info = isObj(doc.info) ? doc.info : {};

  const servers = isV3
    ? (Array.isArray(doc.servers) ? doc.servers.map((s: Json) => str(s?.url)).filter(Boolean) : [])
    : doc.host ? (Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes : ['https']).map((s: string) => `${s}://${doc.host}${doc.basePath ?? ''}`) : doc.basePath ? [doc.basePath] : [];

  const globalSecurity: string[] = Array.isArray(doc.security) ? doc.security.flatMap((s: Json) => Object.keys(s ?? {})) : [];
  const operations: ApiOperation[] = [];
  for (const [path, rawItem] of Object.entries(doc.paths)) {
    const item = deref(doc, rawItem);
    if (!isObj(item)) continue;
    const shared: Json[] = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      // Operation parameters override path-level ones with the same name and location.
      const byKey = new Map<string, Json>();
      for (const p of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const r = deref(doc, p);
        if (isObj(r)) byKey.set(`${r.in}:${r.name}`, r);
      }
      const params: ApiParam[] = [];
      let body: ApiOperation['body'] = null;
      const form: Record<string, Json> = {};
      const formRequired: string[] = [];
      for (const p of byKey.values()) {
        if (isV2 && p.in === 'body') {
          body = { contentType: (op.consumes ?? doc.consumes ?? ['application/json'])[0], required: !!p.required, schema: p.schema, description: str(p.description) };
        } else if (isV2 && p.in === 'formData') {
          form[p.name] = { type: p.type, format: p.format, items: p.items, description: p.description, enum: p.enum };
          if (p.required) formRequired.push(p.name);
        } else {
          const schema = isV3 ? p.schema ?? pickContent(p.content)?.schema : { type: p.type, format: p.format, items: p.items, enum: p.enum, default: p.default };
          params.push({ name: str(p.name), in: str(p.in), required: !!p.required || p.in === 'path', description: str(p.description), schema });
        }
      }
      if (Object.keys(form).length) {
        body = { contentType: (op.consumes ?? doc.consumes ?? ['multipart/form-data'])[0], required: formRequired.length > 0, schema: { type: 'object', properties: form, required: formRequired }, description: '' };
      }
      if (isV3 && op.requestBody) {
        const rb = deref(doc, op.requestBody);
        const c = pickContent(rb?.content);
        if (c) body = { contentType: c.contentType, required: !!rb.required, schema: c.schema, description: str(rb.description) };
      }
      const responses: ApiOperation['responses'] = [];
      for (const [status, raw] of Object.entries(isObj(op.responses) ? op.responses : {})) {
        const r = deref(doc, raw);
        if (!isObj(r)) continue;
        if (isV3) {
          const c = pickContent(r.content);
          responses.push({ status, description: str(r.description), contentType: c?.contentType ?? '', schema: c?.schema });
        } else {
          responses.push({ status, description: str(r.description), contentType: r.schema ? (op.produces ?? doc.produces ?? ['application/json'])[0] : '', schema: r.schema });
        }
      }
      const security = Array.isArray(op.security) ? op.security.flatMap((s: Json) => Object.keys(s ?? {})) : globalSecurity;
      operations.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        operationId: str(op.operationId),
        summary: str(op.summary).trim(),
        description: str(op.description).trim(),
        tags: Array.isArray(op.tags) && op.tags.length ? op.tags.map(String) : [],
        deprecated: !!op.deprecated,
        params,
        body,
        responses,
        security,
      });
    }
  }
  const schemas: Record<string, Json> = isV3 ? (isObj(doc.components?.schemas) ? doc.components.schemas : {}) : (isObj(doc.definitions) ? doc.definitions : {});
  return {
    kind: isV3 ? 'openapi' : 'swagger',
    specVersion: isV3 ? `OpenAPI ${doc.openapi}` : 'Swagger 2.0',
    title: str(info.title) || 'Untitled API',
    version: str(info.version),
    description: str(info.description).trim(),
    servers,
    operations,
    schemas,
    doc,
  };
}

// ───────────────────────────── types as text ─────────────────────────────

interface TypeCtx {
  doc: Json;
  /** Named schemas referenced while rendering, to list afterwards. */
  refs: Set<string>;
}

const needsParens = (t: string) => /[|&]/.test(t) && !/^\{.*\}$/s.test(t);

/** A schema as a one-line TypeScript-like type. */
export function typeOf(schema: Json, ctx: TypeCtx, depth = 0): string {
  if (schema === true || schema === undefined || schema === null) return 'unknown';
  if (schema === false) return 'never';
  if (!isObj(schema)) return 'unknown';
  if (typeof schema.$ref === 'string') {
    const name = schemaRefName(schema.$ref);
    if (name) {
      ctx.refs.add(name);
      return name;
    }
    const target = pointer(ctx.doc, schema.$ref);
    return depth > 6 ? 'unknown' : typeOf(target, ctx, depth + 1);
  }
  let t: string;
  const nullable = schema.nullable === true || schema['x-nullable'] === true || (Array.isArray(schema.type) && schema.type.includes('null'));
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const parts = schema.allOf.map((s: Json) => typeOf(s, ctx, depth + 1));
    const own = schema.properties ? typeOf({ ...schema, allOf: undefined }, ctx, depth + 1) : null;
    t = [...parts, ...(own ? [own] : [])].join(' & ');
  } else if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    t = (schema.oneOf ?? schema.anyOf).map((s: Json) => typeOf(s, ctx, depth + 1)).join(' | ');
  } else if (Array.isArray(schema.enum)) {
    t = schema.enum.map((v: unknown) => JSON.stringify(v)).join(' | ');
  } else if (schema.const !== undefined) {
    t = JSON.stringify(schema.const);
  } else {
    const types: string[] = Array.isArray(schema.type) ? schema.type.filter((x: string) => x !== 'null') : schema.type ? [schema.type] : [];
    const type = types[0] ?? (schema.properties || schema.additionalProperties ? 'object' : schema.items ? 'array' : '');
    switch (type) {
      case 'array': {
        const inner = typeOf(schema.items, ctx, depth + 1);
        t = `${needsParens(inner) ? `(${inner})` : inner}[]`;
        break;
      }
      case 'object': {
        const props = isObj(schema.properties) ? Object.entries(schema.properties) : [];
        const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
        const extra = schema.additionalProperties;
        if (props.length && depth < 3) {
          const fields = props.map(([k, v]) => `${safeKey(k)}${required.has(k) ? '' : '?'}: ${typeOf(v, ctx, depth + 1)}`);
          if (extra && extra !== false) fields.push(`[key: string]: ${extra === true ? 'unknown' : typeOf(extra, ctx, depth + 1)}`);
          t = `{ ${fields.join('; ')} }`;
        } else if (props.length) {
          t = 'object';
        } else if (extra && extra !== false) {
          t = `Record<string, ${extra === true ? 'unknown' : typeOf(extra, ctx, depth + 1)}>`;
        } else {
          t = 'object';
        }
        break;
      }
      case 'string':
        t = schema.format === 'binary' ? 'binary' : schema.format ? `string<${schema.format}>` : 'string';
        break;
      case 'integer':
      case 'number':
        t = schema.format ? `${type}<${schema.format}>` : type;
        break;
      case 'boolean':
        t = 'boolean';
        break;
      case 'file':
        t = 'binary';
        break;
      default:
        t = 'unknown';
    }
    if (types.length > 1) t = [t, ...types.slice(1).map((x) => typeOf({ ...schema, type: x }, ctx, depth + 1))].join(' | ');
  }
  return nullable ? `${needsParens(t) ? `(${t})` : t} | null` : t;
}

const safeKey = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

function propNote(s: Json, doc: Json): string {
  const v = isObj(s) && typeof s.$ref === 'string' && !schemaRefName(s.$ref) ? pointer(doc, s.$ref) : s;
  if (!isObj(v)) return '';
  const bits: string[] = [];
  const d = str(v.description).trim().split('\n')[0];
  if (d) bits.push(d.length > 120 ? `${d.slice(0, 117)}…` : d);
  if (v.readOnly) bits.push('read-only');
  if (v.writeOnly) bits.push('write-only');
  if (v.deprecated) bits.push('deprecated');
  if (v.default !== undefined) bits.push(`default ${JSON.stringify(v.default)}`);
  if (v.maxLength !== undefined) bits.push(`max ${v.maxLength} chars`);
  if (v.minimum !== undefined || v.maximum !== undefined) bits.push(`${v.minimum ?? ''}..${v.maximum ?? ''}`);
  if (v.pattern) bits.push(`pattern ${v.pattern}`);
  return bits.join(' · ');
}

/** A named schema as a TypeScript-like declaration. */
export function renderSchema(api: Api, name: string, ctx: TypeCtx): string {
  const schema = api.schemas[name];
  if (!isObj(schema)) return `// ${name}: not found`;
  const lines: string[] = [];
  const desc = str(schema.description).trim();
  if (desc) lines.push(...desc.split('\n').slice(0, 4).map((l) => `// ${l}`));
  const objectLike = isObj(schema.properties) || (Array.isArray(schema.allOf) && schema.allOf.some((s: Json) => isObj(s) && (s.properties || s.$ref)));
  if (!objectLike) {
    lines.push(`type ${name} = ${typeOf(schema, ctx)};`);
    return lines.join('\n');
  }
  // allOf: named parts become "extends", inline parts are merged in.
  const ext: string[] = [];
  let props: Record<string, Json> = isObj(schema.properties) ? { ...schema.properties } : {};
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  for (const part of Array.isArray(schema.allOf) ? schema.allOf : []) {
    if (isObj(part) && typeof part.$ref === 'string' && schemaRefName(part.$ref)) {
      ext.push(typeOf(part, ctx));
    } else if (isObj(part)) {
      props = { ...props, ...(isObj(part.properties) ? part.properties : {}) };
      for (const r of Array.isArray(part.required) ? part.required : []) required.add(r);
    }
  }
  lines.push(`interface ${name}${ext.length ? ` extends ${ext.join(', ')}` : ''} {`);
  for (const [k, v] of Object.entries(props)) {
    const note = propNote(v, api.doc);
    lines.push(`  ${safeKey(k)}${required.has(k) ? '' : '?'}: ${typeOf(v, ctx, 1)};${note ? `  // ${note}` : ''}`);
  }
  if (schema.additionalProperties && schema.additionalProperties !== false) {
    lines.push(`  [key: string]: ${schema.additionalProperties === true ? 'unknown' : typeOf(schema.additionalProperties, ctx, 1)};`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** Render the named schemas plus everything they reference, up to a limit. */
function renderTypes(api: Api, start: Iterable<string>, limit = 40): string {
  const queue = [...start];
  const done = new Set<string>();
  const out: string[] = [];
  while (queue.length && done.size < limit) {
    const name = queue.shift()!;
    if (done.has(name) || !(name in api.schemas)) continue;
    done.add(name);
    const ctx: TypeCtx = { doc: api.doc, refs: new Set() };
    out.push(renderSchema(api, name, ctx));
    for (const r of ctx.refs) if (!done.has(r)) queue.push(r);
  }
  const left = queue.filter((n) => !done.has(n) && n in api.schemas);
  if (left.length) out.push(`// …and ${new Set(left).size} more: ${[...new Set(left)].slice(0, 15).join(', ')}`);
  return out.join('\n\n');
}

// ───────────────────────────── for agents ─────────────────────────────

const OK = /^2\d\d$/;

function successType(op: ApiOperation, ctx: TypeCtx): string {
  const ok = op.responses.find((r) => OK.test(r.status)) ?? op.responses.find((r) => r.status === 'default');
  if (!ok) return '';
  const t = ok.schema ? typeOf(ok.schema, ctx) : '';
  const status = ok.status === '200' ? '' : `${ok.status} `;
  return t ? `${status}${t}` : ok.status === '204' ? '204 no content' : status.trim();
}

/** One line per endpoint: "- `GET /orders/{id}` — Get an order → OrderDto". */
export function operationLine(op: ApiOperation, doc: Json): string {
  const ctx: TypeCtx = { doc, refs: new Set() };
  const body = op.body?.schema ? ` (body: ${typeOf(op.body.schema, ctx)})` : '';
  const ret = successType(op, ctx);
  const title = op.summary || op.operationId;
  return `- \`${op.key}\`${title ? ` — ${title}` : ''}${body}${ret ? ` → ${ret}` : ''}${op.deprecated ? ' _(deprecated)_' : ''}`;
}

export function matchOperations(api: Api, q: string): ApiOperation[] {
  const query = q.trim();
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec(query);
  if (m) {
    const exact = api.operations.filter((o) => o.method === m[1].toUpperCase() && o.path === m[2]);
    if (exact.length) return exact;
  }
  const byId = api.operations.filter((o) => o.operationId && o.operationId.toLowerCase() === query.toLowerCase());
  if (byId.length) return byId;
  const byPath = api.operations.filter((o) => o.path === query);
  if (byPath.length) return byPath;
  return searchOperations(api, query);
}

export function searchOperations(api: Api, q: string, tag?: string): ApiOperation[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return api.operations.filter((o) => {
    if (tag && !o.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
    const hay = `${o.key} ${o.operationId} ${o.summary} ${o.tags.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function renderOperation(api: Api, op: ApiOperation): string {
  const ctx: TypeCtx = { doc: api.doc, refs: new Set() };
  const out: string[] = [`## \`${op.key}\`${op.operationId ? `  (${op.operationId})` : ''}${op.deprecated ? ' — deprecated' : ''}`];
  if (op.summary) out.push('', op.summary);
  if (op.description && op.description !== op.summary) out.push('', op.description);
  const meta = [op.tags.length ? `Tags: ${op.tags.join(', ')}` : '', op.security.length ? `Auth: ${[...new Set(op.security)].join(', ')}` : ''].filter(Boolean);
  if (meta.length) out.push('', meta.join(' · '));
  if (op.params.length) {
    out.push('', '### Parameters');
    for (const p of op.params) {
      out.push(`- \`${p.name}\` (${p.in}${p.required ? '' : ', optional'}): ${typeOf(p.schema, ctx)}${p.description ? ` — ${p.description.split('\n')[0]}` : ''}`);
    }
  }
  if (op.body) {
    out.push('', `### Request body (${op.body.contentType}${op.body.required ? '' : ', optional'})`);
    if (op.body.description) out.push(op.body.description);
    out.push(op.body.schema ? `\`${typeOf(op.body.schema, ctx)}\`` : '_no schema_');
  }
  if (op.responses.length) {
    out.push('', '### Responses');
    for (const r of op.responses) {
      const t = r.schema ? `\`${typeOf(r.schema, ctx)}\`` : '';
      out.push(`- ${r.status}${r.description ? ` ${r.description.split('\n')[0]}` : ''}${t ? `: ${t}` : ''}`);
    }
  }
  if (ctx.refs.size) out.push('', '### Types', '', '```ts', renderTypes(api, ctx.refs), '```');
  return out.join('\n');
}

export function renderSchemaDetail(api: Api, name: string): string | null {
  const exact = name in api.schemas ? name : Object.keys(api.schemas).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!exact) return null;
  const usedBy = api.operations.filter((op) => {
    const ctx: TypeCtx = { doc: api.doc, refs: new Set() };
    if (op.body?.schema) typeOf(op.body.schema, ctx);
    for (const r of op.responses) if (r.schema) typeOf(r.schema, ctx);
    return ctx.refs.has(exact);
  });
  const out = [`## ${exact}`, '', '```ts', renderTypes(api, [exact]), '```'];
  if (usedBy.length) out.push('', 'Used directly by:', ...usedBy.slice(0, 20).map((o) => `- \`${o.key}\``));
  return out.join('\n');
}

/** Endpoints grouped by tag. Large APIs list their tags only, unless filtered. */
export function renderOverview(api: Api, opts: { search?: string; tag?: string; max?: number } = {}): string {
  const max = opts.max ?? 150;
  const filtered = opts.search || opts.tag ? searchOperations(api, opts.search ?? '', opts.tag) : api.operations;
  const out: string[] = [];
  const groups = new Map<string, ApiOperation[]>();
  for (const op of filtered) {
    const tag = op.tags[0] ?? 'Other';
    groups.set(tag, [...(groups.get(tag) ?? []), op]);
  }
  const heading = opts.search || opts.tag
    ? `## Endpoints matching ${[opts.tag ? `tag "${opts.tag}"` : '', opts.search ? `"${opts.search}"` : ''].filter(Boolean).join(' and ')} (${filtered.length} of ${api.operations.length})`
    : `## Endpoints (${api.operations.length})`;
  out.push(heading);
  if (!filtered.length) {
    out.push('', '_None._');
  } else if (filtered.length > max) {
    out.push('', `Too many to list. Filter with \`tag\` or \`search\`. Tags:`, '');
    for (const [tag, ops] of groups) out.push(`- **${tag}** (${ops.length})`);
  } else {
    for (const [tag, ops] of groups) {
      if (groups.size > 1 || tag !== 'Other') out.push('', `### ${tag}`);
      out.push(...ops.map((op) => operationLine(op, api.doc)));
    }
  }
  const names = Object.keys(api.schemas);
  if (names.length && !opts.search && !opts.tag) {
    out.push('', `## Schemas (${names.length})`, '', names.slice(0, 200).join(', ') + (names.length > 200 ? `, …and ${names.length - 200} more` : ''));
  }
  return out.join('\n');
}
