// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — Harga Khusus baris katalog di Kasir (POST /api/orders)
//
//   Jalankan:  npm test     (atau: node test/run-all.js harga-khusus)
//
// Event Bali Sept 2026: tim & istri sering menjual aksesoris di bawah harga
// katalog. Dulu satu-satunya jalan adalah item custom (yang tidak memotong
// stok) — salah kaprah. Sekarang baris katalog boleh membawa custom_price > 0
// dan backend memakainya sebagai harga dasar.
//
// Yang dijaga di sini:
//  1. Admin + custom_price > 0 pada baris katalog -> harga baris = harga khusus,
//     stok tetap dicek (bukan jadi custom), total ikut.
//  2. custom_price 0 / kosong -> harga katalog (jangan jadi gratis; gratis = is_bonus).
//  3. Pemanggil PUBLIK (website) yang mengirim custom_price -> DIABAIKAN. Ini
//     pintu anti-tamper yang paling penting: orang bisa mengirim JSON apa saja.
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4725;
const BASE = `http://localhost:${PORT}`;
const ADMIN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, 'harness_secret', { expiresIn: '1h' });
async function post(body, token) {
    const headers = { 'Content-Type': 'application/json', 'connection': 'close' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(BASE + '/api/orders', { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    let b; try { b = JSON.parse(text); } catch { b = text; }
    return { status: res.status, body: b };
}
function seed() {
    none(`DELETE FROM order_items; DELETE FROM stock_movements; DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;`);
    none(`INSERT INTO products (id, sku, name, category, price, cogs_default, is_active, status) VALUES (7, 'CLK', 'Clicker Tooth Smile', 'aksesoris', 50000, 20000, TRUE, 'active');
          INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES (7, 'One Size', 'merah', 'null', 10);`);
}
const pesanan = (customPrice, extra = {}) => ({
    customer_name: 'Ayu', customer_phone: '081234567890', customer_address: 'Jl. Mawar', shipping_cost: 0,
    shipping_courier: 'J&T', order_source: 'whatsapp', payment_method: 'BCA',
    items: [{ product_id: 7, size: 'One Size', color: 'merah', variant_type: 'null', quantity: 2, custom_price: customPrice, ...extra }],
});
const barisTerakhir = () => one('SELECT price, is_custom_size, quantity FROM order_items ORDER BY id DESC LIMIT 1');
const orderTerakhir = () => one('SELECT total_amount FROM orders ORDER BY id DESC LIMIT 1');

async function run() {
    await boot(PORT);

    group('1. Admin: harga khusus 40.000 dipakai, baris tetap katalog');
    seed();
    let r = await post(pesanan(40000), ADMIN);
    check('201/200', r.status === 200 || r.status === 201, r.body);
    let b = barisTerakhir();
    check('harga baris 40.000', b && b.price === 40000, b);
    check('bukan custom (stok tetap dikelola)', b && b.is_custom_size === false, b);
    check('total 2 x 40.000', orderTerakhir().total_amount === 80000, orderTerakhir());

    group('2. custom_price 0 / kosong -> harga katalog');
    seed();
    r = await post(pesanan(0), ADMIN);
    check('harga katalog 50.000 (0 bukan gratis)', barisTerakhir().price === 50000, barisTerakhir());
    seed();
    r = await post(pesanan(undefined), ADMIN);
    check('harga katalog 50.000 (kosong)', barisTerakhir().price === 50000, barisTerakhir());

    group('3. Publik mengirim custom_price -> diabaikan (anti-tamper)');
    seed();
    // force_new melewati guard duplikat (SQL-nya memakai INTERVAL yang tidak
    // bisa dijalankan pg-mem); tidak mengubah jalur harga yang diuji.
    r = await post({ ...pesanan(1000), order_source: 'website', force_new: true }, null);
    check('order diterima', r.status === 200 || r.status === 201, r.body);
    check('harga tetap katalog 50.000', barisTerakhir().price === 50000, barisTerakhir());

    await new Promise(x => setTimeout(x, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
