// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — PUT /api/admin/partner-billing/orders/:id/consignment
//
//   Jalankan:  npm test     (atau: node test/run-all.js consignment-toggle)
//
// Fitur "centang Consignment" di penyusun tagihan: membetulkan order event yang
// LUPA diberi potongan Consignment saat input di Kasir. Sudah terjadi berkali-kali
// dan sebelumnya hanya bisa dibereskan lewat SQL langsung.
//
// Yang paling gampang rusak diam-diam, dan karena itu diuji ketat di sini:
//
//  1. **Berantai, bukan dijumlah.** Order yang sudah kena promo pelanggan 10%
//     harus jadi 10% lalu 30% DARI SISANYA (81.400 dari 220.000), bukan 40% dari
//     kotor (88.000). Selisihnya 6.600 per order = kurang tagih partner.
//
//  2. **Bolak-balik harus pulih persis.** Centang lalu batal centang wajib
//     mengembalikan potongan DAN total ke angka semula — kalau tidak, salah klik
//     berujung minta tolong SQL lagi, yaitu masalah yang justru mau dihapus.
//
//  3. **Order yang sudah masuk tagihan aktif tidak boleh diubah.** Tagihan adalah
//     snapshot terkunci; kalau ordernya bergeser setelah tagihan terbit, angka
//     yang sudah dikirim ke partner dan angka di sistem diam-diam berbeda.
//
//  4. **Order yang pernah dikoreksi manual ditolak.** Kalau nominal potongannya
//     tidak cocok dengan labelnya, menghitung ulang akan menimpa angka yang
//     sengaja dibuat berbeda.
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4719;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + (token === undefined ? TOKEN : token) } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const text = await res.text();
    let out; try { out = JSON.parse(text); } catch { out = text; }
    return { status: res.status, body: out };
}

const toggle = (orderId, apply) =>
    req('PUT', `/api/admin/partner-billing/orders/${orderId}/consignment`, { apply });
const ord = (id) => one(`SELECT discount_amount, discount_label, total_amount FROM orders WHERE id = ${id}`);

// 910 Nadia  — kotor 300.000, LUPA potongan            (kasus utama)
// 911 Sandra — kotor 220.000, sudah promo 10% (22.000), lupa consignment
// 912 Suci   — kotor 240.000, potongan consignment sudah benar
// 913 Rani   — kotor 300.000, label bilang 30% tapi nominalnya 50.000 (koreksi manual)
// 914 Budi   — order WhatsApp biasa, bukan event
// 915 Heidi  — order event yang DIBATALKAN
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
      (910, 'WS-EV-910', 'Nadia',  '0811', '-', 300000, 'paid', 'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-13', 0,     NULL,                            '00301'),
      (911, 'WS-EV-911', 'Sandra', '0812', '-', 198000, 'paid', 'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-13', 22000, 'Promo 10% (produk + bordir)',   '00302'),
      (912, 'WS-EV-912', 'Suci',   '0813', '-', 168000, 'paid', 'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-13', 72000, 'Consignment 30% (produk + bordir)', '00303'),
      (913, 'WS-EV-913', 'Rani',   '0814', '-', 250000, 'paid', 'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-13', 50000, 'Consignment 30% (produk + bordir)', '00304'),
      (914, 'WS-WA-914', 'Budi',   '0815', '-', 300000, 'paid', 'done', 0, 'J&T', 'whatsapp',            NULL,                     NULL, '2026-08-13', 0,    NULL,                            NULL),
      (915, 'WS-EV-915', 'Heidi',  '0816', '-', 300000, 'paid', 'cancelled', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-13', 0, NULL,                            '00305');
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price,
                             bordir_nama, bordir_nama_price, bordir_logo, bordir_logo_price) VALUES
      (810, 910, 1, 'One Size', 'merah', 'null', 6, 50000, FALSE, NULL, FALSE, NULL),
      (811, 911, 1, 'One Size', 'pink',  'null', 4, 50000, FALSE, NULL, FALSE, NULL),
      (812, 911, 1, 'One Size', 'merah', 'null', 1, 20000, FALSE, NULL, FALSE, NULL),
      (813, 912, 1, 'One Size', 'merah', 'null', 4, 60000, FALSE, NULL, FALSE, NULL),
      (814, 913, 1, 'One Size', 'merah', 'null', 6, 50000, FALSE, NULL, FALSE, NULL),
      (815, 914, 1, 'One Size', 'merah', 'null', 6, 50000, FALSE, NULL, FALSE, NULL),
      (816, 915, 1, 'One Size', 'merah', 'null', 6, 50000, FALSE, NULL, FALSE, NULL);
    `);
}

async function run() {
    await boot(PORT);
    // pg-mem tidak menjalankan ALTER ... DROP/ADD CONSTRAINT yang memperlebar
    // whitelist order_source, jadi 'collaboration_event' masih ditolak CHECK bawaan.
    for (let i = 0; i < 6; i++) {
        try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {}
    }

    group('1. Order yang lupa potongan: dicentang lalu dibatalkan, pulih persis');
    seed();
    let sebelum = ord(910);
    let r = await toggle(910, true);
    check('permintaan diterima', r.status === 200, r.body);
    let o = ord(910);
    check('potongan jadi 30% dari 300.000', Number(o.discount_amount) === 90000, o.discount_amount);
    check('label terisi benar', o.discount_label === 'Consignment 30% (produk + bordir)', o.discount_label);
    check('total order ikut turun jadi 210.000', Number(o.total_amount) === 210000, o.total_amount);
    check('perubahan tercatat di jejak audit',
        many(`SELECT id FROM order_photos WHERE order_id = 910 AND step = 'edit'`).length === 1);

    r = await toggle(910, false);
    check('pembatalan diterima', r.status === 200, r.body);
    o = ord(910);
    check('potongan kembali 0', Number(o.discount_amount) === 0, o.discount_amount);
    check('label kembali kosong', o.discount_label === null, o.discount_label);
    check('total kembali ke angka semula',
        Number(o.total_amount) === Number(sebelum.total_amount), [o.total_amount, sebelum.total_amount]);

    group('2. Order berpromo: consignment dihitung dari SISA, bukan dijumlah jadi 40%');
    seed();
    sebelum = ord(911);
    r = await toggle(911, true);
    check('permintaan diterima', r.status === 200, r.body);
    o = ord(911);
    // kotor 220.000 -> promo 10% = 22.000 -> sisa 198.000 -> 30% = 59.400
    check('potongan total jadi 81.400', Number(o.discount_amount) === 81400, o.discount_amount);
    check('BUKAN 88.000 (40% dari kotor)', Number(o.discount_amount) !== 88000, o.discount_amount);
    check('label merangkai dua tahap',
        o.discount_label === 'Promo 10% + Consignment 30% (produk + bordir)', o.discount_label);
    check('total jadi 138.600', Number(o.total_amount) === 138600, o.total_amount);

    r = await toggle(911, false);
    o = ord(911);
    check('dibatalkan: potongan kembali ke promo saja (22.000)', Number(o.discount_amount) === 22000, o.discount_amount);
    check('dibatalkan: label kembali promo saja',
        o.discount_label === 'Promo 10% (produk + bordir)', o.discount_label);
    check('dibatalkan: total kembali ke angka semula',
        Number(o.total_amount) === Number(sebelum.total_amount), [o.total_amount, sebelum.total_amount]);

    group('3. Order yang potongannya sudah benar tidak bisa dicentang dua kali');
    seed();
    r = await toggle(912, true);
    check('ditolak 409', r.status === 409, r.body);
    check('angkanya tidak tersentuh', Number(ord(912).discount_amount) === 72000, ord(912).discount_amount);

    group('4. Membatalkan centang pada order yang memang tidak punya consignment');
    seed();
    r = await toggle(910, false);
    check('ditolak 409', r.status === 409, r.body);
    check('angkanya tidak tersentuh', Number(ord(910).total_amount) === 300000, ord(910).total_amount);

    group('5. Order yang pernah dikoreksi manual: ditolak, jangan ditimpa');
    seed();
    r = await toggle(913, false);
    check('ditolak 409', r.status === 409, r.body);
    check('pesan menyebut koreksi manual',
        String(r.body && r.body.error).toLowerCase().includes('dikoreksi manual'), r.body);
    check('potongan 50.000 tetap utuh', Number(ord(913).discount_amount) === 50000, ord(913).discount_amount);

    group('6. Bukan order Collaboration Event');
    seed();
    r = await toggle(914, true);
    check('ditolak 400', r.status === 400, r.body);
    check('angkanya tidak tersentuh', Number(ord(914).total_amount) === 300000, ord(914).total_amount);

    group('7. Order batal');
    seed();
    r = await toggle(915, true);
    check('ditolak 400', r.status === 400, r.body);

    group('8. Order yang sudah masuk tagihan AKTIF tidak boleh diubah');
    seed();
    none(`INSERT INTO partner_invoices (id, invoice_no, partner_id, partner_name_snapshot, status,
                                        gross_total, discount_total, total_due, order_count, item_count)
          VALUES (77, 'WS-TP-20260829-0001', 1, 'PT Arta Otto Indonesia', 'issued', 300000, 0, 300000, 1, 6);
          INSERT INTO partner_invoice_orders (invoice_id, order_id, receipt_no, order_code, customer_name,
                                              gross_amount, discount_amount, net_amount, is_active)
          VALUES (77, 910, '00301', 'WS-EV-910', 'Nadia', 300000, 0, 300000, TRUE);`);
    r = await toggle(910, true);
    check('ditolak 409', r.status === 409, r.body);
    check('pesan menyebut nomor tagihannya',
        String(r.body && r.body.error).includes('WS-TP-20260829-0001'), r.body);
    check('angkanya tidak tersentuh', Number(ord(910).total_amount) === 300000, ord(910).total_amount);

    group('9. Layar penyusun menandai status centang dengan benar');
    seed();
    r = await req('GET', '/api/admin/partner-billing/candidates?partner_id=1');
    check('diterima', r.status === 200, r.body);
    const byId = Object.fromEntries((r.body.orders || []).map(x => [String(x.id), x]));
    check('910 (lupa potongan) belum tercentang & bisa diubah',
        byId['910'] && byId['910'].consignment_applied === false && !byId['910'].consignment_locked_reason,
        byId['910']);
    check('912 (sudah benar) tercentang',
        byId['912'] && byId['912'].consignment_applied === true, byId['912']);
    check('913 (koreksi manual) dikunci',
        byId['913'] && !!byId['913'].consignment_locked_reason, byId['913']);
    check('915 (batal) dikunci',
        byId['915'] && !!byId['915'].consignment_locked_reason, byId['915']);

    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
