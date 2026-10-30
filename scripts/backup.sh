#!/usr/bin/env bash
# Makes a copy of the whole database in one file.
#
#   scripts/backup.sh [folder]        (default folder: ~/nook-backups)
#
# The database address is read from BACKUP_DATABASE_URL or DATABASE_URL (the environment, or the
# .env file of this project). Needs pg_dump, pg_restore and psql (the PostgreSQL client, version 16 or newer).
# Writes <folder>/nook-<date>-<time>.dump and next to it nook-<...>.dump.counts (the number of
# rows per table, for restore.sh to compare). The file holds the whole database: emails, password
# hashes, diaries. It is readable by you only; keep it away from the repository and from others.
# Nothing is ever deleted or changed in the database; the address and password are not printed.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"
die() { echo "Error: $*" >&2; exit 1; }

for tool in pg_dump pg_restore psql; do
  command -v "$tool" >/dev/null || die "$tool is not installed (install the PostgreSQL client, version 16 or newer)"
done
client="$(psql --version | grep -oE '[0-9]+' | head -1)"
[ "$client" -ge 16 ] || die "the PostgreSQL client is version $client; version 16 or newer is needed"

# BACKUP_DATABASE_URL (if set) wins: a direct address, when the automatic one below does not work.
url="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
if [ -z "$url" ] && [ -f "$repo/.env" ]; then
  url="$(grep -E '^DATABASE_URL=' "$repo/.env" | tail -1 | cut -d= -f2-)"
  url="${url%\"}"; url="${url#\"}"; url="${url%\'}"; url="${url#\'}"
fi
[ -n "$url" ] || die "DATABASE_URL is not set: put it in the .env file or export it"
# Neon: the server uses the pooled address (host name with "-pooler"). A copy is better taken over
# the direct one, which is the same name without "-pooler".
if [ -z "${BACKUP_DATABASE_URL:-}" ]; then
  direct="$(printf '%s' "$url" | sed -E 's#(://[^/?]*@[^/:?]*)-pooler#\1#')"
  if [ "$direct" != "$url" ]; then
    echo "Note: the address is a pooled one; using the direct one (the same host without -pooler)."
    url="$direct"
  fi
fi
# The server's certificate is checked against the system's trusted list (libpq needs to be told).
case "$url" in
  *sslrootcert=*) ;;
  *sslmode=verify-full*) url="$url&sslrootcert=system" ;;
esac

folder="${1:-$HOME/nook-backups}"
existed=0; [ -d "$folder" ] && existed=1
mkdir -p "$folder"
folder="$(cd "$folder" && pwd -P)"
case "$folder/" in
  "$repo/"*)
    [ "$existed" = 1 ] || rmdir "$folder" 2>/dev/null || true
    die "the folder is inside the project; a copy must not sit next to the code (it could be committed)" ;;
esac

file="$folder/nook-$(date +%Y%m%d-%H%M%S).dump"
finished=0
# A failed run leaves no half-written file that could be mistaken for a copy.
trap '[ "$finished" = 1 ] || rm -f "$file" "$file.counts"' EXIT

echo "Copying the database (this wakes it up if it sleeps, may take a minute)..."
# The file names the database's user (not the password); restore.sh restores without owners, so
# it can go into any database, by any user.
pg_dump --format=custom --file="$file" "$url" \
  || die "pg_dump failed (see the message above)"
pg_restore --list "$file" >/dev/null || die "the file was written but cannot be read back"
"$here/row-counts.sh" "$url" > "$file.counts" || die "could not count the rows"

finished=1
echo "Done: $file ($(du -h "$file" | cut -f1))"
echo "Rows per table: $file.counts"
