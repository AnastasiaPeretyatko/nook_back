#!/usr/bin/env bash
# Prints "table rows" for every table of the database, sorted, plus the number of starter moods
# (the eight that belong to nobody). Used by backup.sh and restore.sh to compare a copy with the
# original. Usage: scripts/row-counts.sh <database url>
set -euo pipefail

url="${1:?usage: row-counts.sh <database url>}"

# count(*) of every table in one query (query_to_xml runs the count for each name).
psql "$url" -X -A -t -q -v ON_ERROR_STOP=1 -F ' ' -c "
  select table_name,
         (xpath('/row/c/text()',
                query_to_xml(format('select count(*) c from %I', table_name), false, true, '')))[1]::text
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
  order by table_name" -c "
  select 'starter_moods', count(*) from note_moods where user_id is null"
