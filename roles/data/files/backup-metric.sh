#!/bin/sh
# Records the time of the last successful pgBackRest backup of type $1 (full or diff) for the node-exporter
# textfile collector (alert DataBackupStale). Run by pgbackrest-backup@.service only after a successful backup.
set -eu
dir=/var/lib/prometheus/node-exporter
f="$dir/pgbackrest_$1.prom"
printf 'openvibe_pgbackrest_last_success_timestamp_seconds{type="%s"} %s\n' "$1" "$(date +%s)" > "$f.tmp"
chmod 644 "$f.tmp" && mv "$f.tmp" "$f"
