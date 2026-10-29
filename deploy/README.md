# Running purpose.openstuff.app at home

The hosted OpenPurpose runs on a home server in Docker, with Supabase as its database and
a Cloudflare Tunnel in front. Nothing at home holds state except the backups, so if the
server dies, the same `.env` starts the stack on any other machine.

| Service | What it does |
|---|---|
| `openpurpose` | The app (`ghcr.io/openstuff-dev/open-purpose:<OPENPURPOSE_IMAGE_TAG>`). No ports are published. |
| `cloudflared` | Connects out to Cloudflare, which sends `purpose.openstuff.app` to `http://openpurpose:8080`. No port forwarding, and the home address stays hidden. |
| `backup` | Once a day: a `pg_dump` of the database plus the built-in export (`.zip`) of every workspace, kept 14 days in `./backups` and optionally in Cloudflare R2. |

## Before you start

`./setup-wizard.sh` walks you through all of this and the next section, step by step, and
fills in `.env` as you go. Run it on the server as your normal user; re-running it keeps the
values you already entered. To do it by hand, you need:

- Docker Engine with the compose plugin, run as a normal user in the `docker` group.
- A Supabase project for production (database and sign-in), in a region near the server.
  Set up sign-in as the main README says under
  [Sign-up and sign-in](../README.md#sign-up-and-sign-in), with the redirect URL
  `https://purpose.openstuff.app/api/auth/callback`.
- A Cloudflare Tunnel (Zero Trust › Networks › Tunnels › Create a tunnel › Cloudflared).
  Copy its token, then add the public hostname `purpose.openstuff.app` with the service
  `http://openpurpose:8080`.

## Start it

Copy this folder to the server (for example `~/openpurpose`), then:

```bash
cp .env.example .env
chmod 600 .env
# Fill in .env. Generate the bootstrap token with: openssl rand -hex 32
docker compose up -d
docker compose ps                 # all three Up, openpurpose (healthy)
docker compose logs -f openpurpose
```

`.env` sets `COMPOSE_FILE`, so plain `docker compose` uses `docker-compose.home.yml`.
Put a copy of `.env` in the password manager.

Then:

1. Open https://purpose.openstuff.app and sign in with the bootstrap token.
2. Under **Settings › People and agents**, create a token for yourself, clear
   `OPENPURPOSE_BOOTSTRAP_TOKEN` in `.env` and run `docker compose up -d`.
3. Check that rate limits see each visitor's own address, not the tunnel's: open the site
   from your phone on mobile data, then run
   `docker compose logs openpurpose | grep remoteAddress | tail`. You should see your
   phone's public address, not `172.30.47.2`.

## Backups

Each backup is one folder in `./backups`, e.g. `2026-11-03T0300/`:

- `database.dump`: every table, for restoring the whole server.
- `workspace-<slug>.zip`: one per workspace, the same file as **Settings › Export and import**,
  for restoring or moving a single workspace.

They run at `BACKUP_HOUR` (3 by default, in `TZ`). To run one now, for example before an
update:

```bash
docker compose exec backup backup now
docker compose logs backup
```

Set `BACKUP_PING_URL` to a heartbeat (Healthchecks.io or Better Stack) to get an email when a
backup fails or doesn't run. To keep a copy away from home too, create a private R2 bucket
and an "Object Read & Write" API token for it, and fill in the `R2_*` lines. The backup
deletes copies older than `BACKUP_KEEP_DAYS` there as well.

### Restore the database

Into a new, empty Supabase project (or any Postgres). The app must not be running against
that database yet, or it creates empty tables first.

```bash
NEW=postgres://...                 # the new project's session pooler string
DUMP=/backups/2026-11-03T0300/database.dump
docker compose run --rm --entrypoint sh backup -c "
  psql '$NEW' -Xc 'CREATE ROLE openpurpose_app NOLOGIN' &&
  pg_restore -l $DUMP | grep -v ' SCHEMA - public ' > /tmp/list &&
  pg_restore --dbname='$NEW' --no-owner --no-acl --exit-on-error -L /tmp/list $DUMP"
```

The list skips `CREATE SCHEMA public`, which every new database already has. The app sets its
own grants when it starts. Then point `DATABASE_URL` at the new database and run
`docker compose up -d`.

To restore one workspace, import its `.zip` under **Settings › Export and import**.

## Update and roll back

```bash
docker compose exec backup backup now     # migrations only move forward
# set OPENPURPOSE_IMAGE_TAG in .env to the new version (see ../CHANGELOG.md)
docker compose up -d
docker compose ps                          # wait for openpurpose (healthy)
```

To roll back, set the previous `OPENPURPOSE_IMAGE_TAG` and run `docker compose up -d`. If the
new version ran a migration the old one doesn't know, restore the backup from before the
update first.

## Move to another machine

Install Docker, copy this folder and the saved `.env`, and run
`docker compose up -d`. Stop the old stack first if it's still running: two `cloudflared`
connectors for one tunnel both get traffic.
