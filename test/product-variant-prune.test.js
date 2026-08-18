// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — PUT /api/products/:id (pembersihan varian hantu)
//
// Latar: dulu update produk HANYA menambah baris, tidak pernah menghapus. Warna /
// variant / size yang dicabut dari detail produk tetap tertinggal di `inventory`
// dan `product_variants`, lalu muncul sebagai warna hantu di menu Inventory,
// dropdown Kasir, dan swatch halaman produk (kasus "Mini clicker tooth package").
//
// Aturannya sekarang: kombinasi yang tidak lagi dipilih ikut dihapus, TAPI hanya
// yang stoknya benar-benar kosong. Yang masih ada stoknya sengaja dibiarkan dan
// dikembalikan sebagai peringatan — supaya angka stok tidak hilang diam-diam.
// ═══════════════════════════════════════════════════════════════════════════════
const { boot, api, one, many, none, check, group, finish } = require('./_bootstrap');

function seed() {
    none(`DELETE FROM inventory; DELETE FROM product_variants; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, price_by_type, sizes, colors, types, status, is_active) VALUES
      (1, 'CLK', 'Mini clicker', 'aksesoris', 45000, NULL, '["One Size"]', '["putih","pink","hitam"]', '["clicker"]', 'active', TRUE);
    INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES
      (1, 'One Size', 'putih', 'clicker', 3, 0),
      (1, 'One Size', 'pink',  'clicker', 0, 0),
      (1, 'One Size', 'hitam', 'clicker', 0, 0);
    INSERT INTO product_variants (product_id, color, variant_type, photo_url, slot) VALUES
      (1, 'putih', 'clicker', NULL, 1),
      (1, 'pink',  'clicker', NULL, 1),
      (1, 'hitam', 'clicker', NULL, 1);
    `);
}

// Kirim form update produk. Field wajib mengikuti apa yang dibaca endpoint.
const updateProduct = (colors, extra = {}) => api('PUT', '/api/products/1', {
    name: 'Mini clicker', category: 'aksesoris', price: 45000, sku: 'CLK', status: 'active',
    sizes: JSON.stringify(['One Size']), colors: JSON.stringify(colors),
    types: JSON.stringify(['clicker']), photo_map: '{}', ...extra
});

const invColors = () => many(`SELECT color FROM inventory WHERE product_id = 1`).map(r => r.color).sort();
const varColors = () => many(`SELECT color FROM product_variants WHERE product_id = 1`).map(r => r.color).sort();

async function run() {
    await boot(4712);

    group('1. Warna dicabut, stoknya kosong -> baris hantu ikut terhapus');
    seed();
    let r = await updateProduct(['putih']);
    check('status 200', r.status === 200, r);
    check('inventory tinggal putih', JSON.stringify(invColors()) === JSON.stringify(['putih']), invColors());
    check('product_variants tinggal putih', JSON.stringify(varColors()) === JSON.stringify(['putih']), varColors());
    check('stok putih tidak berubah (3)', one(`SELECT stock FROM inventory WHERE color='putih'`).stock === 3, 'stok');
    check('tanpa peringatan', !r.body.warning, r.body);

    group('2. Warna dicabut TAPI masih ada stok -> ditahan + diberi peringatan');
    seed();
    none(`UPDATE inventory SET stock = 4 WHERE color = 'pink'`);
    r = await updateProduct(['putih']);
    check('status 200', r.status === 200, r);
    check('pink TIDAK dihapus (stok 4)', invColors().includes('pink'), invColors());
    check('hitam tetap dihapus (stok 0)', !invColors().includes('hitam'), invColors());
    check('ada peringatan menyebut pink', /pink/.test(r.body.warning || ''), r.body.warning);
    check('product_variants pink ikut ditahan', varColors().includes('pink'), varColors());

    group('3. Stok reject juga menahan penghapusan');
    seed();
    none(`UPDATE inventory SET stock = 0, stock_reject = 2 WHERE color = 'pink'`);
    r = await updateProduct(['putih']);
    check('pink ditahan karena ada stok reject', invColors().includes('pink'), invColors());
    check('peringatan menyebut reject', /reject/i.test(r.body.warning || ''), r.body.warning);

    group('4. Tidak ada yang dicabut -> tidak ada yang terhapus');
    seed();
    r = await updateProduct(['putih', 'pink', 'hitam']);
    check('ketiga warna tetap ada', invColors().length === 3, invColors());
    check('tanpa peringatan', !r.body.warning, r.body);

    group('5. Warna baru ditambah -> barisnya dibuat, yang lama tetap');
    seed();
    r = await updateProduct(['putih', 'pink', 'hitam', 'merah']);
    check('merah punya baris inventory', invColors().includes('merah'), invColors());
    check('stok merah mulai dari 0', one(`SELECT stock FROM inventory WHERE color='merah'`).stock === 0, 'stok merah');
    check('stok putih tetap 3 (tidak di-reset)', one(`SELECT stock FROM inventory WHERE color='putih'`).stock === 3, 'stok putih');

    group('6. Butuh izin edit menu produk');
    seed();
    r = await updateProduct(['putih'], {});
    const noAuth = await api('PUT', '/api/products/1', { name: 'x' }, null);
    check('tanpa token ditolak', noAuth.status === 401, noAuth);

    finish();
}

run().catch(e => { console.error('ERROR:', e && e.message); process.exit(2); });
