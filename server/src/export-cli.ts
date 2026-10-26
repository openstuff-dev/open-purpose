/**
 * Export a group or one of its organizations to a JSON file, e.g. as a nightly backup.
 * The file is the same as the one Settings › Export and import downloads.
 *
 *   node dist/export-cli.js --group acme-group --out backup.json
 *   node dist/export-cli.js --group acme-group --organization payments --people --no-history > payments.json
 *
 * Options: --organization <slug>, --out <file>, --zip (Markdown files plus manifest.json, needs --out),
 * --people, --no-history, --no-proposals, --no-api-specs.
 * With npm, pass -s so npm's own output stays out of the file: npm run -s export -w server -- --group acme-group
 */
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolveAccess, type Actor } from './auth.js';
import { VERSION } from './app.js';
import { loadConfig } from './config.js';
import { createPool, withScope } from './db.js';
import { DEFAULT_INCLUDES, exportContent } from './service/transfer/export.js';
import { exportZip } from './service/transfer/markdown.js';

const { values: args } = parseArgs({
  options: {
    group: { type: 'string' },
    organization: { type: 'string' },
    out: { type: 'string' },
    zip: { type: 'boolean', default: false },
    people: { type: 'boolean', default: DEFAULT_INCLUDES.people },
    'no-history': { type: 'boolean', default: false },
    'no-proposals': { type: 'boolean', default: false },
    'no-api-specs': { type: 'boolean', default: false },
  },
});

const config = loadConfig();
const pool = createPool(config.databaseUrl);

async function main() {
  if (!args.group) throw new Error('--group <slug> is required');
  if (args.zip && !args.out) throw new Error('--zip needs --out <file>');
  const { rows } = await pool.query<Actor>(
    `SELECT id, name, kind, is_superadmin FROM actors WHERE is_superadmin AND disabled_at IS NULL ORDER BY created_at LIMIT 1`);
  if (!rows[0]) throw new Error('No server admin found to export as.');
  const access = await resolveAccess(pool, rows[0], args.group, args.organization);
  const orgId = args.organization ? access.orgBySlug(args.organization)?.id : null;
  if (orgId === undefined) throw new Error(`No organization "${args.organization}" in ${access.group.name}.`);
  const file = await withScope(pool, { groupId: access.group.id }, (db) => exportContent(db, access, orgId, {
    history: !args['no-history'], proposals: !args['no-proposals'], people: args.people, api_specs: !args['no-api-specs'],
  }, VERSION));
  const text = JSON.stringify(file, null, 2);
  if (args.out) {
    await fs.writeFile(args.out, args.zip ? exportZip(file) : text);
    process.stderr.write(`Exported ${file.organizations.length} organizations to ${args.out}\n`);
  } else {
    process.stdout.write(text + '\n');
  }
}

main()
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
