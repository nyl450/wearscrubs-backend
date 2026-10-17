// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — "barang sudah diambil" per BARIS pesanan (17 Okt 2026)
//
//   Jalankan:  npm test     (atau: node test/run-all.js item-sudah-diambil)
//
// Kasus lapangan dari James: di event pembeli beli 3 potong, 1 langsung dibawa
// pulang, 2 sisanya dikirim. Pesanannya tetap SATU dan tetap lewat alur normal.
//
// Yang dijaga paling ketat di sini: penanda ini **tidak boleh menyentuh apa pun
// selain informasi**. Kalau ia diam-diam memotong stok, hasilnya dobel dengan
// pemotongan saat konfirmasi bayar — persis kelas bug yang invarian
// "stok dipotong tepat sekali" ada untuk mencegah. Kalau ia menyentuh total,
// tagihannya jadi salah. Dua-duanya diperiksa eksplisit.
//
// Bedakan dari orders.picked_up_at (seluruh pesanan dibawa pulang) yang diuji
// di ambil-dulu.test.js — yang itu MEMANG memotong stok lebih awal.
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4741;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
const ADMIN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, SECRET, { expiresIn: '1h' });
// Staf tanpa izin tulis pesanan — penanda ini mengubah instruksi pengiriman,
// jadi tetap harus lewat penjaga yang sama dengan edit pesanan.
const LIHAT = jwt.sign({ id: 2, username: 'sindy', role: 'staff', menus: { orders: 'view' } }, SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'connection': 'close' } };
    if (token !== null) opts.headers['Authorization'] = 'Bearer ' + (token === undefined ? ADMIN : token);
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const t = await res.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: res.status, body: b };
}

const V = { product_id: 1, size: 'M', color: 'black', variant_type: 'pendek' };
const stok = () => Number(one(
    `SELECT stock FROM inventory WHERE product_id=1 AND size='M' AND color='black' AND variant_type='pendek'`).stock);
const terakhir = () => Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
const baris = (orderId) => many(`SELECT id, size, picked_up_at, picked_up_by FROM order_items WHERE order_id = ${orderId} ORDER BY id`);
const ordir = (id) => one(`SELECT order_status, payment_status, total_amount FROM orders WHERE id = ${id}`);
const bebaskanBukti = (id) => none(`UPDATE orders SET payment_method = 'Bonus/Free' WHERE id = ${id}`);

function pesanan(extra = {}) {
    return {
        customer_name: 'Dokter Event', customer_phone: '08110000001', customer_address: 'Jl. Uji',
        shipping_city: 'Denpasar', shipping_courier: 'J&T', shipping_weight_kg: 1, shipping_cost: 25000,
        order_source: 'event_offline', payment_method: 'Cash',
        // Tiga potong: satu M (yang nanti dibawa pulang), dua L (yang dikirim).
        items: [{ ...V, quantity: 1 }, { ...V, size: 'L', quantity: 2 }],
        force_new: true,
        ...extra,
    };
}

function seed() {
    none(`DELETE FROM stock_holds; DELETE FROM stock_movements; DELETE FROM order_items;
          DELETE FROM order_photos; DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
      (1, 'MIN', 'Minna', 'tops', 290000, 130000, TRUE);
    INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES
      (1, 'M', 'black', 'pendek', 10, 0),
      (1, 'L', 'black', 'pendek', 10, 0);
    `);
}

async function run() {
    await boot(PORT);
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {} }
    seed();

    group('A. Menandai satu baris — dan TIDAK ada efek samping');
    let r = await req('POST', '/api/orders', pesanan());
    check('pesanan dibuat', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const id1 = terakhir();
    const totalAwal = Number(ordir(id1).total_amount);
    const stokAwalM = stok();
    const itemM = baris(id1).find(b => b.size === 'M');
    check('belum ada yang bertanda', baris(id1).every(b => b.picked_up_at === null), baris(id1));

    r = await req('PUT', `/api/orders/${id1}/items/${itemM.id}/picked-up`, { picked_up: true }, ADMIN);
    check('penandaan diterima', r.status === 200, { status: r.status, body: r.body });
    check('balasannya menyatakan sudah ditandai', r.body.picked_up === true, r.body);

    let b = baris(id1);
    const bM = b.find(x => x.size === 'M');
    check('baris M bertanda waktunya', bM.picked_up_at !== null, bM);
    check('tercatat siapa yang mencatat', bM.picked_up_by === 'harness', bM.picked_up_by);
    check('baris L TIDAK ikut bertanda — tandanya per baris, bukan per pesanan',
        b.filter(x => x.size === 'L').every(x => x.picked_up_at === null), b);

    check('STOK TIDAK BERUBAH — potongannya tetap sekali, saat konfirmasi bayar',
        stok() === stokAwalM, { sebelum: stokAwalM, sesudah: stok() });
    check('tidak ada catatan pergerakan stok baru',
        many(`SELECT id FROM stock_movements`).length === 0, many(`SELECT movement_type FROM stock_movements`));
    check('TOTAL TAGIHAN tidak berubah — barangnya tetap dibeli, cuma diambil lebih awal',
        Number(ordir(id1).total_amount) === totalAwal, { totalAwal, sekarang: ordir(id1).total_amount });
    check('status pesanan tetap berjalan normal',
        ordir(id1).order_status === 'waiting_payment', ordir(id1).order_status);

    group('B. Pesanan tetap lewat alur normal sampai selesai');
    bebaskanBukti(id1);
    r = await req('PUT', `/api/orders/${id1}/confirm-payment`, {}, ADMIN);
    check('konfirmasi bayar diterima', r.status === 200, r.body);
    check('TIDAK langsung selesai — ini bukan "barang diambil dulu" se-pesanan',
        ordir(id1).order_status === 'confirmed', ordir(id1).order_status);
    check('stok dipotong SEKARANG, termasuk baris yang sudah diambil',
        stok() === stokAwalM - 1, { M: stok() });
    check('baris yang bertanda tetap bertanda setelah dibayar',
        baris(id1).find(x => x.size === 'M').picked_up_at !== null, baris(id1));
    r = await req('PUT', `/api/orders/${id1}/pack`, {}, ADMIN);
    check('masih bisa dikemas seperti biasa', r.status === 200, { status: r.status, body: r.body });

    group('C. Tandanya bisa dilepas lagi (salah tandai itu wajar)');
    seed();
    r = await req('POST', '/api/orders', pesanan());
    const id2 = terakhir();
    const it2 = baris(id2)[0];
    await req('PUT', `/api/orders/${id2}/items/${it2.id}/picked-up`, { picked_up: true }, ADMIN);
    check('tertandai', baris(id2)[0].picked_up_at !== null);
    r = await req('PUT', `/api/orders/${id2}/items/${it2.id}/picked-up`, { picked_up: false }, ADMIN);
    check('pelepasan diterima', r.status === 200 && r.body.picked_up === false, r.body);
    check('tandanya benar-benar hilang', baris(id2)[0].picked_up_at === null, baris(id2)[0]);
    check('nama pencatatnya ikut dibersihkan', baris(id2)[0].picked_up_by === null, baris(id2)[0]);

    group('D. Yang ditolak');
    r = await req('PUT', `/api/orders/${id2}/items/${it2.id}/picked-up`, { picked_up: true }, LIHAT);
    check('staf "lihat saja" ditolak', r.status === 403, { status: r.status, body: r.body });
    check('dan memang tidak jadi tertandai', baris(id2)[0].picked_up_at === null, baris(id2)[0]);

    r = await req('PUT', `/api/orders/${id2}/items/999999/picked-up`, { picked_up: true }, ADMIN);
    check('item yang tidak ada: 404', r.status === 404, { status: r.status, body: r.body });

    // Baris milik pesanan LAIN tidak boleh bisa ditandai lewat id pesanan ini —
    // tanpa pemeriksaan order_id, siapa pun yang boleh menyunting satu pesanan
    // bisa mengubah pesanan orang lain.
    r = await req('POST', '/api/orders', pesanan({ customer_phone: '08110000002' }));
    const id3 = terakhir();
    const itemOrangLain = baris(id3)[0];
    r = await req('PUT', `/api/orders/${id2}/items/${itemOrangLain.id}/picked-up`, { picked_up: true }, ADMIN);
    check('item milik pesanan lain: 404, bukan diam-diam berubah', r.status === 404, { status: r.status, body: r.body });
    check('pesanan lain itu tidak tersentuh', baris(id3)[0].picked_up_at === null, baris(id3)[0]);

    r = await req('PUT', `/api/orders/${id3}/cancel`, { cancel_reason: 'uji' }, ADMIN);
    check('pesanan dibatalkan dulu', r.status === 200, r.body);
    r = await req('PUT', `/api/orders/${id3}/items/${itemOrangLain.id}/picked-up`, { picked_up: true }, ADMIN);
    check('pesanan batal: ditolak 400', r.status === 400, { status: r.status, body: r.body });

    group('E. Tandanya ikut terbaca di detail pesanan (sumber peringatan "jangan dikirim")');
    seed();
    r = await req('POST', '/api/orders', pesanan());
    const id4 = terakhir();
    const it4 = baris(id4).find(x => x.size === 'M');
    await req('PUT', `/api/orders/${id4}/items/${it4.id}/picked-up`, { picked_up: true }, ADMIN);
    // Dipakai daftar pesanan, bukan GET /api/orders/:id: subquery foto varian di
    // endpoint detail tidak didukung pg-mem (500 di harness, baik-baik saja di
    // Postgres). Keduanya membaca order_items dengan `oi.*` yang sama.
    r = await req('GET', `/api/orders`, null, ADMIN);
    check('daftar pesanan terbaca', r.status === 200, r.status);
    const o4 = (r.body || []).find(x => x.id === id4) || {};
    const dariApi = (o4.items || []).find(x => x.id === it4.id);
    check('baris bertanda terbawa ke tampilan', !!(dariApi && dariApi.picked_up_at), dariApi);
    check('tepat satu baris yang bertanda',
        (o4.items || []).filter(x => x.picked_up_at).length === 1,
        (o4.items || []).map(x => ({ size: x.size, p: x.picked_up_at })));

    await new Promise(w => setTimeout(w, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
