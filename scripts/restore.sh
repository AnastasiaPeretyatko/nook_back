#!/usr/bin/env bash
# Restores a copy made by backup.sh into an EMPTY database.
#
#   RESTORE_DATABASE_URL='postgresql://user:password@host/dbname?sslmode=require' \
#     scripts/restore.sh <file.dump>
#
# Without RESTORE_DATABASE_URL the address is asked for (typing is hidden). It never reads .env
# and never touches the database the server uses unless you give that address yourself. It
# refuses a database that has any table in it, and deletes nothing: restoring either happens in
# full (one transaction) or not at all. Afterwards the rows per table are compared with the
# original's (the .counts file next to the copy).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "Error: $*" >&2; exit 1; }

file="${1:-}"
[ -n "$file" ] || die "usage: scripts/restore.sh <file.dump>"
[ -f "$file" ] || die "no such file: $file"
for tool in pg_restore psql; do
  command -v "$tool" >/dev/null || die "$tool is not installed (install the PostgreSQL client, version 16 or newer)"
done
client="$(psql --version | grep -oE '[0-9]+' | head -1)"
[ "$client" -ge 16 ] || die "the PostgreSQL client is version $client; version 16 or newer is needed"
pg_restore --list "$file" >/dev/null || die "this is not a readable copy"

url="${RESTORE_DATABASE_URL:-}"
if [ -z "$url" ]; then
  [ -t 0 ] || die "RESTORE_DATABASE_URL is not set"
  read -rsp "Address of the EMPTY database to restore into: " url; echo
fi
[ -n "$url" ] || die "no database address given"
case "$url" in
  *sslrootcert=*) ;;
  *sslmode=verify-full*) url="$url&sslrootcert=system" ;;
esac

tables="$(psql "$url" -X -A -t -q -v ON_ERROR_STOP=1 -c \
  "select count(*) from information_schema.tables where table_schema = 'public'")" \
  || die "cannot connect to that database"
[ "$tables" = "0" ] || die "that database is not empty ($tables tables); create a new empty one and use its address"

echo "Restoring..."
pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname="$url" "$file" \
  || die "restore failed; the database was left as it was (nothing is half-restored)"

echo "Comparing the rows per table with the original..."
restored="$("$here/row-counts.sh" "$url")"
if [ ! -f "$file.counts" ]; then
  echo "$restored"
  echo "No $file.counts next to the copy: nothing to compare with. Check the numbers above by eye."
  exit 0
fi
if diff <(cat "$file.counts") <(echo "$restored") >/dev/null; then
  echo "OK: all tables have the same number of rows as the original ($(wc -l < "$file.counts") lines compared)."
else
  echo "DIFFERENT (< original, > restored):" >&2
  diff <(cat "$file.counts") <(echo "$restored") >&2 || true
  die "the numbers differ; if the app was in use while the copy was made, a small difference is possible, otherwise do not trust this restore"
fi
