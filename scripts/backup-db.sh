#!/usr/bin/env bash
# ============================================================================
#  Wearscrubs — Manual DB Backup (Supabase Postgres 17) — versi bash
#  Untuk WSL / Git Bash / Linux / cron. Versi Windows: backup-db.ps1
#
#  PAKAI:
#    export SUPABASE_DB_URL="postgresql://postgres.jbdgkadddhavvnsftkuu:<PASSWORD>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"
#    ./scripts/backup-db.sh
#  Ambil string dari Supabase -> Settings -> Database -> "Session pooler" (5432)
#  atau "Direct connection". JANGAN transaction pooler (6543).
#  Butuh pg_dump >= 17, atau Docker (auto-fallback ke image postgres:17).
# ============================================================================
set -euo pipefail

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "ERROR: set SUPABASE_DB_URL dulu (session pooler / direct connection string)." >&2
  exit 1
fi
case "$SUPABASE_DB_URL" in
  *":6543/"*) echo "WARNING: port 6543 (transaction pooler) — pg_dump bisa gagal. Pakai 5432." >&2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/backups"
mkdir -p "$DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="wearscrubs_${STAMP}.dump"
OUT="$DIR/$FILE"

if command -v pg_dump >/dev/null 2>&1; then
  echo "Backup via pg_dump lokal -> $OUT"
  pg_dump --no-owner --no-acl -Fc -f "$OUT" "$SUPABASE_DB_URL"
elif command -v docker >/dev/null 2>&1; then
  echo "pg_dump tidak ada — pakai Docker (postgres:17) -> $OUT"
  docker run --rm -v "$DIR:/backups" postgres:17 \
    pg_dump --no-owner --no-acl -Fc -f "/backups/$FILE" "$SUPABASE_DB_URL"
else
  echo "ERROR: butuh pg_dump (PostgreSQL 17) atau Docker." >&2
  exit 1
fi

[ -s "$OUT" ] || { echo "ERROR: backup gagal / file kosong: $OUT" >&2; exit 1; }
echo "OK Backup selesai: $OUT ($(du -h "$OUT" | cut -f1))"

# Simpan 14 terbaru
ls -1t "$DIR"/wearscrubs_*.dump 2>/dev/null | tail -n +15 | while read -r f; do rm -f "$f"; echo "Hapus lama: $f"; done

echo
echo "RESTORE: pg_restore --no-owner --no-acl --clean --if-exists -d \"<TARGET_DB_URL>\" \"$OUT\""
