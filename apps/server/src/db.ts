import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

export type Pool = pg.Pool;
/** Anything that can run a query. Services receive a group-scoped client (see withScope). */
export type Db = pg.Pool | pg.PoolClient;
export type Queryable = Db;

/**
 * Superusers and BYPASSRLS roles ignore row-level security. When OpenPurpose
 * connects as one (the Docker default, or Supabase's postgres user), every
 * connection drops to the openpurpose_app role first. If it can't, the
 * connection fails, so the server refuses to start rather than mix workspaces.
 */
const DROP_PRIVILEGES = `DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on'
     AND NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RETURN;
  END IF;
  BEGIN
    EXECUTE 'SET ROLE openpurpose_app';
  EXCEPTION WHEN invalid_parameter_value OR insufficient_privilege THEN
    RAISE EXCEPTION 'The database user % skips row-level security (superuser or BYPASSRLS) and can''t switch to the openpurpose_app role, so workspaces could see each other''s data.', current_user
      USING HINT = format('Run the migrations as %I, or have an admin run: GRANT openpurpose_app TO %I', current_user, current_user);
  END;
END $$`;

const ready = new WeakSet<pg.PoolClient>();

export function createPool(databaseUrl: string): Pool {
  // Keep connections open: against a remote database (Supabase) a new one costs TCP, TLS,
  // authentication and DROP_PRIVILEGES, about ten round trips. pg's default closes them after
  // 10 seconds idle, so most requests paid that.
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 0,
    keepAlive: true,
  });
  // A dropped idle connection (database restart, pooler timeout) is removed from the pool and
  // replaced on next use; without a listener it would crash the server.
  pool.on('error', (err) => {
    console.warn(`Database connection dropped: ${err.message}`);
  });
  // Every client, however it is checked out (pool.connect or pool.query), drops privileges
  // once before its first use.
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  type Cb = (
    err: Error | undefined,
    client?: pg.PoolClient,
    done?: (release?: boolean | Error) => void,
  ) => void;
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
    p.then(
      (c) => {
        cb(undefined, c, c.release.bind(c));
      },
      (e: unknown) => {
        cb(e as Error);
      },
    );
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

/**
 * SQL that points row-level security at `scope` for the rest of the transaction. Literals
 * instead of parameters, so it can share one round trip with other statements.
 */
export function scopeSql(client: pg.ClientBase, scope: Scope): string {
  return `SELECT set_config('openpurpose.group_id', ${client.escapeLiteral(scope.groupId ?? '')}, true),
    set_config('openpurpose.bypass', ${scope.bypass ? "'on'" : "''"}, true)`;
}

/** Open a transaction in which row-level security shows exactly one group. */
export async function beginScope(pool: Pool, scope: Scope): Promise<pg.PoolClient> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN; ${scopeSql(client, scope)}`);
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

export async function withScope<T>(
  pool: Pool,
  scope: Scope,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await beginScope(pool, scope);
  let ok = false;
  try {
    const result = await fn(client);
    ok = true;
    return result;
  } finally {
    // The transaction already ended or the connection broke; the client is released anyway.
    await endScope(client, ok).catch(() => undefined);
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
        await client.query("SELECT set_config('openpurpose.bypass', 'on', true)");
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
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'openpurpose_app'");
    if (role.rowCount) {
      await client.query(`
        GRANT USAGE ON SCHEMA public TO openpurpose_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openpurpose_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openpurpose_app;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO openpurpose_app;`);
      // Supabase can turn on row-level security for every new table in public. On the tables
      // we leave without it (groups, actors, tokens, ...) that denies the app everything. Let
      // the app in there, and nobody else: Supabase's Data API roles stay locked out.
      await client.query(`DO $$
        DECLARE t text;
        BEGIN
          FOR t IN SELECT c.relname FROM pg_class c
                   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
                     AND c.relrowsecurity
                     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
          LOOP
            EXECUTE format('CREATE POLICY openpurpose_app ON %I TO openpurpose_app USING (true) WITH CHECK (true)', t);
          END LOOP;
        END $$`);
      // A non-superuser that created the role (Supabase's postgres user) may administer it
      // without being allowed to SET ROLE to it yet. If granting fails too, the pool's
      // DROP_PRIVILEGES says so when it matters.
      await client
        .query(
          `DO $$ BEGIN
            SET ROLE openpurpose_app;
            RESET ROLE;
          EXCEPTION WHEN insufficient_privilege THEN
            EXECUTE format('GRANT openpurpose_app TO %I', current_user);
          END $$`,
        )
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
  return applied;
}
