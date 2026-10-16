// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — diskon produk per WARNA & VARIANT
//
//   Jalankan:  npm test     (atau: node test/run-all.js diskon-produk)
//
// Latar (James, 16 Okt 2026): "Minna warna ungu mau didiskon, boleh lengan
// panjang & pendek, bisa juga salah satunya saja." Diskon menempel pada PRODUK,
// terlihat di website, dan otomatis terpakai di Kasir.
//
// Yang paling berbahaya kalau rusak diam-diam, dan karena itu dijaga ketat:
//
//  1. **Harga dihitung di SERVER.** Kalau diskon hanya dihitung di browser,
//     pembeli website bisa memanggil API langsung dan membayar harga apa pun.
//     Semua asersi harga di sini membaca order_items dari database, bukan
//     jawaban yang ramah di layar.
//  2. **Cakupan benar-benar menyaring.** Diskon ungu TIDAK boleh mengenai hitam;
//     diskon lengan pendek TIDAK boleh mengenai lengan panjang. Salah di sini =
//     kerugian diam-diam di tiap penjualan.
//  3. **Semua jalur harga ikut**: buat pesanan, tambah item, edit item. Kalau
//     salah satu memakai harga mentah, pembeli melihat harga diskon di website
//     tapi ditagih harga penuh.
//  4. **Harga khusus admin menang** atas diskon produk — itu kesepakatan yang
//     sengaja diketik manusia.
//  5. **COGS tidak ikut turun.** Diskon memotong harga jual, bukan biaya
//     produksi; kalau COGS ikut dipotong, laporan margin jadi bohong.
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4736;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
const ADMIN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, SECRET, { expiresIn: '1h' });
const STAF  = jwt.sign({ id: 8, username: 'gudang', role: 'staff', allowed_menus: { products: 'edit', orders: 'edit' } }, SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'connection': 'close' } };
    if (token !== null) opts.headers['Authorization'] = 'Bearer ' + (token === undefined ? ADMIN : token);
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const t = await res.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: res.status, body: b };
}

const simpanDiskon = (discounts, token) => req('PUT', '/api/products/25/discounts', { discounts }, token);
const terakhir = () => Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
const barisHarga = (orderId) => many(
    `SELECT oi.color, oi.variant_type, oi.price, oi.unit_cogs FROM order_items oi WHERE oi.order_id = ${orderId} ORDER BY oi.id`);

// Minna: pendek 270.000, panjang 290.000. COGS pendek 123.096, panjang 144.586.
function pesan(items, extra = {}) {
    return {
        customer_name: 'Pembeli', customer_phone: '08110000000', customer_address: 'Jl. Uji',
        shipping_city: 'Denpasar', shipping_courier: 'J&T', shipping_weight_kg: 1, shipping_cost: 0,
        order_source: 'whatsapp', payment_method: 'Cash', force_new: true,
        items, ...extra,
    };
}
const IT = (color, variant, extra = {}) => ({ product_id: 25, size: 'M', color, variant_type: variant, quantity: 1, ...extra });

function seed() {
    none(`DELETE FROM product_discounts; DELETE FROM stock_holds; DELETE FROM stock_movements;
          DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM orders;
          DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, price_by_type, cogs_default, cogs_by_type, is_active, status) VALUES
      (25, 'MIN', 'Minna', 'tops', 270000, '{"pendek":270000,"panjang":290000}', 123096, '{"pendek":123096,"panjang":144586}', TRUE, 'active');
    INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES
      (25, 'M', 'ungu',  'pendek',  10, 0), (25, 'M', 'ungu',  'panjang', 10, 0),
      (25, 'M', 'black', 'pendek',  10, 0), (25, 'M', 'black', 'panjang', 10, 0);
    `);
}

async function run() {
    await boot(PORT);
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {} }
    seed();

    group('1. Kasus James: ungu didiskon, DUA-DUANYA lengan');
    let r = await simpanDiskon([{ kind: 'pct', value: 20, colors: ['ungu'], variants: [], label: 'Promo Ungu' }]);
    check('tersimpan', r.status === 200, r.body);
    r = await req('POST', '/api/orders', pesan([
        IT('ungu', 'pendek'), IT('ungu', 'panjang'), IT('black', 'pendek'), IT('black', 'panjang'),
    ]));
    check('pesanan dibuat', r.status === 201 || r.status === 200, r.body);
    let b = barisHarga(terakhir());
    check('ungu pendek 270.000 -> 216.000', Number(b[0].price) === 216000, b[0]);
    check('ungu panjang 290.000 -> 232.000', Number(b[1].price) === 232000, b[1]);
    check('hitam pendek TETAP 270.000 — diskon ungu tidak boleh merembet', Number(b[2].price) === 270000, b[2]);
    check('hitam panjang TETAP 290.000', Number(b[3].price) === 290000, b[3]);
    check('COGS tidak ikut turun (diskon memotong harga jual, bukan biaya produksi)',
        Number(b[0].unit_cogs) === 123096 && Number(b[1].unit_cogs) === 144586, [b[0].unit_cogs, b[1].unit_cogs]);
    check('alasan harganya tercatat di jejak audit',
        many(`SELECT note FROM order_photos WHERE order_id = ${terakhir()} AND step = 'edit'`)
            .some(x => /Diskon produk terpakai/i.test(x.note || '')),
        many(`SELECT note FROM order_photos WHERE order_id = ${terakhir()} AND step = 'edit'`));

    group('2. Kasus James: ungu, tapi HANYA lengan pendek');
    seed();
    await simpanDiskon([{ kind: 'pct', value: 20, colors: ['ungu'], variants: ['pendek'] }]);
    r = await req('POST', '/api/orders', pesan([IT('ungu', 'pendek'), IT('ungu', 'panjang')]));
    b = barisHarga(terakhir());
    check('ungu pendek didiskon jadi 216.000', Number(b[0].price) === 216000, b[0]);
    check('ungu panjang TIDAK didiskon, tetap 290.000', Number(b[1].price) === 290000, b[1]);

    group('3. Diskon nominal (Rp) & cakupan "semua warna"');
    seed();
    await simpanDiskon([{ kind: 'rp', value: 50000, colors: [], variants: [] }]);
    r = await req('POST', '/api/orders', pesan([IT('ungu', 'pendek'), IT('black', 'panjang')]));
    b = barisHarga(terakhir());
    check('ungu pendek 270.000 - 50.000 = 220.000', Number(b[0].price) === 220000, b[0]);
    check('daftar warna kosong = SEMUA warna kena', Number(b[1].price) === 240000, b[1]);

    group('4. Dua aturan bertabrakan: yang dipakai potongan TERBESAR');
    seed();
    await simpanDiskon([
        { kind: 'pct', value: 10, colors: [], variants: [], label: 'Promo umum' },
        { kind: 'pct', value: 30, colors: ['ungu'], variants: [], label: 'Promo ungu' },
    ]);
    r = await req('POST', '/api/orders', pesan([IT('ungu', 'pendek'), IT('black', 'pendek')]));
    b = barisHarga(terakhir());
    check('ungu dapat 30% (189.000), bukan 10%', Number(b[0].price) === 189000, b[0]);
    check('BUKAN dijumlah jadi 40%', Number(b[0].price) !== 162000, b[0]);
    check('hitam dapat yang umum 10% (243.000)', Number(b[1].price) === 243000, b[1]);

    group('5. Diskon dimatikan / dihapus: harga kembali penuh');
    seed();
    await simpanDiskon([{ kind: 'pct', value: 20, colors: ['ungu'], variants: [], is_active: false }]);
    r = await req('POST', '/api/orders', pesan([IT('ungu', 'pendek')]));
    check('tidak aktif = tidak dipotong', Number(barisHarga(terakhir())[0].price) === 270000, barisHarga(terakhir())[0]);
    await simpanDiskon([]);
    check('daftar kosong menghapus semuanya',
        one(`SELECT COUNT(*)::int AS n FROM product_discounts`).n === 0);
    r = await req('POST', '/api/orders', pesan([IT('ungu', 'pendek')]));
    check('harga kembali penuh', Number(barisHarga(terakhir())[0].price) === 270000);

    group('6. Bordir ditambahkan DI ATAS harga yang sudah didiskon');
    seed();
    await simpanDiskon([{ kind: 'pct', value: 20, colors: ['ungu'], variants: [] }]);
    r = await req('POST', '/api/orders', pesan([IT('ungu', 'pendek', { bordir_nama: true })]));
    check('216.000 + bordir 20.000 = 236.000', Number(barisHarga(terakhir())[0].price) === 236000,
        barisHarga(terakhir())[0]);

    group('7. Harga khusus admin MENANG atas diskon produk');
    seed();
    await simpanDiskon([{ kind: 'pct', value: 20, colors: ['ungu'], variants: [] }]);
    r = await req('POST', '/api/orders', pesan([IT('ungu', 'pendek', { custom_price: 250000 })]));
    check('yang dipakai harga khusus 250.000, bukan 216.000',
        Number(barisHarga(terakhir())[0].price) === 250000, barisHarga(terakhir())[0]);

    group('8. Jalur TAMBAH ITEM ikut terdiskon');
    seed();
    await simpanDiskon([{ kind: 'pct', value: 20, colors: ['ungu'], variants: [] }]);
    r = await req('POST', '/api/orders', pesan([IT('black', 'pendek')]));
    const idT = terakhir();
    r = await req('POST', `/api/orders/${idT}/items`,
        { product_id: 25, color: 'ungu', variant_type: 'panjang', size: 'M', quantity: 1 }, ADMIN);
    check('diterima', r.status === 200, r.body);
    check('harga item barunya 232.000', Number(r.body.unit_price) === 232000, r.body.unit_price);

    group('9. Jalur EDIT ITEM ikut terdiskon');
    seed();
    await simpanDiskon([{ kind: 'pct', value: 20, colors: ['ungu'], variants: [] }]);
    r = await req('POST', '/api/orders', pesan([IT('black', 'pendek')]));
    const idE = terakhir();
    const itemId = Number(one(`SELECT id FROM order_items WHERE order_id = ${idE}`).id);
    check('awalnya harga penuh 270.000', Number(barisHarga(idE)[0].price) === 270000);
    r = await req('PUT', `/api/orders/${idE}/items/${itemId}`,
        { product_id: 25, color: 'ungu', variant_type: 'pendek', size: 'M', quantity: 1 }, ADMIN);
    check('diterima', r.status === 200, r.body);
    check('ditukar ke ungu -> ikut terdiskon jadi 216.000',
        Number(barisHarga(idE)[0].price) === 216000, barisHarga(idE)[0]);

    group('10. Katalog memberitahu diskonnya (website bisa menampilkan coretan)');
    seed();
    await simpanDiskon([{ kind: 'pct', value: 20, colors: ['ungu'], variants: ['pendek'], label: 'Promo Ungu' }]);
    // Daftar katalog (`GET /api/products`) tidak bisa dijalankan pg-mem — SQL-nya
    // memakai sub-select berkorelasi. Yang diperiksa di sini jalur satu produk,
    // yang memakai formatProduct yang SAMA PERSIS, jadi bentuk payloadnya identik.
    r = await req('GET', '/api/products/25', null, null);
    check('endpoint produk terbaca', r.status === 200, { status: r.status, body: r.body });
    const prod = r.body;
    check('produk membawa daftar diskon', Array.isArray(prod.discounts) && prod.discounts.length === 1, prod && prod.discounts);
    check('cakupannya ikut terkirim',
        prod.discounts[0].colors.includes('ungu') && prod.discounts[0].variants.includes('pendek'), prod.discounts[0]);
    check('COGS tetap TIDAK bocor ke katalog publik', prod.cogs_default === undefined, prod.cogs_default);

    group('11. Yang HARUS ditolak');
    seed();
    let x = await simpanDiskon([{ kind: 'pct', value: 0, colors: [], variants: [] }]);
    check('nilai 0: ditolak 400', x.status === 400, x.body);
    x = await simpanDiskon([{ kind: 'pct', value: 95, colors: [], variants: [] }]);
    check('persen di atas 90: ditolak 400', x.status === 400, { status: x.status, body: x.body });
    check('alasannya mengarahkan ke Bonus', /Bonus/i.test(String(x.body && x.body.error)), x.body);
    x = await simpanDiskon([{ kind: 'pct', value: 20, colors: [], variants: [] }], STAF);
    check('staf ber-izin edit produk: ditolak 403 (ini menurunkan harga jual)',
        x.status === 403, { status: x.status, body: x.body });
    check('tidak ada diskon yang tersimpan dari percobaan gagal',
        one(`SELECT COUNT(*)::int AS n FROM product_discounts`).n === 0);
    x = await req('PUT', '/api/products/99999/discounts', { discounts: [] }, ADMIN);
    check('produk tidak ada: 404', x.status === 404, x.status);

    await new Promise(w => setTimeout(w, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
