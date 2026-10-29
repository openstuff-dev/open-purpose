#!/bin/sh
# Backs up OpenPurpose: a pg_dump of its tables, plus the built-in export (.zip) of every
# workspace. Keeps BACKUP_KEEP_DAYS days in /backups and, when R2_BUCKET is set, in R2 too.
#
#   backup daily   one backup a day at BACKUP_HOUR (the default)
#   backup now     one backup, then exit (run it before every update)
set -eu
umask 077

DIR=/backups
KEEP=${BACKUP_KEEP_DAYS:-14}

log() { echo "$(date '+%F %T') $*"; }

# Tells an uptime monitor (Healthchecks.io, Better Stack heartbeats) how the backup went.
ping() {
  [ -n "${BACKUP_PING_URL:-}" ] || return 0
  wget -qO /dev/null -T 10 "$BACKUP_PING_URL$1" || log "Couldn't reach BACKUP_PING_URL"
}

run() {
  stamp=$(date +%Y-%m-%dT%H%M)
  out="$DIR/$stamp"
  rm -rf "$DIR"/*.partial
  mkdir -p "$out.partial"
  log "Backing up to $out"

  pg_dump --dbname="$DATABASE_URL" --schema=public --format=custom --file="$out.partial/database.dump"
  for slug in $(psql "$DATABASE_URL" -XAtc 'SELECT slug FROM groups ORDER BY slug'); do
    node /app/apps/server/dist/export-cli.js --group "$slug" --people --zip \
      --out "$out.partial/workspace-$slug.zip"
  done
  mv "$out.partial" "$out"

  find "$DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$((KEEP - 1))" -exec rm -rf {} +
  if [ -n "${R2_BUCKET:-}" ]; then
    rclone copy "$out" "r2:$R2_BUCKET/$stamp"
    rclone delete --min-age "${KEEP}d" "r2:$R2_BUCKET"
    log "Copied to R2 bucket $R2_BUCKET"
  fi
  log "Backup done: $(du -sh "$out" | cut -f1)"
}

case "${1:-daily}" in
  run) run ;;
  now)
    # A separate process, so set -e still stops at the first failing step.
    if "$0" run; then ping ""; else log "Backup failed"; ping /fail; exit 1; fi
    ;;
  daily)
    log "Backing up every day at $BACKUP_HOUR:00 ($(date +%Z)), keeping $KEEP days"
    last=""
    while :; do
      hour=$(date +%H)
      if [ "${hour#0}" -eq "$BACKUP_HOUR" ] && [ "$last" != "$(date +%F)" ]; then
        last=$(date +%F)
        "$0" now || true
      fi
      sleep 300
    done
    ;;
  *) echo "Usage: backup [daily|now]" >&2; exit 2 ;;
esac
