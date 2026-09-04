// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — GET /api/inventory/movements (riwayat pergerakan stok)
//
//   Jalankan:  npm test     (atau: node test/run-all.js inventory-movements)
//
// Layar Riwayat di menu Inventory. Datanya sudah lama ada di `stock_movements`;
// yang baru adalah cara membacanya sebagai satu daftar berurutan waktu.
//
// Yang dijaga di sini:
//
//  1. **Rutenya tidak boleh tertangkap `/api/inventory/:product_id`.** Ini kelas
//     bug yang persis bikin `/api/refunds/stats` mati diam-diam (29 Agu). Kalau
//     urutan pendaftarannya tergeser, /movements akan dibaca sebagai
//     product_id = "movements".
//
//  2. **Pengelompokan jenis.** 11 nama teknis movement_type dikelompokkan jadi 4
//     laci (masuk / jual / koreksi / retur). Salah taruh satu jenis = admin
//     menyimpulkan barang tidak pernah masuk padahal ada.
//
//  3. **"Terakhir barang masuk" TIDAK ikut filter.** Itu jawaban atas pertanyaan
//     yang jadi alasan layar ini dibuat, jadi harus tetap benar walau admin
//     sedang membuka laci Penjualan.
//
//  4. **Batas tanggal atas inklusif sampai akhir hari.** created_at bertipe
//     timestamp; `<= '2026-08-31'` akan membuang seluruh pergerakan hari itu.
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, none, check, group, finish } = require('./_bootstrap');

const PORT = 4722;
const BASE = `http://localhost:${PORT}`;
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, 'harness_secret', { expiresIn: '1h' });

async function get(path) {
    const res = await fetch(BASE + path, {
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'connection': 'close' },
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
}

function seed() {
    none(`DELETE FROM stock_movements; DELETE FROM order_items; DELETE FROM orders;
          DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
      (1, 'CLK', 'Clicker Tooth Smile', 'aksesoris', 50000, 20000, TRUE),
      (2, 'MIN', 'Minna', 'tops', 290000, 130000, TRUE);
    INSERT INTO stock_movements (id, product_id, size, color, variant_type, movement_type,
                                 quantity_change, quantity_before, quantity_after, note, admin_user, created_at) VALUES
      (1, 1, 'One Size', 'merah', 'null', 'receive',        10, 0, 10, 'Terima stok baru', 'admin',  '2026-08-10 09:00:00'),
      (2, 2, 'M', 'black', 'pendek',      'order_out',      -2, 10, 8, 'Order keluar',     'admin',  '2026-08-12 10:00:00'),
      (3, 2, 'M', 'black', 'pendek',      'manual_set',      3, 8, 11, 'Koreksi hitung',   'james',  '2026-08-20 11:00:00'),
      (4, 1, 'One Size', 'merah', 'null', 'order_cancel_restore', 2, 8, 10, 'Order batal',  'admin',  '2026-08-25 12:00:00'),
      (5, 1, 'One Size', 'pink',  'null', 'receive',        12, 0, 12, 'Terima stok baru', 'james',  '2026-08-28 13:00:00'),
      (6, 2, 'L', 'black', 'panjang',     'order_out',      -1, 5, 4,  'Order keluar',     'admin',  '2026-08-31 08:00:00');
    `);
}

const q = (qs) => get('/api/inventory/movements' + (qs ? '?' + qs : ''));
const idsOf = (b) => (b.rows || []).map(r => r.id);

async function run() {
    await boot(PORT);
    seed();

    group('1. Rutenya tidak tertangkap /api/inventory/:product_id');
    let r = await q('');
    check('balas 200', r.status === 200, r.body);
    check('bentuknya daftar riwayat, bukan daftar inventory',
        r.body && Array.isArray(r.body.rows) && typeof r.body.total === 'number', r.body);

    group('2. Tanpa filter: seluruh pergerakan, terbaru dulu');
    check('6 baris', idsOf(r.body).length === 6, idsOf(r.body));
    check('urut terbaru dulu', JSON.stringify(idsOf(r.body)) === JSON.stringify([6, 5, 4, 3, 2, 1]), idsOf(r.body));
    check('total ikut dikirim', r.body.total === 6, r.body.total);
    check('nama produk ikut', r.body.rows[0].product_name === 'Minna', r.body.rows[0]);

    group('3. Laci Barang Masuk');
    r = await q('jenis=masuk');
    check('hanya baris receive', JSON.stringify(idsOf(r.body)) === JSON.stringify([5, 1]), idsOf(r.body));

    group('4. Laci Penjualan');
    r = await q('jenis=jual');
    check('hanya baris order_out', JSON.stringify(idsOf(r.body)) === JSON.stringify([6, 2]), idsOf(r.body));

    group('5. Laci Koreksi');
    r = await q('jenis=koreksi');
    check('hanya baris manual_set', JSON.stringify(idsOf(r.body)) === JSON.stringify([3]), idsOf(r.body));

    group('6. Laci Retur & Batal');
    r = await q('jenis=retur');
    check('hanya baris order_cancel_restore', JSON.stringify(idsOf(r.body)) === JSON.stringify([4]), idsOf(r.body));

    group('7. Jenis ngawur ditolak, bukan diam-diam menampilkan semuanya');
    r = await q('jenis=ngasal');
    check('ditolak 400', r.status === 400, r.body);

    group('8. "Terakhir barang masuk" TIDAK ikut filter');
    // Inilah pertanyaan yang jadi alasan layar ini dibuat. Kalau ikut filter,
    // membuka laci Penjualan akan menjawab "tidak pernah ada barang masuk".
    r = await q('jenis=jual');
    check('tetap terisi walau sedang melihat Penjualan', !!r.body.last_receive, r.body.last_receive);
    check('menunjuk receive TERBARU (28 Agu, oleh james)',
        r.body.last_receive && r.body.last_receive.admin_user === 'james'
        && String(r.body.last_receive.product_name) === 'Clicker Tooth Smile',
        r.body.last_receive);

    group('9. Batas tanggal atas inklusif sampai akhir hari');
    // Baris 6 terjadi 31 Agu 08:00. Kalau batas atas dipakai apa adanya sebagai
    // tengah malam, baris itu akan hilang tanpa jejak.
    r = await q('from=2026-08-31&to=2026-08-31');
    check('pergerakan 31 Agu ikut terbawa', JSON.stringify(idsOf(r.body)) === JSON.stringify([6]), idsOf(r.body));

    group('10. Rentang tanggal + jenis dipakai bersama');
    r = await q('jenis=masuk&from=2026-08-20&to=2026-08-31');
    check('hanya receive 28 Agu', JSON.stringify(idsOf(r.body)) === JSON.stringify([5]), idsOf(r.body));

    group('11. Halaman: limit & offset');
    r = await q('limit=2');
    check('2 baris pertama', JSON.stringify(idsOf(r.body)) === JSON.stringify([6, 5]), idsOf(r.body));
    check('total tetap 6 (bukan jumlah di halaman ini)', r.body.total === 6, r.body.total);
    r = await q('limit=2&offset=2');
    check('halaman kedua', JSON.stringify(idsOf(r.body)) === JSON.stringify([4, 3]), idsOf(r.body));

    group('12. Saring per produk');
    r = await q('product_id=1');
    check('hanya produk 1', JSON.stringify(idsOf(r.body)) === JSON.stringify([5, 4, 1]), idsOf(r.body));

    // Jeda sebelum process.exit() di finish() — lihat catatan di route-order.test.js.
    await new Promise(x => setTimeout(x, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
