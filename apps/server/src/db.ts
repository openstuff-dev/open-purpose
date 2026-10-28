import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

export type Pool = pg.Pool;
/** Anything that can run a query. Services receive a group-scoped client (see withScope). */
export type Db = pg.Pool | pg.PoolClient;
export type Queryable = Db;

/**
 * Superusers ignore row-level security. When OpenPurpose connects as one (the
 * Docker default), every connection drops to the openpurpose_app role first.
 */
const DROP_PRIVILEGES = `DO $$ BEGIN
  IF current_setting('is_superuser') = 'on' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpurpose_app') THEN
    EXECUTE 'SET ROLE openpurpose_app';
  END IF;
END $$`;

const ready = new WeakSet<pg.PoolClient>();

export function createPool(databaseUrl: string): Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // Every client, however it is checked out (pool.connect or pool.query), drops privileges
  // once before its first use.
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  type Cb = (err: Error | undefined, client?: pg.PoolClient, done?: (release?: boolean | Error) => void) => void;
  const wrapped = (cb?: Cb) => {
    const p = connect().then(async (c) => {
      if (!ready.has(c)) {
        try {
          await c.query(DROP_PRIVILEGES);
        } catch (err) {
          c.release(err as Error);
          throw err;
        }
        ready.add(c);
      }
      return c;
    });
    if (!cb) return p;
    p.then((c) => cb(undefined, c, c.release.bind(c)), (e) => cb(e as Error));
    return undefined;
  };
  (pool as unknown as { connect: typeof wrapped }).connect = wrapped;
  return pool;
}

const isPool = (db: Db): db is pg.Pool => db instanceof pg.Pool;
let savepoints = 0;

/**
 * Run `fn` atomically. On a pool: a new transaction. On a client that is
 * already in a request transaction: a savepoint, so a failed step rolls back
 * only itself.
 */
export async function tx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!isPool(db)) {
    const sp = `sp_${++savepoints}`;
    await db.query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(db);
      await db.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    }
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface Scope {
  /** The group whose rows are visible. */
  groupId: string | null;
  /** See every group. Only for migrations, bootstrap and server-admin operations. */
  bypass?: boolean;
}

/** Open a transaction in which row-level security shows exactly one group. */
export async function beginScope(pool: Pool, scope: Scope): Promise<pg.PoolClient> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('openpurpose.group_id', $1, true), set_config('openpurpose.bypass', $2, true)`,
      [scope.groupId ?? '', scope.bypass ? 'on' : ''],
    );
    return client;
  } catch (err) {
    client.release();
    throw err;
  }
}

export async function endScope(client: pg.PoolClient, ok: boolean): Promise<void> {
  try {
    await client.query(ok ? 'COMMIT' : 'ROLLBACK');
  } finally {
    client.release();
  }
}

export async function withScope<T>(pool: Pool, scope: Scope, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await beginScope(pool, scope);
  let ok = false;
  try {
    const result = await fn(client);
    ok = true;
    return result;
  } finally {
    await endScope(client, ok).catch(() => {});
  }
}

/**
 * Apply every *.sql file in `dir` that has not been applied yet, in file-name
 * order. Uses its own connection as the database owner (migrations need DDL).
 */
export async function migrate(databaseUrl: string, dir: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        // Serialise concurrent boots of several replicas.
        await client.query('SELECT pg_advisory_xact_lock(4242)');
        await client.query(`SELECT set_config('openpurpose.bypass', 'on', true)`);
        const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
        if (!done.rowCount) {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
          applied.push(file);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    // Keep the unprivileged role's grants in step with the schema.
    const role = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'openpurpose_app'`);
    if (role.rowCount) {
      await client.query(`
        GRANT USAGE ON SCHEMA public TO openpurpose_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openpurpose_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openpurpose_app;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO openpurpose_app;`).catch(() => {});
    }
  } finally {
    await client.end();
  }
  return applied;
}
