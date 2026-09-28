// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — PUT /api/orders/:id/discount (Edit Diskon dari detail pesanan)
//
//   Jalankan:  npm test     (atau: node test/run-all.js edit-order-discount)
//
// Latar (James, 28 Sep 2026): admin baru beberapa kali salah input — lupa diskon
// manual, lupa mencentang Consignment. Dulu satu-satunya jalan adalah membatalkan
// order lalu membuat ulang, yang ikut menghapus riwayat, nomor kwitansi, dan
// bukti bayarnya. Endpoint ini menulis ULANG susunan potongan sebuah order.
//
// Ini endpoint yang MENGUBAH ANGKA UANG order yang sudah jadi, jadi yang dijaga
// bukan "jalan atau tidak" tapi:
//
//  1. **Berantai, bukan dijumlah.** 10% lalu 30% = 10% dari kotor, lalu 30% dari
//     SISANYA — bukan 40%. Rumusnya harus sama persis dengan Kasir dan penyusun
//     tagihan; kalau melenceng, partner kurang/lebih tagih tanpa ada yang sadar.
//  2. **Ongkir tidak pernah ikut didiskon.** Total dihitung dari SELISIH potongan,
//     supaya ongkir, DP, dan koreksi manual di order itu tidak ikut tergerus.
//  3. **Bonus & barang uji-coba yang dikembalikan bukan dasar potongan** — sama
//     dengan aturan penyusun tagihan.
//  4. **Order yang sudah masuk tagihan partner aktif ditolak.** Tagihan adalah
//     snapshot terkunci; kalau ordernya bergeser sesudahnya, angka yang sudah
//     dikirim ke partner dan angka di sistem diam-diam berbeda.
//  5. **Setiap perubahan tercatat** di jejak audit order (order_photos step 'edit').
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4732;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, SECRET, { expiresIn: '1h' });
// Staf yang hanya boleh MELIHAT pesanan — tidak boleh mengubah angka uang.
const LIHAT = jwt.sign({ id: 9, username: 'sindy', role: 'staff', allowed_menus: { orders: 'view' } },
    SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + (token === undefined ? TOKEN : token), 'connection': 'close' } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const text = await res.text();
    let out; try { out = JSON.parse(text); } catch { out = text; }
    return { status: res.status, body: out };
}

const setDisc = (orderId, stages, incBordir, token) =>
    req('PUT', `/api/orders/${orderId}/discount`, { stages, inc_bordir: incBordir !== false }, token);
const ord = (id) => one(`SELECT discount_amount, discount_label, discount_percent, total_amount FROM orders WHERE id = ${id}`);
const jejak = (id) => many(`SELECT note FROM order_photos WHERE order_id = ${id} AND step = 'edit'`);

// 920 Nadia  — kotor 300.000, ONGKIR 25.000, lupa potongan     (kasus utama James)
// 921 Sandra — kotor 220.000, tanpa ongkir                      (uji berantai & nominal)
// 922 Suci   — kotor 240.000 termasuk bordir 40.000             (uji inc/exc bordir)
// 923 Rani   — kotor 200.000 + 1 item BONUS + 1 item trial balik (uji dasar potongan)
// 924 Heidi  — order DIBATALKAN
// 925 Tia    — sudah masuk tagihan partner yang aktif
function seed() {
    none(`DELETE FROM partner_invoice_orders; DELETE FROM partner_invoices;
          DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM stock_movements;
          DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;
          DELETE FROM event_partners;`);
    none(`
    INSERT INTO event_partners (id, name, is_active) VALUES (1, 'PT Arta Otto Indonesia', TRUE);
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
      (1, 'CLK', 'Clicker Tooth Smile', 'aksesoris', 50000, 20000, TRUE),
      (2, 'MIN', 'Minna', 'tops', 290000, 130000, TRUE);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source,
                        billing_to, partner_id, invoice_date, discount_amount, discount_label, receipt_no) VALUES
      (920, 'WS-EV-920', 'Nadia',  '0811', '-', 325000, 'paid',    'done', 25000, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', 0, NULL, '00401'),
      (921, 'WS-EV-921', 'Sandra', '0812', '-', 220000, 'pending', 'waiting_payment', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', 0, NULL, '00402'),
      (922, 'WS-EV-922', 'Suci',   '0813', '-', 240000, 'paid',    'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', 0, NULL, '00403'),
      (923, 'WS-EV-923', 'Rani',   '0814', '-', 200000, 'paid',    'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', 0, NULL, '00404'),
      (924, 'WS-EV-924', 'Heidi',  '0815', '-', 300000, 'paid',    'cancelled', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', 0, NULL, '00405'),
      (925, 'WS-EV-925', 'Tia',    '0816', '-', 180000, 'paid',    'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', 0, NULL, '00406');
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price,
                             bordir_nama, bordir_nama_price, bordir_logo, bordir_logo_price,
                             is_bonus, is_test_returned) VALUES
      (820, 920, 1, 'One Size', 'merah', 'null', 6, 50000, FALSE, NULL, FALSE, NULL, FALSE, FALSE),
      (821, 921, 1, 'One Size', 'pink',  'null', 4, 50000, FALSE, NULL, FALSE, NULL, FALSE, FALSE),
      (822, 921, 1, 'One Size', 'merah', 'null', 1, 20000, FALSE, NULL, FALSE, NULL, FALSE, FALSE),
      -- 240.000 kotor, di dalamnya bordir nama 20.000 x 2 = 40.000
      (823, 922, 2, 'M', 'black', 'pendek', 2, 120000, TRUE, 20000, FALSE, NULL, FALSE, FALSE),
      (824, 923, 1, 'One Size', 'merah', 'null', 4, 50000, FALSE, NULL, FALSE, NULL, FALSE, FALSE),
      (825, 923, 1, 'One Size', 'biru',  'null', 2, 50000, FALSE, NULL, FALSE, NULL, TRUE,  FALSE),
      (826, 923, 1, 'One Size', 'hijau', 'null', 2, 50000, FALSE, NULL, FALSE, NULL, FALSE, TRUE),
      (827, 924, 1, 'One Size', 'merah', 'null', 6, 50000, FALSE, NULL, FALSE, NULL, FALSE, FALSE),
      (828, 925, 1, 'One Size', 'merah', 'null', 4, 45000, FALSE, NULL, FALSE, NULL, FALSE, FALSE);
    INSERT INTO partner_invoices (id, invoice_no, partner_id, partner_name_snapshot, status,
                                  gross_total, discount_total, total_due, order_count, item_count) VALUES
      (600, 'WS-TP-20260913-0001', 1, 'PT Arta Otto Indonesia', 'issued', 180000, 0, 180000, 1, 4);
    INSERT INTO partner_invoice_orders (invoice_id, order_id, order_code, gross_amount, net_amount, is_active)
      VALUES (600, 925, 'WS-EV-925', 180000, 180000, TRUE);
    `);
}

async function run() {
    await boot(PORT);
    // pg-mem tidak menjalankan ALTER yang memperlebar whitelist order_source,
    // jadi 'collaboration_event' masih ditolak CHECK bawaan.
    for (let i = 0; i < 6; i++) {
        try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {}
    }
    seed();

    group('1. Kasus James: order yang lupa potongan, diberi Consignment 30%');
    let r = await setDisc(920, [30]);
    check('diterima 200', r.status === 200, r.body);
    let o = ord(920);
    check('potongan 30% dari 300.000 = 90.000', Number(o.discount_amount) === 90000, o.discount_amount);
    check('label terisi benar', o.discount_label === 'Consignment 30% (produk + bordir)', o.discount_label);
    // 325.000 (termasuk ongkir 25.000) - 90.000 = 235.000. Ongkir TIDAK didiskon.
    check('total turun jadi 235.000 — ongkir 25.000 utuh', Number(o.total_amount) === 235000, o.total_amount);
    check('satu tahap persen polos disimpan di discount_percent', Number(o.discount_percent) === 30, o.discount_percent);
    check('perubahannya tercatat di jejak audit', jejak(920).length === 1, jejak(920));
    check('catatannya menyebut angka lama dan baru',
        /0.*->.*90000/s.test(jejak(920)[0].note || ''), jejak(920)[0]);
    check('pesanan sudah dibayar → ada peringatan untuk admin',
        Array.isArray(r.body.notes) && r.body.notes.some(n => /sudah dibayar/i.test(n)), r.body.notes);

    group('2. Potongan bisa DIGANTI lagi, bukan cuma ditambah sekali');
    r = await setDisc(920, [10, 30]);
    check('diterima 200', r.status === 200, r.body);
    o = ord(920);
    // 300.000 -> promo 10% = 30.000 -> sisa 270.000 -> 30% = 81.000 -> total 111.000
    check('potongan berantai jadi 111.000', Number(o.discount_amount) === 111000, o.discount_amount);
    check('BUKAN 120.000 (40% dari kotor)', Number(o.discount_amount) !== 120000, o.discount_amount);
    check('label merangkai kedua tahap',
        o.discount_label === 'Promo 10% + Consignment 30% (produk + bordir)', o.discount_label);
    check('total = 325.000 - 111.000 = 214.000', Number(o.total_amount) === 214000, o.total_amount);
    check('susunan berantai TIDAK diwakili discount_percent', Number(o.discount_percent) === 0, o.discount_percent);

    group('3. Potongan bisa DIHAPUS lagi (stages kosong)');
    r = await setDisc(920, []);
    check('diterima 200', r.status === 200, r.body);
    o = ord(920);
    check('potongan kembali 0', Number(o.discount_amount) === 0, o.discount_amount);
    check('label dikosongkan', o.discount_label === null, o.discount_label);
    check('total kembali ke 325.000 persis', Number(o.total_amount) === 325000, o.total_amount);
    check('tiga perubahan, tiga catatan audit', jejak(920).length === 3, jejak(920).length);

    group('4. Diskon manual NOMINAL (Rp) lalu Consignment — persis aturan Kasir');
    r = await setDisc(921, [{ rp: 20000 }, 30]);
    check('diterima 200', r.status === 200, r.body);
    o = ord(921);
    // kotor 220.000 -> potong 20.000 -> sisa 200.000 -> 30% = 60.000 -> total 80.000
    check('potongan jadi 80.000', Number(o.discount_amount) === 80000, o.discount_amount);
    check('label menulis nominalnya apa adanya',
        o.discount_label === 'Diskon Rp 20.000 + Consignment 30% (produk + bordir)', o.discount_label);
    check('total jadi 140.000', Number(o.total_amount) === 140000, o.total_amount);

    group('5. "produk saja" mengeluarkan bordir dari dasar potongan');
    r = await setDisc(922, [30], false);
    check('diterima 200', r.status === 200, r.body);
    o = ord(922);
    // kotor 240.000, bordir 40.000 -> dasar 200.000 -> 30% = 60.000 (bukan 72.000)
    check('potongan 30% dari 200.000 = 60.000', Number(o.discount_amount) === 60000, o.discount_amount);
    check('BUKAN 72.000 (yang ikut memotong bordir)', Number(o.discount_amount) !== 72000, o.discount_amount);
    check('labelnya bilang "produk saja"',
        o.discount_label === 'Consignment 30% (produk saja)', o.discount_label);

    group('6. Bonus & barang uji-coba yang dikembalikan bukan dasar potongan');
    r = await setDisc(923, [30]);
    check('diterima 200', r.status === 200, r.body);
    o = ord(923);
    // Hanya item 824 (200.000) yang jadi dasar; bonus 100.000 & trial balik 100.000 tidak.
    check('potongan 30% dari 200.000 = 60.000', Number(o.discount_amount) === 60000, o.discount_amount);

    group('7. Yang HARUS ditolak');
    let x = await setDisc(924, [30]);
    check('order batal: ditolak 400', x.status === 400, { status: x.status, body: x.body });
    x = await setDisc(925, [30]);
    check('order yang sudah masuk tagihan aktif: ditolak 409', x.status === 409, { status: x.status, body: x.body });
    check('pesannya menyebut nomor tagihannya',
        /WS-TP-20260913-0001/.test(String(x.body && x.body.error)), x.body);
    x = await setDisc(921, [30, { rp: 20000 }]);
    check('nominal bukan di tahap pertama: ditolak 400', x.status === 400, x.body);
    x = await setDisc(921, [0]);
    check('persen 0: ditolak 400', x.status === 400, x.body);
    x = await setDisc(921, [100]);
    check('persen 100: ditolak 400', x.status === 400, x.body);
    x = await setDisc(921, [5, 10, 20, 30]);
    check('lebih dari 3 tahap: ditolak 400', x.status === 400, x.body);
    x = await setDisc(921, [{ rp: 20000 }, 30]);
    check('tidak ada yang berubah: ditolak 400', x.status === 400, x.body);
    x = await setDisc(99999, [30]);
    check('order tidak ada: 404', x.status === 404, x.status);
    x = await setDisc(921, [5], true, LIHAT);
    check('akun lihat-saja: ditolak 403', x.status === 403, { status: x.status, body: x.body });

    group('8. Yang ditolak benar-benar TIDAK mengubah apa pun');
    o = ord(921);
    check('order 921 masih 80.000 seperti kelompok 4', Number(o.discount_amount) === 80000, o.discount_amount);
    check('total 921 masih 140.000', Number(o.total_amount) === 140000, o.total_amount);
    const t925 = ord(925);
    check('order bertagihan tidak tersentuh', Number(t925.discount_amount) === 0 && Number(t925.total_amount) === 180000, t925);
    check('order batal tidak tersentuh', Number(ord(924).discount_amount) === 0, ord(924));
    check('tidak ada catatan audit untuk order yang ditolak',
        jejak(924).length === 0 && jejak(925).length === 0, [jejak(924).length, jejak(925).length]);

    await new Promise(x2 => setTimeout(x2, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
