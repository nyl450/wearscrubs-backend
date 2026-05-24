# ============================================================================
#  Wearscrubs — Manual DB Backup (Supabase Postgres 17)
# ----------------------------------------------------------------------------
#  Membuat backup terkompresi (custom format .dump) ke folder backups/.
#  Aman: TIDAK menyimpan password di file ini — dibaca dari env SUPABASE_DB_URL.
#
#  CARA PAKAI (PowerShell):
#    1) Ambil connection string dari Supabase:
#         Dashboard -> Settings -> Database -> Connection string
#         -> pilih "Session pooler" (port 5432) ATAU "Direct connection".
#         JANGAN pakai "Transaction pooler" (port 6543) — pg_dump butuh sesi penuh.
#    2) Set env (sekali per terminal), ganti <PASSWORD> dengan password DB:
#         $env:SUPABASE_DB_URL = "postgresql://postgres.jbdgkadddhavvnsftkuu:<PASSWORD>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"
#    3) Jalankan:
#         ./scripts/backup-db.ps1
#
#  BUTUH: pg_dump versi >= 17 (install "PostgreSQL 17" / command-line tools),
#         ATAU Docker (script auto-pakai image postgres:17 kalau pg_dump tak ada).
# ============================================================================
$ErrorActionPreference = "Stop"

$url = $env:SUPABASE_DB_URL
if ([string]::IsNullOrWhiteSpace($url)) {
    Write-Error "Set dulu: `$env:SUPABASE_DB_URL = '<session pooler / direct connection string>'"
    exit 1
}
if ($url -match ":6543/") {
    Write-Warning "URL pakai port 6543 (transaction pooler) — pg_dump bisa gagal. Pakai Session pooler / Direct (port 5432)."
}

# backups/ di root repo (satu level di atas scripts/)
$root  = Split-Path -Parent $PSScriptRoot
$dir   = Join-Path $root "backups"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$file  = "wearscrubs_$stamp.dump"
$out   = Join-Path $dir $file

$pgdump = Get-Command pg_dump -ErrorAction SilentlyContinue
if ($pgdump) {
    Write-Host "Backup via pg_dump lokal -> $out"
    & $pgdump.Source --no-owner --no-acl -Fc -f $out $url
} elseif (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host "pg_dump tidak ada di PATH — pakai Docker (postgres:17) -> $out"
    docker run --rm -v "${dir}:/backups" postgres:17 pg_dump --no-owner --no-acl -Fc -f "/backups/$file" $url
} else {
    Write-Error "Butuh pg_dump (install PostgreSQL 17) ATAU Docker. Tidak ada keduanya."
    exit 1
}

if (-not (Test-Path $out) -or (Get-Item $out).Length -eq 0) {
    Write-Error "Backup gagal / file kosong: $out"
    exit 1
}
$sizeMB = [math]::Round((Get-Item $out).Length / 1MB, 2)
Write-Host "OK Backup selesai: $out ($sizeMB MB)" -ForegroundColor Green

# Simpan 14 backup terbaru, sisanya dihapus
Get-ChildItem $dir -Filter "wearscrubs_*.dump" | Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 14 | ForEach-Object { Remove-Item $_.FullName -Force; Write-Host "Hapus backup lama: $($_.Name)" }

Write-Host ""
Write-Host "RESTORE (kalau perlu, ke DB tujuan):" -ForegroundColor Cyan
Write-Host "  pg_restore --no-owner --no-acl --clean --if-exists -d `"<TARGET_DB_URL>`" `"$out`""
