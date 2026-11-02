import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Access } from '../auth.js';
import type { ApiSpecConfig } from '../config.js';
import type { Pool, Queryable } from '../db.js';
import { withScope } from '../db.js';
import { AppError, badRequest, notFound } from '../errors.js';
import {
  matchOperations,
  parseSpecText,
  readApi,
  renderOperation,
  renderOverview,
  renderSchemaDetail,
  SpecError,
  type Api,
} from '../domain/openapi.js';

/** An API spec without its (possibly large) document. */
export interface ApiSpecMeta {
  id: string;
  project_id: string;
  /** The label people gave it, or the spec's title. */
  name: string;
  source_url: string | null;
  filename: string | null;
  source_format: 'json' | 'yaml';
  spec_version: string;
  title: string;
  version: string;
  endpoint_count: number;
  schema_count: number;
  fetched_at: string | null;
  fetch_error: string | null;
  updated_at: string;
  updated_by_name: string | null;
}

export const API_META = `s.id, s.project_id, COALESCE(NULLIF(s.name, ''), s.title) AS name, s.source_url, s.filename, s.source_format,
  s.spec_version, s.title, s.version, s.endpoint_count, s.schema_count, s.fetched_at, s.fetch_error, s.updated_at,
  u.name AS updated_by_name`;
export const API_FROM = 'FROM api_specs s LEFT JOIN actors u ON u.id = s.updated_by';

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// ───────────────────────────── fetching and parsing ─────────────────────────────

// Loopback, private, link-local, shared, multicast and reserved ranges: a spec link must not
// reach the server's own network (or a cloud metadata service) unless
// OPENPURPOSE_API_FETCH_ALLOW says so.
// BlockList also matches IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) against the IPv4 ranges.
const PRIVATE = new net.BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  PRIVATE.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(ip, bits, 'ipv6');

const family = (ip: string) => (net.isIP(ip) === 6 ? 'ipv6' : 'ipv4');

/** Whether an IP address is on a loopback, private, link-local or reserved network. */
export function isPrivateAddress(ip: string): boolean {
  return net.isIP(ip) !== 0 && PRIVATE.check(ip, family(ip));
}

/** Host names, addresses and CIDR ranges from OPENPURPOSE_API_FETCH_ALLOW. */
function allowList(entries: string[]) {
  const names = new Set<string>();
  const nets = new net.BlockList();
  for (const e of entries) {
    const [ip, bits] = e.split('/');
    if (net.isIP(ip) && e.includes('/')) nets.addSubnet(ip, Number(bits), family(ip));
    else if (net.isIP(ip)) nets.addAddress(ip, family(ip));
    else names.add(e.replace(/\.$/, ''));
  }
  return {
    name: (host: string) => names.has(host),
    address: (ip: string) => !isPrivateAddress(ip) || nets.check(ip, family(ip)),
  };
}

class PrivateAddress extends Error {
  constructor(
    readonly host: string,
    readonly address: string,
  ) {
    super(`${host} is ${address}`);
  }
}

const refusePrivate = (e: PrivateAddress) => {
  const what = e.host === e.address ? e.host : `${e.host} points to ${e.address}, which`;
  return badRequest(
    `${what} is a private network address, so the server won't fetch it. Upload the file instead, or ask whoever runs this server to add it to OPENPURPOSE_API_FETCH_ALLOW.`,
  );
};

const MAX_REDIRECTS = 5;

/**
 * Download a spec. Only http(s), with a timeout and a size cap, and never from a private network
 * address unless it's allowed: every address is checked when the connection opens, on each
 * redirect too, so a name that resolves differently the second time can't get through.
 */
export async function downloadSpec(url: string, cfg: ApiSpecConfig): Promise<string> {
  if (!cfg.fetch)
    throw badRequest(
      'Fetching URLs is turned off on this server (OPENPURPOSE_API_FETCH=off). Upload the file instead.',
    );
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw badRequest('That is not a valid URL');
  }
  const allow = allowList(cfg.allow);
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  for (let hop = 0; ; hop++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:')
      throw badRequest('Only http and https URLs can be fetched');
    if (target.username || target.password)
      throw badRequest(
        'URLs with a user name or password are not supported. Upload the file instead.',
      );
    const res = await open(target, allow, signal, cfg.timeoutMs);
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && location) {
      res.resume();
      if (hop >= MAX_REDIRECTS)
        throw badRequest(`${target.host} redirected more than ${MAX_REDIRECTS} times`);
      try {
        target = new URL(location, target);
      } catch {
        throw badRequest(`${target.host} redirected to an invalid URL`);
      }
      continue;
    }
    return readBody(res, target, cfg);
  }
}

/** One GET, refused if the host is or resolves to a private address that isn't allowed. */
function open(
  target: URL,
  allow: ReturnType<typeof allowList>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<http.IncomingMessage> {
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const named = allow.name(host);
  if (!named && net.isIP(host) && !allow.address(host))
    return Promise.reject(refusePrivate(new PrivateAddress(host, host)));
  const lookup: net.LookupFunction = (hostname, options, done) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      const bad = named ? undefined : addresses.find((x) => !allow.address(x.address));
      if (err) done(err, '', 4);
      else if (bad) done(new PrivateAddress(host, bad.address), '', 4);
      else if (options.all) (done as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
      else done(null, addresses[0].address, addresses[0].family);
    });
  };
  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? https : http).get(
      target,
      {
        headers: {
          accept: 'application/json, application/yaml;q=0.9, text/yaml;q=0.9, */*;q=0.5',
          'user-agent': 'OpenPurpose (API spec fetch)',
        },
        lookup,
        signal,
      },
      resolve,
    );
    req.on('error', (e: Error & { code?: string }) => {
      const why = signal.aborted ? `no answer within ${timeoutMs / 1000} s` : (e.code ?? e.message);
      reject(
        e instanceof PrivateAddress
          ? refusePrivate(e)
          : badRequest(`Couldn't reach ${target.host}: ${why}`),
      );
    });
  });
}

async function readBody(
  res: http.IncomingMessage,
  target: URL,
  cfg: ApiSpecConfig,
): Promise<string> {
  const status = res.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    res.resume();
    throw badRequest(`${target.host} answered ${status} ${res.statusMessage ?? ''}`.trim());
  }
  const tooLarge = () =>
    badRequest(`The spec is larger than ${Math.round(cfg.maxBytes / 1048576)} MB`);
  if (Number(res.headers['content-length'] ?? 0) > cfg.maxBytes) {
    res.destroy();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      if (size > cfg.maxBytes) {
        res.destroy();
        throw tooLarge();
      }
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw badRequest(`Couldn't read the spec from ${target.host}: ${(e as Error).message}`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface Parsed {
  json: string;
  format: 'json' | 'yaml';
  api: Api;
  hash: string;
}

function parseSpec(text: string, cfg: ApiSpecConfig): Parsed {
  if (Buffer.byteLength(text) > cfg.maxBytes)
    throw badRequest(`The spec is larger than ${Math.round(cfg.maxBytes / 1048576)} MB`);
  try {
    const parsed = parseSpecText(text);
    const doc = parsed.doc as unknown;
    const format = parsed.format;
    const api = readApi(doc);
    const json = JSON.stringify(doc);
    return { json, format, api, hash: crypto.createHash('sha256').update(json).digest('hex') };
  } catch (e) {
    if (e instanceof SpecError) throw badRequest(e.message);
    throw e;
  }
}

const summary = (p: Parsed) => [
  p.json,
  p.format,
  p.api.specVersion,
  p.api.title,
  p.api.version,
  p.api.operations.length,
  Object.keys(p.api.schemas).length,
  p.hash,
];

// ───────────────────────────── reading ─────────────────────────────

async function projectOrg(db: Queryable, projectId: string): Promise<string> {
  if (!isUuid(projectId)) throw notFound('Project');
  const { rows } = await db.query<{ organization_id: string }>(
    'SELECT organization_id FROM projects WHERE id = $1',
    [projectId],
  );
  if (!rows[0]) throw notFound('Project');
  return rows[0].organization_id;
}

export async function listApis(
  db: Queryable,
  a: Access,
  projectId: string,
): Promise<ApiSpecMeta[]> {
  a.requireRead(await projectOrg(db, projectId));
  const { rows } = await db.query<ApiSpecMeta>(
    `SELECT ${API_META} ${API_FROM} WHERE s.project_id = $1 ORDER BY s.created_at`,
    [projectId],
  );
  return rows;
}

/** Specs of several projects at once, only those the actor can read. */
export async function apisOfProjects(
  db: Queryable,
  a: Access,
  projectIds: string[],
): Promise<(ApiSpecMeta & { organization_id: string })[]> {
  if (!projectIds.length) return [];
  const { rows } = await db.query<ApiSpecMeta & { organization_id: string }>(
    `SELECT ${API_META}, p.organization_id ${API_FROM} JOIN projects p ON p.id = s.project_id
      WHERE s.project_id = ANY($1::uuid[]) AND p.organization_id = ANY($2::uuid[]) ORDER BY s.created_at`,
    [projectIds, a.readableOrgIds()],
  );
  return rows;
}

async function metaRow(
  db: Queryable,
  id: string,
): Promise<ApiSpecMeta & { organization_id: string }> {
  if (!isUuid(id)) throw notFound('API');
  const { rows } = await db.query<ApiSpecMeta & { organization_id: string }>(
    `SELECT ${API_META}, p.organization_id ${API_FROM} JOIN projects p ON p.id = s.project_id WHERE s.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('API');
  return rows[0];
}

export async function getApiMeta(db: Queryable, a: Access, id: string): Promise<ApiSpecMeta> {
  const m = await metaRow(db, id);
  a.requireRead(m.organization_id);
  return m;
}

/** The spec, parsed, with its metadata. */
export async function loadApi(
  db: Queryable,
  a: Access,
  id: string,
): Promise<{ meta: ApiSpecMeta; api: Api; raw: unknown }> {
  const meta = await getApiMeta(db, a, id);
  const { rows } = await db.query<{ spec: unknown }>('SELECT spec FROM api_specs WHERE id = $1', [
    id,
  ]);
  return { meta, api: readApi(rows[0].spec), raw: rows[0].spec };
}

/** Pick one of a project's specs by id or name; with only one, that one. */
export async function findApi(
  db: Queryable,
  a: Access,
  projectId: string,
  which?: string,
): Promise<ApiSpecMeta> {
  const all = await listApis(db, a, projectId);
  if (!all.length)
    throw new AppError(
      'not_found',
      "This project has no API spec yet. A person can add one on the project's API tab.",
    );
  if (!which) {
    if (all.length === 1) return all[0];
    throw badRequest(
      `This project has ${all.length} APIs: ${all.map((s) => `"${s.name}"`).join(', ')}. Pass api with one of them.`,
    );
  }
  const w = which.toLowerCase();
  const hit = all.find(
    (s) =>
      s.id === which ||
      s.id.startsWith(w) ||
      s.name.toLowerCase() === w ||
      s.title.toLowerCase() === w,
  );
  if (!hit)
    throw notFound(`API "${which}" (this project has ${all.map((s) => `"${s.name}"`).join(', ')})`);
  return hit;
}

// ───────────────────────────── changing ─────────────────────────────

export interface ApiInput {
  name?: string;
  url?: string;
  filename?: string;
  /** The file's text, JSON or YAML. */
  content?: string;
}

export async function addApi(
  db: Queryable,
  a: Access,
  projectId: string,
  input: ApiInput,
  cfg: ApiSpecConfig,
): Promise<ApiSpecMeta> {
  a.requireEdit(await projectOrg(db, projectId));
  const url = input.url?.trim() || null;
  if (!url && input.content === undefined) throw badRequest('Give a URL or upload a file');
  const text = input.content ?? (url ? await downloadSpec(url, cfg) : '');
  const p = parseSpec(text, cfg);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO api_specs (project_id, name, source_url, filename, spec, source_format, spec_version, title, version,
                            endpoint_count, schema_count, content_hash, fetched_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::json, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14) RETURNING id`,
    [
      projectId,
      input.name?.trim() ?? '',
      url,
      url ? null : input.filename?.trim() || 'openapi.json',
      ...summary(p),
      url ? new Date() : null,
      a.actor.id,
    ],
  );
  return getApiMeta(db, a, rows[0].id);
}

/** Rename, change the URL, or replace the file. */
export async function updateApi(
  db: Queryable,
  a: Access,
  id: string,
  input: ApiInput,
  cfg: ApiSpecConfig,
): Promise<ApiSpecMeta> {
  const m = await metaRow(db, id);
  a.requireEdit(m.organization_id);
  if (input.name !== undefined)
    await db.query(
      'UPDATE api_specs SET name = $2, updated_at = now(), updated_by = $3 WHERE id = $1',
      [id, input.name.trim(), a.actor.id],
    );
  const url = input.url?.trim();
  if (url || input.content !== undefined) {
    const text = input.content ?? (url ? await downloadSpec(url, cfg) : '');
    const p = parseSpec(text, cfg);
    await db.query(
      `UPDATE api_specs SET spec = $2::json, source_format = $3, spec_version = $4, title = $5, version = $6,
              endpoint_count = $7, schema_count = $8, content_hash = $9, source_url = $10, filename = $11,
              fetched_at = $12, fetch_error = NULL, updated_at = now(), updated_by = $13
        WHERE id = $1`,
      [
        id,
        ...summary(p),
        input.content !== undefined ? null : url,
        input.content !== undefined ? input.filename?.trim() || 'openapi.json' : null,
        input.content !== undefined ? null : new Date(),
        a.actor.id,
      ],
    );
  }
  return getApiMeta(db, a, id);
}

/**
 * Fetch a URL spec again. A failure is recorded on the spec (and returned)
 * rather than thrown, so the last good version stays and people see why.
 */
export async function refreshApi(
  db: Queryable,
  a: Access,
  id: string,
  cfg: ApiSpecConfig,
): Promise<ApiSpecMeta> {
  const m = await metaRow(db, id);
  a.requireEdit(m.organization_id);
  if (!m.source_url)
    throw badRequest('This API was uploaded as a file. Upload a new version instead.');
  await refreshRow(db, id, m.source_url, cfg, a.actor.id);
  return getApiMeta(db, a, id);
}

async function refreshRow(
  db: Queryable,
  id: string,
  url: string,
  cfg: ApiSpecConfig,
  actorId: string | null,
): Promise<void> {
  try {
    const p = parseSpec(await downloadSpec(url, cfg), cfg);
    await db.query(
      `UPDATE api_specs SET spec = CASE WHEN content_hash = $9 THEN spec ELSE $2::json END, source_format = $3, spec_version = $4,
              title = $5, version = $6, endpoint_count = $7, schema_count = $8,
              updated_at = CASE WHEN content_hash = $9 THEN updated_at ELSE now() END,
              updated_by = CASE WHEN content_hash = $9 THEN updated_by ELSE COALESCE($10, updated_by) END,
              content_hash = $9, fetched_at = now(), fetch_error = NULL
        WHERE id = $1`,
      [id, ...summary(p), actorId],
    );
  } catch (e) {
    await db.query('UPDATE api_specs SET fetch_error = $2, fetched_at = now() WHERE id = $1', [
      id,
      (e as Error).message,
    ]);
  }
}

export async function deleteApi(db: Queryable, a: Access, id: string): Promise<void> {
  const m = await metaRow(db, id);
  a.requireEdit(m.organization_id);
  await db.query('DELETE FROM api_specs WHERE id = $1', [id]);
}

// ───────────────────────────── background refresh ─────────────────────────────

const inflight = new Set<string>();

/**
 * When agents read URL specs older than refreshMinutes, fetch them again in
 * the background so the next read is current. Never blocks the caller.
 */
export function refreshStale(
  pool: Pool,
  groupId: string,
  specs: ApiSpecMeta[],
  cfg: ApiSpecConfig,
): void {
  if (!cfg.fetch || cfg.refreshMinutes <= 0) return;
  const cutoff = Date.now() - cfg.refreshMinutes * 60_000;
  for (const s of specs) {
    const sourceUrl = s.source_url;
    if (!sourceUrl || inflight.has(s.id)) continue;
    if (s.fetched_at && new Date(s.fetched_at).getTime() > cutoff) continue;
    inflight.add(s.id);
    void withScope(pool, { groupId }, (db) => refreshRow(db, s.id, sourceUrl, cfg, null))
      // A failed refresh is stored on the row as fetch_error.
      .catch(() => undefined)
      .finally(() => inflight.delete(s.id));
  }
}

// ───────────────────────────── for agents ─────────────────────────────

export interface ApiQuery {
  /** "GET /orders/{id}", an operationId, a path, or words to search for. */
  endpoint?: string;
  /** A DTO / schema name. */
  schema?: string;
  search?: string;
  tag?: string;
}

/** What an agent (and the UI's preview) gets for one spec. */
export function renderApiText(
  meta: ApiSpecMeta,
  api: Api,
  projectRef: string,
  q: ApiQuery = {},
): string {
  const head = [`# ${api.title}${api.version ? ` ${api.version}` : ''} (${api.specVersion})`];
  const source = meta.source_url
    ? `${meta.source_url}${meta.fetched_at ? `, fetched ${new Date(meta.fetched_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`
    : `uploaded file ${meta.filename ?? ''}`.trim();
  head.push('', `Project \`${projectRef}\` · API "${meta.name}" · ${source}`);
  if (meta.fetch_error)
    head.push(
      '',
      `> The last fetch failed (${meta.fetch_error}); this is the last version that worked.`,
    );
  if (api.servers.length) head.push('', `Servers: ${api.servers.join(', ')}`);

  const schema = q.schema;
  if (schema) {
    const out = renderSchemaDetail(api, schema);
    if (out) return [...head, '', out].join('\n');
    const close = Object.keys(api.schemas)
      .filter((k) => k.toLowerCase().includes(schema.toLowerCase()))
      .slice(0, 15);
    return [
      ...head,
      '',
      `No schema named "${schema}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ''}`,
    ].join('\n');
  }
  if (q.endpoint) {
    const ops = matchOperations(api, q.endpoint);
    if (ops.length === 1) return [...head, '', renderOperation(api, ops[0])].join('\n');
    if (ops.length > 1 && ops.length <= 3)
      return [...head, '', ...ops.map((op) => renderOperation(api, op))].join('\n\n');
    if (ops.length)
      return [
        ...head,
        '',
        renderOverview(api, { search: q.endpoint }),
        '',
        'Several endpoints match; call again with one exact "METHOD /path".',
      ].join('\n');
    return [
      ...head,
      '',
      `No endpoint matches "${q.endpoint}".`,
      '',
      renderOverview(api, { max: 60 }),
    ].join('\n');
  }
  if (api.description && !q.search && !q.tag)
    head.push('', api.description.split('\n').slice(0, 6).join('\n'));
  return [
    ...head,
    '',
    renderOverview(api, { search: q.search, tag: q.tag }),
    '',
    'For parameters, request and response DTOs of one endpoint, call `get_api` again with `endpoint: "METHOD /path"`; for one DTO, with `schema: "Name"`.',
  ].join('\n');
}
