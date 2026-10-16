-- ═══════════════════════════════════════════════════════════════════════════
-- TUGAS TERJADWAL DI DATABASE (pg_cron, Supabase)
--
-- Berkas ini ADALAH dokumentasi sekaligus sumber kebenarannya. Job pg_cron
-- hidup di dalam database, bukan di dalam kode yang ter-deploy — jadi tanpa
-- berkas ini tidak ada satu pun tempat di repo yang menunjukkan bahwa ada
-- proses otomatis yang mengubah data pesanan setiap jam.
--
-- Kalau mengubah salah satu job: ubah di sini DULU, lalu jalankan SQL-nya.
-- Memeriksa yang sedang aktif:
--     SELECT jobid, jobname, schedule, command FROM cron.job ORDER BY jobid;
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Batalkan order website yang menggantung ─────────────────────────────
-- Sudah berjalan sejak 3 Agu 2026 (lihat duplicate_order_guard). Order website
-- yang tidak dibayar lebih dari 48 jam dibatalkan otomatis supaya daftar
-- pesanan tidak penuh sampah. HANYA website: order WhatsApp/Kasir dibereskan
-- admin sendiri, dan pembelinya sering memang lambat bayar.
SELECT cron.schedule(
    'cancel-stale-unpaid-website-orders',
    '0 * * * *',
    $$
    update orders
    set order_status = 'cancelled',
        notes = trim(concat(coalesce(notes,''),
          E'\n[system auto-expire] Dibatalkan otomatis: order website belum dibayar > 48 jam.'))
    where order_status = 'waiting_payment'
      and payment_status = 'pending'
      and order_source = 'website'
      and created_at < now() - interval '48 hours'
    $$
);

-- ── 2. Selesaikan otomatis 1x24 jam setelah dikirim ────────────────────────
-- Permintaan James 16 Okt 2026: begitu resi diisi, pesanan praktis sudah
-- selesai dari sisi Wearscrubs — menunggu admin menekan "Selesai" satu per satu
-- hanya membuat daftar Proses menumpuk dan angka di layar tidak mencerminkan
-- keadaan sebenarnya.
--
-- Memakai `shipped_at`, BUKAN `updated_at`: updated_at ikut berubah setiap kali
-- apa pun di pesanan itu disentuh (edit catatan, ubah diskon), jadi pesanan bisa
-- "muda" terus dan tidak pernah selesai.
--
-- Pesanan batal tidak ikut (statusnya bukan 'shipped' lagi). Jejaknya ditulis ke
-- catatan supaya admin tahu ini perbuatan sistem, bukan kliknya sendiri.
SELECT cron.schedule(
    'auto-done-shipped-orders',
    '0 * * * *',
    $$
    update orders
    set order_status = 'done',
        updated_at = now(),
        notes = trim(concat(coalesce(notes,''),
          E'\n[system] Ditandai selesai otomatis: sudah 1x24 jam sejak resi diisi.'))
    where order_status = 'shipped'
      and shipped_at is not null
      and shipped_at < now() - interval '24 hours'
    $$
);
