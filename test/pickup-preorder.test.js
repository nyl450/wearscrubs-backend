// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — pickup/walk-in + antrean Pre-Order
//
// Latar (kasus WS-20260817-3137 "Nini"): pesanan pickup melompati tahap Kemas &
// Kirim — begitu pembayaran dikonfirmasi langsung 'done'. Padahal gate item custom
// (po_fulfilled) normalnya baru lepas di tahap Kemas. Akibatnya baris custom
// nyangkut SELAMANYA di menu Pre-Order, dan tombol "Tandai Siap" ditolak karena
// pesanannya sudah selesai. Buntu, tanpa jalan keluar dari UI.
//
// Yang dijaga tes ini:
//   - pickup + item custom  -> ikut ditandai siap saat bayar (barang diserahkan di tempat)
//   - pickup + PO katalog   -> TIDAK auto-'done' (barangnya memang belum ada)
//   - antrean Pre-Order     -> tidak menampilkan pesanan yang sudah selesai/dikirim
// ═══════════════════════════════════════════════════════════════════════════════
const { boot, api, one, many, none, check, group, finish } = require('./_bootstrap');

const PICKUP = 'Diambil di event / walkin';

// itemKind: 'custom' (custom size, tanpa stok) | 'po' (PO katalog) | 'biasa'
function seed(kind, courier = PICKUP) {
    none(`DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM stock_movements;
          DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, is_active) VALUES
      (1, 'ALX', 'Alex SS', 'tops', 245000, TRUE);
    INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES
      (1, 'M', 'black', 'pendek', 5);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source, payment_method) VALUES
      (900, 'WS-TEST-PICKUP', 'Nini', '0811', 'Ambil di event', 290000, 'pending', 'waiting_payment',
       0, '${courier}', 'whatsapp', 'Bonus/Free');
    `);
    const flags = kind === 'custom' ? 'TRUE, FALSE' : kind === 'po' ? 'FALSE, TRUE' : 'FALSE, FALSE';
    const qty = kind === 'po' ? 99 : 1;     // PO katalog: qty melebihi stok
    none(`INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price,
                                   is_custom_size, is_po, po_fulfilled)
          VALUES (700, 900, 1, 'M', 'black', 'pendek', ${qty}, 290000, ${flags}, FALSE);`);
}

const item = () => one('SELECT * FROM order_items WHERE id = 700');
const order = () => one('SELECT * FROM orders WHERE id = 900');
const payNow = () => api('PUT', '/api/orders/900/confirm-payment');
const preOrderCodes = async () => (await api('GET', '/api/pre-orders')).body.map(r => r.order_code);

async function run() {
    await boot(4713);

    group('1. Pickup + item custom: bayar -> selesai DAN item ikut ditandai siap');
    seed('custom');
    let r = await payNow();
    check('konfirmasi bayar sukses', r.status === 200, r.body);
    check('pesanan langsung selesai', order().order_status === 'done', order().order_status);
    check('item custom ditandai siap', item().po_fulfilled === true, item().po_fulfilled);
    check('tidak nyangkut di antrean Pre-Order', !(await preOrderCodes()).includes('WS-TEST-PICKUP'), await preOrderCodes());

    group('2. Sebelum bayar, item custom memang MASIH di antrean (kontrol)');
    seed('custom');
    check('muncul di antrean', (await preOrderCodes()).includes('WS-TEST-PICKUP'), await preOrderCodes());
    check('belum ditandai siap', item().po_fulfilled === false, item().po_fulfilled);

    group('3. Pickup + PO katalog: TIDAK auto-selesai (barang belum ada)');
    seed('po');
    r = await payNow();
    check('konfirmasi bayar sukses', r.status === 200, r.body);
    check("status ditahan di 'confirmed'", order().order_status === 'confirmed', order().order_status);
    check('PO belum ditandai siap', item().po_fulfilled === false, item().po_fulfilled);
    check('tetap ada di antrean Pre-Order', (await preOrderCodes()).includes('WS-TEST-PICKUP'), await preOrderCodes());
    check('stok tidak dipotong untuk PO', one(`SELECT stock FROM inventory WHERE product_id=1`).stock === 5, 'stok');

    group('4. Kurir biasa (bukan pickup) tidak ikut aturan ini');
    seed('custom', 'J&T');
    r = await payNow();
    check('konfirmasi bayar sukses', r.status === 200, r.body);
    check("status jadi 'confirmed', bukan 'done'", order().order_status === 'confirmed', order().order_status);
    check('item custom TIDAK otomatis siap (dilepas di tahap Kemas)', item().po_fulfilled === false, item().po_fulfilled);
    check('masih di antrean Pre-Order', (await preOrderCodes()).includes('WS-TEST-PICKUP'), await preOrderCodes());

    group('5. Antrean Pre-Order menyaring pesanan yang sudah tamat');
    for (const st of ['done', 'shipped', 'cancelled']) {
        seed('custom');
        none(`UPDATE orders SET order_status = '${st}' WHERE id = 900`);
        check(`status '${st}' tidak muncul di antrean`, !(await preOrderCodes()).includes('WS-TEST-PICKUP'), await preOrderCodes());
    }
    seed('custom');
    none(`UPDATE orders SET order_status = 'confirmed' WHERE id = 900`);
    check("status 'confirmed' tetap muncul", (await preOrderCodes()).includes('WS-TEST-PICKUP'), await preOrderCodes());

    group('6. Pickup + item biasa: stok tetap dipotong seperti biasa');
    seed('biasa');
    const stokAwal = one(`SELECT stock FROM inventory WHERE product_id=1`).stock;
    r = await payNow();
    check('konfirmasi bayar sukses', r.status === 200, r.body);
    check('pesanan selesai', order().order_status === 'done', order().order_status);
    // Angka hasilnya TIDAK diperiksa: pg-mem menghitung `stock - $1` terbalik
    // (lihat catatan di _bootstrap.js). Yang diperiksa: baris stoknya memang
    // tersentuh, dan log pergerakan mencatat -1 untuk varian yang benar --
    // angka di log dihitung di JS, jadi sahih.
    const st6 = one(`SELECT stock FROM inventory WHERE product_id=1`).stock;
    const mv6 = many(`SELECT movement_type, quantity_change, size, color, variant_type FROM stock_movements WHERE order_id=900`);
    check('baris stok tersentuh', st6 !== stokAwal, { awal: stokAwal, akhir: st6 });
    check('log stok: order_out -1 di varian yang benar',
        mv6.length === 1 && mv6[0].movement_type === 'order_out' && mv6[0].quantity_change === -1
        && mv6[0].size === 'M' && mv6[0].color === 'black' && mv6[0].variant_type === 'pendek', mv6);

    finish();
}

run().catch(e => { console.error('ERROR:', e && e.message); process.exit(2); });
