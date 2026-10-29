import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, withScope, type Pool } from '../src/db.js';
import { bootstrap, provisionWorkspace } from '../src/service/admin.js';

// Like Supabase: the app connects as a role that isn't a superuser but has BYPASSRLS.
const ADMIN_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://openpurpose:openpurpose@localhost:5432/openpurpose_test';
const ROLE = 'openpurpose_bypass';
const DATABASE = 'openpurpose_bypass_test';

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(ADMIN_URL);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}
const DATABASE_URL = urlFor(ROLE, 'bypass', DATABASE);

async function asAdmin(sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

let pool: Pool | undefined;

beforeAll(async () => {
  await asAdmin(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await asAdmin(`DROP ROLE IF EXISTS ${ROLE}`);
  await asAdmin(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpurpose_app') THEN
      CREATE ROLE openpurpose_app NOLOGIN;
    END IF;
  END $$`);
  await asAdmin(`CREATE ROLE ${ROLE} LOGIN PASSWORD 'bypass' NOSUPERUSER BYPASSRLS CREATEROLE`);
  await asAdmin(`CREATE DATABASE ${DATABASE} OWNER ${ROLE}`);
});

afterAll(async () => {
  await pool?.end();
  await asAdmin(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await asAdmin(`DROP OWNED BY ${ROLE}`).catch(() => undefined);
  await asAdmin(`DROP ROLE IF EXISTS ${ROLE}`);
});

describe('a database user with BYPASSRLS', () => {
  it('refuses to connect while it can\'t switch to openpurpose_app', async () => {
    const early = createPool(DATABASE_URL);
    try {
      await expect(early.query('SELECT 1')).rejects.toThrow(
        /skips row-level security .* can't switch to the openpurpose_app role/,
      );
    } finally {
      await early.end();
    }
  });

  it('switches to openpurpose_app after the migrations, and workspaces stay apart', async () => {
    // What Postgres 16 gives a non-superuser that creates a role: admin rights, but no SET ROLE.
    await asAdmin(`GRANT openpurpose_app TO ${ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
    await migrate(DATABASE_URL, loadConfig({}).migrationsDir);
    pool = createPool(DATABASE_URL);

    const who = await pool.query<{ role: string; bypass: boolean }>(
      'SELECT current_user AS role, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user',
    );
    expect(who.rows[0]).toEqual({ role: 'openpurpose_app', bypass: false });

    await bootstrap(pool, { groupName: 'Acme Group', orgName: 'Acme Logistics' });
    const other = await provisionWorkspace(
      pool,
      async (c) =>
        (
          await c.query<{ id: string }>(
            'INSERT INTO actors (name, kind) VALUES (\'Olga\', \'human\') RETURNING id',
          )
        ).rows[0].id,
      { name: 'Other Corp', organization_name: 'Other', created_by: null },
    );

    const orgs = (groupId: string | null) =>
      withScope(pool!, { groupId }, async (c) =>
        (await c.query<{ name: string }>('SELECT name FROM organizations ORDER BY name')).rows.map(
          (r) => r.name,
        ),
      );
    expect(await orgs(other.group.id)).toEqual(['Other']);
    expect(await orgs(null)).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS n FROM organizations')).rows[0].n).toBe(0);
  });
});
