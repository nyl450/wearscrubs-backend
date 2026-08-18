// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — PUT /api/orders/:id/items/:itemId (edit item pesanan)
//
//   Jalankan:  npm test
//
// Cara kerjanya: modul `pg` ditukar dengan pg-mem (Postgres in-memory), lalu
// server.js ASLI di-load apa adanya dan endpoint dipanggil lewat HTTP sungguhan.
// Jadi yang diuji benar-benar handler yang dipakai produksi — bukan tiruan
// logikanya — tanpa menyentuh database produksi sama sekali.
//
// Fokus utamanya satu hal yang paling gampang rusak diam-diam: setelah item
// pesanan diedit, pemotongan stok saat pembayaran dikonfirmasi HARUS mengikuti
// varian terbaru, bukan varian sebelum diedit.
//
// Batasnya (biar jujur): pg-mem bukan Postgres asli. Hal yang bergantung pada
// perilaku Postgres persis — penguncian baris FOR UPDATE, rollback transaksi,
// CHECK constraint hasil migrasi ALTER — tidak terverifikasi di sini. Beberapa
// statement initDB() memang dilewati pg-mem; skema yang dipakai uji ini tetap
// yang dibuat initDB() sendiri.
//
// Kalau menambah field baru di endpoint ini, tambahkan juga pemeriksaannya.
// ═══════════════════════════════════════════════════════════════════════════════
const Module = require('module');
const { newDb } = require('pg-mem');

const db = newDb();
const pgAdapter = db.adapters.createPg();
global.__SWALLOW = true;
const initErrors = [];

class SafePool extends pgAdapter.Pool {
    async query(...args) {
        try { return await super.query(...args); }
        catch (e) {
            if (global.__SWALLOW) { initErrors.push(String(e.message).slice(0, 100)); return { rows: [], rowCount: 0 }; }
            throw e;
        }
    }
}
const fakePg = { Pool: SafePool, Client: pgAdapter.Client, types: pgAdapter.types };

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === 'pg') return fakePg;
    return origRequire.apply(this, arguments);
};

process.env.DATABASE_URL = 'postgres://test/test';
process.env.JWT_SECRET = 'harness_secret';
process.env.PORT = process.env.TEST_PORT || '4711';
process.env.NODE_ENV = 'test';

require(require('path').join(__dirname, '..', 'server.js'));

const jwt = require('jsonwebtoken');
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, 'harness_secret', { expiresIn: '1h' });
const BASE = `http://localhost:${process.env.PORT}`;

const many = (sql) => db.public.many(sql);
const one = (sql) => many(sql)[0];
const none = (sql) => db.public.none(sql);

function seed() {
    none(`DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM stock_movements;
          DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, price_by_type, cogs_default, cogs_by_type, is_active) VALUES
      (1, 'ALX', 'Alex SS', 'tops',  245000, '{"pendek":245000,"panjang":260000}', 120000, '{"pendek":120000,"panjang":130000}', TRUE),
      (3, 'DYL', 'Dylan',   'pants', 230000, NULL, 110000, NULL, TRUE),
      (5, 'GWN', 'Gown Polos', 'gown', 300000, NULL, 150000, NULL, TRUE);
    INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES
      (1, 'M', 'black', 'pendek', 5), (1, 'L', 'black', 'pendek', 4),
      (1, 'M', 'black', 'panjang', 3), (1, 'L', 'black', 'panjang', 2),
      (3, 'L', 'black', 'jogger', 4), (5, 'M', 'olive', 'polos', 9);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source,
                        discount_percent, discount_amount, embroidery_details, has_bordir_nama) VALUES
      (999, 'WS-TEST-0001', 'Uji Coba', '0811', 'Alamat uji', 767000, 'pending', 'waiting_payment',
       45000, 'J&T', 'whatsapp', 5, 38000,
       '[{"type":"nama","item_label":"Alex SS (black, M)","value":"drg. Uji","color":"Putih","position":"kanan"}]', TRUE);
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price,
                             bordir_nama, bordir_nama_price, unit_cogs, bordir_nama_cogs, total_cogs) VALUES
      (501, 999, 1, 'M', 'black', 'pendek', 2, 265000, TRUE, 20000, 120000, 5000, 250000),
      (502, 999, 3, 'L', 'black', 'jogger', 1, 230000, FALSE, NULL, 110000, 0, 110000);
    `);
}

async function editItem(orderId, itemId, fields, token = TOKEN) {
    const fd = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    const res = await fetch(`${BASE}/api/orders/${orderId}/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: fd.toString()
    });
    return { status: res.status, body: await res.json() };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log(`  [OK] ${label}`); }
    else { fail++; console.log(`  [GAGAL] ${label} -> ${JSON.stringify(detail)}`); }
}

async function run() {
    await new Promise(r => setTimeout(r, 1500));
    global.__SWALLOW = false;
    console.log(`\ninitDB: ${initErrors.length} statement dilewati pg-mem (tidak dipakai uji ini)`);
    console.log('contoh:', initErrors.slice(0, 3).join(' | '), '\n');

    // 1 — ganti variant
    seed();
    console.log('1. Ganti variant pendek -> panjang');
    let r = await editItem(999, 501, { product_id: 1, color: 'black', variant_type: 'panjang', size: 'M', quantity: 2 });
    let it = one('SELECT * FROM order_items WHERE id = 501');
    let o = one('SELECT * FROM orders WHERE id = 999');
    check('status 200', r.status === 200, r);
    check('variant tersimpan', it.variant_type === 'panjang', it.variant_type);
    check('harga 265.000 -> 280.000 (260rb + bordir 20rb)', it.price === 280000, it.price);
    check('COGS ikut variant baru (130rb)', it.unit_cogs === 130000, it.unit_cogs);
    check('total_cogs = (130rb+5rb) x 2 = 270.000', it.total_cogs === 270000, it.total_cogs);
    check('total pesanan 767.000 -> 795.500', o.total_amount === 795500, o.total_amount);
    check('diskon 5% dihitung ulang -> 39.500', o.discount_amount === 39500, o.discount_amount);
    check('bukan PO (stok 3 >= 2)', it.is_po === false, it.is_po);
    check('variant ditulis ke entry bordir', JSON.parse(o.embroidery_details)[0].variant_type === 'panjang', o.embroidery_details);
    check('ada jejak audit', one(`SELECT COUNT(*)::int AS n FROM order_photos WHERE order_id=999 AND step='edit'`).n === 1, 'audit');

    // 2 — ganti size, label bordir ikut
    seed();
    console.log('\n2. Ganti size M -> L');
    r = await editItem(999, 501, { size: 'L' });
    o = one('SELECT * FROM orders WHERE id = 999');
    it = one('SELECT * FROM order_items WHERE id = 501');
    check('status 200', r.status === 200, r);
    check('size tersimpan', it.size === 'L', it.size);
    check('item_label bordir jadi "Alex SS (black, L)"',
        JSON.parse(o.embroidery_details)[0].item_label === 'Alex SS (black, L)', o.embroidery_details);

    // 3 — qty
    seed();
    console.log('\n3. Qty 2 -> 4');
    r = await editItem(999, 501, { quantity: 4 });
    it = one('SELECT * FROM order_items WHERE id = 501');
    o = one('SELECT * FROM orders WHERE id = 999');
    check('status 200', r.status === 200, r);
    check('qty tersimpan', it.quantity === 4, it.quantity);
    check('total_cogs ikut qty ((120rb+5rb) x 4 = 500.000)', it.total_cogs === 500000, it.total_cogs);
    check('total = 1.290.000 - diskon5% 64.500 + ongkir 45.000 = 1.270.500', o.total_amount === 1270500, o.total_amount);
    check('ada catatan ongkir', !!r.body.shipping_note, r.body);

    seed();
    console.log('\n4. Qty 2 -> 9 (stok 5) harus jadi Pre-Order');
    r = await editItem(999, 501, { quantity: 9 });
    it = one('SELECT * FROM order_items WHERE id = 501');
    check('status 200', r.status === 200, r);
    check('ditandai PO', it.is_po === true, it.is_po);
    check('ada peringatan PO', !!r.body.po_note, r.body.po_note);

    // 5 — guard
    console.log('\n5. Guard');
    seed(); r = await editItem(999, 501, { quantity: 0 });
    check('qty 0 ditolak', r.status === 400, r);
    seed(); r = await editItem(999, 501, { quantity: 1000 });
    check('qty 1000 ditolak', r.status === 400, r);
    seed(); r = await editItem(999, 501, { product_id: 3, color: 'black', variant_type: 'jogger', size: 'L' });
    check('item ber-bordir -> celana ditolak', r.status === 400 && /bordir/i.test(r.body.error), r);
    seed(); r = await editItem(999, 501, { color: 'maroon' });
    check('warna di luar katalog ditolak', r.status === 400 && /tidak ada di katalog/i.test(r.body.error), r);
    seed(); r = await editItem(999, 501, { size: 'M' });
    check('tanpa perubahan ditolak', r.status === 400 && /tidak ada yang berubah/i.test(r.body.error), r);
    seed();
    none(`UPDATE orders SET embroidery_details = '[{"type":"nama","item_label":"Alex SS (black, M)","value":"A"},{"type":"nama","item_label":"Alex SS (black, M)","value":"B"}]' WHERE id = 999`);
    r = await editItem(999, 501, { quantity: 1 });
    check('qty turun di bawah jumlah entry bordir ditolak', r.status === 400 && /entry bordir/i.test(r.body.error), r);
    seed(); none(`UPDATE orders SET payment_status = 'paid' WHERE id = 999`);
    r = await editItem(999, 501, { size: 'L' });
    check('order sudah dibayar ditolak', r.status === 400 && /sudah dibayar/i.test(r.body.error), r);
    seed(); none(`UPDATE orders SET order_status = 'shipped' WHERE id = 999`);
    r = await editItem(999, 501, { size: 'L' });
    check('order sudah dikirim ditolak', r.status === 400, r);
    seed(); r = await editItem(999, 501, { size: 'L' }, 'token-palsu');
    check('token tidak valid ditolak', r.status === 401, r);
    seed(); none(`UPDATE order_items SET is_custom_size = TRUE WHERE id = 501`);
    r = await editItem(999, 501, { size: 'L' });
    check('item custom ditolak', r.status === 400 && /custom/i.test(r.body.error), r);

    // 6 — INTI: stok mengikuti pesanan terbaru
    console.log('\n6. Edit lalu bayar -> stok terpotong sesuai pesanan TERBARU');
    seed();
    none(`UPDATE orders SET payment_method = 'Bonus/Free', has_bordir_nama = FALSE WHERE id = 999`);
    none(`UPDATE order_items SET bordir_nama = FALSE, bordir_nama_price = NULL, price = 245000 WHERE id = 501`);
    await editItem(999, 501, { product_id: 1, color: 'black', variant_type: 'panjang', size: 'L', quantity: 2 });
    const stok = () => Object.fromEntries(many(`SELECT variant_type, size, stock FROM inventory WHERE product_id=1`)
        .map(x => [`${x.variant_type}/${x.size}`, x.stock]));
    const before = stok();
    const payRes = await fetch(`${BASE}/api/orders/999/confirm-payment`, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + TOKEN } });
    const payBody = await payRes.json();
    const after = stok();
    console.log('   stok sebelum bayar:', JSON.stringify(before));
    console.log('   stok sesudah bayar:', JSON.stringify(after));
    check('konfirmasi bayar sukses', payRes.status === 200, payBody);
    check('varian BARU panjang/L berkurang 2', after['panjang/L'] === before['panjang/L'] - 2, { before: before['panjang/L'], after: after['panjang/L'] });
    check('varian LAMA pendek/M tidak tersentuh', after['pendek/M'] === before['pendek/M'], { before: before['pendek/M'], after: after['pendek/M'] });
    const mv = many(`SELECT * FROM stock_movements WHERE order_id = 999`);
    check('log stok mencatat varian baru', mv.some(m => m.variant_type === 'panjang' && m.size === 'L'), mv.map(m => `${m.variant_type}/${m.size}:${m.quantity_change}`));
    check('order jadi paid', one(`SELECT payment_status FROM orders WHERE id=999`).payment_status === 'paid', one(`SELECT payment_status FROM orders WHERE id=999`));

    console.log('\n7. Baris yang jadi PO tidak dipotong saat bayar');
    seed();
    none(`UPDATE orders SET payment_method = 'Bonus/Free', has_bordir_nama = FALSE WHERE id = 999`);
    none(`UPDATE order_items SET bordir_nama = FALSE, bordir_nama_price = NULL, price = 245000 WHERE id = 501`);
    await editItem(999, 501, { quantity: 9 });
    const b2 = one(`SELECT stock FROM inventory WHERE product_id=1 AND variant_type='pendek' AND size='M'`).stock;
    const pay2 = await fetch(`${BASE}/api/orders/999/confirm-payment`, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + TOKEN } });
    const pay2body = await pay2.json();
    const a2 = one(`SELECT stock FROM inventory WHERE product_id=1 AND variant_type='pendek' AND size='M'`).stock;
    check('bayar sukses', pay2.status === 200, pay2body);
    check('stok tidak dipotong untuk baris PO', a2 === b2, { before: b2, after: a2 });

    console.log(`\n===== HASIL: ${pass} lolos, ${fail} gagal =====`);
    process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error('HARNESS ERROR:', e && e.message); process.exit(2); });
