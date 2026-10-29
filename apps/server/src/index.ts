import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { bootstrap } from './service/admin.js';

async function main() {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);

  // Postgres may still be starting when the container comes up. Wait with a plain client:
  // pool connections drop privileges, which needs the role the migrations create.
  for (let attempt = 1; ; attempt++) {
    const probe = new pg.Client({ connectionString: config.databaseUrl });
    try {
      await probe.connect();
      await probe.end();
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`Waiting for Postgres (${attempt}/30)…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const applied = await migrate(config.databaseUrl, config.migrationsDir);
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

  const boot = await bootstrap(db, {
    groupName: config.groupName,
    orgName: config.orgName,
    token: config.bootstrapToken,
  });
  if (boot.createdAdmin) {
    console.log('────────────────────────────────────────────────────────────');
    console.log('Created the first admin.');
    if (boot.token) {
      console.log(`Admin token (shown once, store it safely): ${boot.token}`);
    } else {
      console.log('Sign in with the token from OPENPURPOSE_BOOTSTRAP_TOKEN.');
    }
    console.log('────────────────────────────────────────────────────────────');
  }

  const app = await buildApp(db, config);
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async () => {
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
