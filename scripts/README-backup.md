# Backup Manual Database (Supabase) — Panduan Singkat

Backup = "fotokopi" seluruh database (produk, order, stok, dll) ke 1 file di folder `backups/`.
Kalau suatu saat data rusak/kehapus, file ini bisa dikembalikan (restore).

> Catatan: ini jaring pengaman **sementara** selama masih Supabase **Free** (Free tidak punya
> backup otomatis). Saat go-live serius, lebih baik naik **Supabase Pro** (backup harian otomatis).

## Sekali setup
1. **Install salah satu:**
   - **PostgreSQL 17** (Windows installer) — supaya ada perintah `pg_dump`, **atau**
   - **Docker Desktop** — script otomatis pakai image `postgres:17` kalau `pg_dump` tak ada.
2. **Ambil connection string** di Supabase:
   `Dashboard -> Settings -> Database -> Connection string -> pilih "Session pooler" (port 5432)`.
   (Jangan "Transaction pooler"/6543 — pg_dump butuh sesi penuh.)

## Tiap kali mau backup (Windows / PowerShell)
```powershell
$env:SUPABASE_DB_URL = "postgresql://postgres.jbdgkadddhavvnsftkuu:<PASSWORD>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"
./scripts/backup-db.ps1
```
Hasil: `backups/wearscrubs_<tanggal_jam>.dump`. Script otomatis simpan 14 backup terbaru.

(WSL / Git Bash: pakai `./scripts/backup-db.sh` dengan `export SUPABASE_DB_URL=...`)

## Restore (kalau benar-benar perlu)
```
pg_restore --no-owner --no-acl --clean --if-exists -d "<TARGET_DB_URL>" "backups/wearscrubs_<...>.dump"
```
⚠️ `--clean` menimpa data di DB tujuan. Hati-hati — biasanya restore ke DB kosong/baru dulu.

## Penting
- File `.dump` & folder `backups/` **tidak ikut git** (sudah di `.gitignore`) — berisi data customer.
- Password **tidak** ditaruh di script — hanya via env `SUPABASE_DB_URL`.
- Simpan beberapa `.dump` di tempat aman lain (mis. Google Drive) — jangan cuma di 1 laptop.
- Idealnya jalankan rutin (mis. tiap hari/3 hari). Bisa dijadwalkan via Task Scheduler (Windows).
