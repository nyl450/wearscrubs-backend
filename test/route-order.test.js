// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — urutan pendaftaran rute (rute berkata-tetap vs rute ber-:id)
//
//   Jalankan:  npm test     (atau: node test/run-all.js route-order)
//
// Express mencocokkan rute SESUAI URUTAN PENDAFTARAN. Kalau `/api/x/:id`
// didaftarkan lebih dulu, permintaan ke `/api/x/stats` akan tertangkap olehnya
// sebagai id = "stats", diteruskan ke Postgres, dan meledak jadi
// `invalid input syntax for type integer: "stats"`.
//
// Bug nyata 29 Agustus 2026: `/api/refunds/stats` terdaftar SESUDAH
// `/api/refunds/:id`. Akibatnya endpoint itu tidak pernah jalan sama sekali —
// badge refund di sidebar & header tidak pernah muncul, dan karena dashboard
// memanggilnya tiap 60 detik, log Postgres terus-menerus penuh error. Tidak ada
// yang sadar karena pemanggilnya diam-diam jatuh ke nilai nol.
//
// Tes ini murah dan menangkap SELURUH kelas bug itu: tiap rute berkata-tetap
// yang bersaing dengan rute ber-:id dipanggil sekali, dan yang dituntut cuma
// satu hal — jangan 500.
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, check, group, finish } = require('./_bootstrap');

const PORT = 4720;
const BASE = `http://localhost:${PORT}`;
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, 'harness_secret', { expiresIn: '1h' });

// `connection: close` disengaja: tanpa itu undici menyimpan soket keep-alive,
// dan process.exit() di finish() menutupnya di tengah jalan -> di Windows node
// jatuh dengan "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" dan
// keluar dengan kode 127, padahal semua pemeriksaan lolos. Berkas ini memanggil
// banyak endpoint berturut-turut sehingga paling sering kena.
async function get(path) {
    const res = await fetch(BASE + path, {
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'connection': 'close' },
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
}

// Rute berkata-tetap yang segmen pertamanya sama dengan rute ber-:id di modul
// yang sama, DAN yang SQL-nya bisa dijalankan pg-mem.
//
// Sengaja TIDAK dimasukkan: /api/orders/stats, /api/inventory/reservations, dan
// /api/products/popular. Ketiganya routingnya benar (sudah diperiksa manual:
// pesan galat pg-mem menyebut query milik handler yang tepat), tapi SQL-nya
// memakai fitur yang tidak didukung pg-mem — FILTER, json_build_object, alias
// di subquery berkorelasi. Memasukkannya berarti tes ini merah terus karena
// alasan yang tidak ada hubungannya, dan tes yang selalu merah akan diabaikan.
const RUTE = [
    '/api/refunds/stats',    // bersaing dengan /api/refunds/:id  <- bug 29 Agu
    '/api/exchanges/stats',  // bersaing dengan /api/exchanges/:id/...
    '/api/inventory/all',    // bersaing dengan /api/inventory/:product_id
    '/api/inventory/movements',  // bersaing dengan /api/inventory/:product_id
];

async function run() {
    await boot(PORT);

    group('1. Rute berkata-tetap tidak boleh tertangkap rute ber-:id');
    for (const path of RUTE) {
        const r = await get(path);
        check(`${path} tidak 500`, r.status !== 500, r);
        check(`${path} balas 200`, r.status === 200, r);
    }

    group('2. /api/refunds/stats mengembalikan penghitungnya, bukan satu baris refund');
    const r = await get('/api/refunds/stats');
    check('punya kolom pending', r.body && typeof r.body.pending !== 'undefined', r.body);
    check('punya kolom transferred', r.body && typeof r.body.transferred !== 'undefined', r.body);
    check('BUKAN objek refund (tidak punya order_id)',
        !(r.body && Object.prototype.hasOwnProperty.call(r.body, 'order_id')), r.body);

    group('3. Id non-angka dijawab 404 yang jelas, bukan 500 dari database');
    const bogus = await get('/api/refunds/bukan-angka');
    check('balas 404', bogus.status === 404, bogus);
    check('bukan 500', bogus.status !== 500, bogus);

    // Beri jeda singkat sebelum finish(): finish() memanggil process.exit(), dan
    // kalau masih ada soket/handle yang sedang ditutup, node di Windows jatuh
    // dengan "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" lalu keluar
    // dengan kode 127 — berkasnya dilaporkan GAGAL padahal semua lolos.
    await new Promise(r => setTimeout(r, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
