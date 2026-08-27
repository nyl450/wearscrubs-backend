// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — Nomor kwitansi partner event (Tahap A + A2)
//
//   Jalankan:  npm test        atau  node test/run-all.js partner-receipt
//
// Nomor kwitansi adalah dasar pencocokan tagihan dengan buku fisik partner.
// Kalau nomornya bisa kembar, dua order saling menimpa saat partner mencocokkan
// dan salah satunya hilang dari pembukuan mereka. Kalau nomor bisa ditempel ke
// order partner lain, tagihan jadi salah alamat.
//
// Yang dijaga di sini:
//   1. Simpan massal berhasil + nomor benar-benar tersimpan
//   2. Nomor kembar DITOLAK (kembar di dalam satu kiriman, dan kembar dengan
//      yang sudah tersimpan)
//   3. Nomor yang sama boleh dipakai di partner BERBEDA (buku terpisah)
//   4. Order partner lain / non-collab DITOLAK
//   5. Semua-atau-tidak: satu baris gagal, tidak ada yang tersimpan
//   6. Order batal tidak menahan nomornya (lembar hangus)
//   7. Butuh izin menu partner-billing
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4717;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, SECRET, { expiresIn: '1h' });
// Staff tanpa menu partner-billing — untuk menguji gate izin.
const TOKEN_STAFF = jwt.sign(
    { id: 2, username: 'staff', role: 'staff', allowed_menus: { orders: 'edit' } },
    SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + (token === undefined ? TOKEN : token) } };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, opts);
    const text = await res.text();
    let out; try { out = JSON.parse(text); } catch { out = text; }
    return { status: res.status, body: out };
}

const saveReceipts = (partnerId, entries, token) =>
    req('PUT', '/api/admin/partner-billing/receipts', { partner_id: partnerId, entries }, token);

const receiptOf = (id) => one(`SELECT receipt_no FROM orders WHERE id = ${id}`).receipt_no;

function seed() {
    none(`DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM stock_movements;
          DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;
          DELETE FROM event_partners;`);
    none(`
    INSERT INTO event_partners (id, name, is_active) VALUES
      (1, 'PT Arta Otto Indonesia', TRUE),
      (2, 'PT Partner Lain', TRUE);
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
      (1, 'ALX', 'Alex SS', 'tops', 245000, 120000, TRUE);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address,
                        total_amount, payment_status, order_status, shipping_cost,
                        shipping_courier, order_source, billing_to, partner_id, invoice_date) VALUES
      (101, 'WS-EV-001', 'Suci',  '0811', '-', 168000, 'paid', 'done',      0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-13'),
      (102, 'WS-EV-002', 'Ayu',   '0812', '-', 395500, 'paid', 'confirmed', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-14'),
      (103, 'WS-EV-003', 'Heidi', '0813', '-', 546000, 'paid', 'cancelled', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-13'),
      -- order lama: partner_id NULL, hanya punya nama di billing_to (uji jembatan transisi)
      (104, 'WS-EV-004', 'Deo',   '0814', '-', 514500, 'paid', 'done',      0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', NULL, '2026-08-15'),
      (201, 'WS-EV-101', 'Nina',  '0815', '-', 200000, 'paid', 'done',      0, 'J&T', 'collaboration_event', 'PT Partner Lain', 2, '2026-08-13'),
      (301, 'WS-WA-001', 'Biasa', '0816', '-', 245000, 'paid', 'done',      0, 'J&T', 'whatsapp', NULL, NULL, '2026-08-13');
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price) VALUES
      (501, 101, 1, 'M', 'black', 'pendek', 1, 168000),
      (502, 102, 1, 'L', 'black', 'pendek', 2, 197750),
      (503, 103, 1, 'M', 'black', 'pendek', 1, 546000),
      (504, 104, 1, 'L', 'black', 'pendek', 3, 171500),
      (505, 201, 1, 'M', 'black', 'pendek', 1, 200000),
      (506, 301, 1, 'M', 'black', 'pendek', 1, 245000);
    `);
}

async function run() {
    await boot(PORT);
    for (let i = 0; i < 6; i++) {
        try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) { /* tidak ada */ }
    }
    // pg-mem tidak mendukung indeks unik parsial berbasis ekspresi, jadi indeks
    // asli dari initDB kemungkinan tidak terbentuk di harness. Uji keunikan di
    // sini karena itu memeriksa PENOLAKAN DARI ENDPOINT (pre-check di kode), yang
    // memang jalur yang dilihat admin. Indeks DB adalah jaring kedua di produksi.
    seed();

    // 1 — simpan massal
    group('1. Simpan beberapa nomor sekaligus');
    let r = await saveReceipts(1, [
        { order_id: 101, receipt_no: 'B-121' },
        { order_id: 102, receipt_no: 'B-122' },
    ]);
    check('diterima', r.status === 200, r);
    check('nomor 101 tersimpan', receiptOf(101) === 'B-121', receiptOf(101));
    check('nomor 102 tersimpan', receiptOf(102) === 'B-122', receiptOf(102));

    // 2 — kembar di dalam satu kiriman
    seed();
    group('2. Nomor kembar dalam satu kiriman ditolak');
    r = await saveReceipts(1, [
        { order_id: 101, receipt_no: 'B-121' },
        { order_id: 102, receipt_no: 'b-121' },   // beda huruf besar/kecil, tetap sama
    ]);
    check('ditolak 400', r.status === 400, r);
    check('alasannya menyebut nomor kembar', /lebih dari sekali|kwitansi/i.test(r.body.error || ''), r.body);
    check('tidak ada yang tersimpan', receiptOf(101) === null && receiptOf(102) === null,
        [receiptOf(101), receiptOf(102)]);

    // 3 — nomor sama boleh di partner berbeda
    seed();
    group('3. Nomor sama boleh dipakai partner lain (buku terpisah)');
    r = await saveReceipts(1, [{ order_id: 101, receipt_no: 'B-121' }]);
    check('partner 1 diterima', r.status === 200, r);
    r = await saveReceipts(2, [{ order_id: 201, receipt_no: 'B-121' }]);
    check('partner 2 diterima juga', r.status === 200, r);
    check('keduanya tersimpan', receiptOf(101) === 'B-121' && receiptOf(201) === 'B-121');

    // 4 — order milik partner lain
    seed();
    group('4. Order partner lain ditolak');
    r = await saveReceipts(1, [{ order_id: 201, receipt_no: 'B-999' }]);
    check('ditolak 400', r.status === 400, r);
    check('alasannya menyebut order asing', /bukan order/i.test(r.body.error || ''), r.body);
    check('tidak tersimpan', receiptOf(201) === null);

    // 5 — order non-collab
    seed();
    group('5. Order non-Collaboration Event ditolak');
    r = await saveReceipts(1, [{ order_id: 301, receipt_no: 'B-888' }]);
    check('ditolak 400', r.status === 400, r);
    check('tidak tersimpan', receiptOf(301) === null);

    // 6 — semua-atau-tidak
    seed();
    group('6. Satu baris tidak sah -> tidak ada yang tersimpan');
    r = await saveReceipts(1, [
        { order_id: 101, receipt_no: 'B-121' },
        { order_id: 201, receipt_no: 'B-122' },   // punya partner lain
    ]);
    check('ditolak 400', r.status === 400, r);
    check('baris yang sah pun tidak ikut tersimpan', receiptOf(101) === null, receiptOf(101));

    // 7 — order lama tanpa partner_id tetap terbaca lewat billing_to
    seed();
    group('7. Order lama (partner_id NULL) tetap bisa diisi lewat nama partner');
    r = await saveReceipts(1, [{ order_id: 104, receipt_no: 'B-124' }]);
    check('diterima', r.status === 200, r);
    check('tersimpan', receiptOf(104) === 'B-124', receiptOf(104));

    // 7b — bentrok dengan nomor yang SUDAH tersimpan (termasuk order partner_id NULL)
    seed();
    group('7b. Nomor bentrok dengan yang sudah tersimpan ditolak');
    let r0 = await saveReceipts(1, [{ order_id: 101, receipt_no: 'B-121' }]);
    check('nomor pertama tersimpan', r0.status === 200, r0);
    r = await saveReceipts(1, [{ order_id: 102, receipt_no: 'B-121' }]);
    check('order kedua dengan nomor sama ditolak 409', r.status === 409, r);
    check('pesannya menyebut order pemilik nomor', /WS-EV-001/.test(r.body.error || ''), r.body);
    check('order kedua tidak ikut terisi', receiptOf(102) === null, receiptOf(102));
    check('nomor pertama tidak ikut hilang', receiptOf(101) === 'B-121');
    // Menyimpan ulang order yang SAMA dengan nomornya sendiri harus tetap boleh
    // (admin membuka layar lalu menekan Simpan tanpa mengubah apa pun).
    r = await saveReceipts(1, [{ order_id: 101, receipt_no: 'B-121' }, { order_id: 102, receipt_no: 'B-122' }]);
    check('simpan ulang nomor sendiri tetap boleh', r.status === 200, r);

    // 7c — order lama tanpa partner_id ikut terjaga (indeks unik DB tidak menjangkaunya)
    seed();
    group('7c. Order partner_id NULL ikut terjaga dari nomor kembar');
    r0 = await saveReceipts(1, [{ order_id: 104, receipt_no: 'B-130' }]);   // order partner_id NULL
    check('tersimpan', r0.status === 200, r0);
    r = await saveReceipts(1, [{ order_id: 101, receipt_no: 'B-130' }]);
    check('order lain dengan nomor sama ditolak', r.status === 409, r);
    check('tidak tersimpan', receiptOf(101) === null);

    // 8 — daftar order
    seed();
    none(`UPDATE orders SET receipt_no = 'B-121' WHERE id = 101`);
    group('8. Daftar order partner + hitungan nomor terisi');
    r = await req('GET', '/api/admin/partner-billing/receipts?partner_id=1');
    check('diterima', r.status === 200, r);
    // Penghitung hanya soal order NON-BATAL: order batal tidak butuh nomor
    // kwitansi, jadi kalau ikut dihitung "belum" menunjukkan sisa pekerjaan palsu.
    check('total = 3 order aktif (yang batal TIDAK ikut dihitung)',
        r.body.total === 3, r.body.total);
    check('batal dihitung terpisah = 1', r.body.cancelled === 1, r.body.cancelled);
    check('1 sudah punya nomor', r.body.filled === 1, r.body.filled);
    check('belum = 2 (3 aktif − 1 terisi), bukan 3', r.body.missing === 2, r.body.missing);
    check('order batal TETAP tampil di daftar (nomor tidak terlihat lompat)',
        (r.body.orders || []).some(o => o.order_code === 'WS-EV-003'), (r.body.orders || []).map(o => o.order_code));
    check('4 baris ditampilkan walau yang dihitung 3',
        (r.body.orders || []).length === 4, (r.body.orders || []).length);
    check('order partner lain tidak ikut',
        !(r.body.orders || []).some(o => o.order_code === 'WS-EV-101'));
    check('order non-collab tidak ikut',
        !(r.body.orders || []).some(o => o.order_code === 'WS-WA-001'));

    // 8b — semua order aktif terisi -> "belum" harus 0 walau ada order batal
    seed();
    none(`UPDATE orders SET receipt_no = 'B-101' WHERE id = 101`);
    none(`UPDATE orders SET receipt_no = 'B-102' WHERE id = 102`);
    none(`UPDATE orders SET receipt_no = 'B-104' WHERE id = 104`);
    group('8b. Semua order aktif terisi -> belum = 0, batal tidak bikin "belum" palsu');
    r = await req('GET', '/api/admin/partner-billing/receipts?partner_id=1');
    check('belum = 0', r.body.missing === 0, r.body.missing);
    check('total aktif = 3', r.body.total === 3, r.body.total);
    check('terisi = 3', r.body.filled === 3, r.body.filled);
    check('batal tetap terlihat = 1', r.body.cancelled === 1, r.body.cancelled);

    // 9 — filter tanggal memakai invoice_date
    group('9. Filter tanggal memakai tanggal invoice');
    r = await req('GET', '/api/admin/partner-billing/receipts?partner_id=1&from=2026-08-14&to=2026-08-14');
    check('hanya order 14 Agu', r.status === 200 && r.body.total === 1, r.body);
    check('yang terambil order Ayu',
        (r.body.orders || [])[0]?.order_code === 'WS-EV-002', r.body.orders);

    // 10 — izin
    seed();
    group('10. Butuh izin menu partner-billing');
    r = await saveReceipts(1, [{ order_id: 101, receipt_no: 'B-1' }], TOKEN_STAFF);
    check('staff tanpa menu ditolak', r.status === 403, r.status);
    r = await saveReceipts(1, [{ order_id: 101, receipt_no: 'B-1' }], null);
    check('tanpa token ditolak', r.status === 401 || r.status === 403, r.status);
    check('tidak tersimpan', receiptOf(101) === null);

    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
