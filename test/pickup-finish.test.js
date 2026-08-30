// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — PUT /api/orders/:id/status, jalur pickup "confirmed → done"
//
//   Jalankan:  npm test     (atau: node test/run-all.js pickup-finish)
//
// Order berkurir "Diambil di event / walkin" melompati Kemas & Kirim. Lompatan
// itu biasanya terjadi OTOMATIS saat konfirmasi bayar. Tapi kalau kurirnya baru
// dibetulkan jadi pickup SESUDAH order dikonfirmasi, statusnya tertinggal di
// 'confirmed' — dan `STATUS_FORWARD.confirmed` kosong, jadi tombol "Tandai
// Diambil & Selesai" ditolak dengan "Transisi tidak diizinkan".
//
// Bug nyata 30 Agustus 2026 (WS-20260830-8811): admin tak sengaja memilih
// "Free Ongkir", membetulkannya lewat Edit Pesanan, lalu ordernya tidak bisa
// diselesaikan sama sekali. Tombolnya sudah lama ada di UI dan menyebut dirinya
// "fallback untuk order lama" — padahal backend tidak pernah mengizinkannya,
// jadi tombol itu belum pernah benar-benar berfungsi.
//
// Yang dijaga di sini:
//  1. pickup + confirmed + lunas  -> boleh selesai
//  2. kurir NON-pickup             -> TETAP ditolak (jangan jadi pintu belakang
//     yang melewati Kemas & Kirim untuk order kirim biasa)
//  3. PO katalog belum dipenuhi    -> ditolak; barangnya belum ada, mustahil
//     sudah diambil. Gate ini disamakan dengan jalur auto-skip confirm-payment.
//  4. item custom ikut ditandai siap, supaya barisnya tidak nyangkut selamanya
//     di menu Pre-Order.
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const { boot, api, one, many, none, check, group, finish } = require('./_bootstrap');

const PICKUP = 'Diambil di event / walkin';

// 920 pickup, lunas, barang biasa           -> boleh selesai
// 921 kurir J&T biasa                        -> harus tetap ditolak
// 922 pickup TAPI ada PO katalog belum ready -> harus ditolak
// 923 pickup + item custom belum ditandai siap
function seed() {
    none(`DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM orders;
          DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
      (1, 'CLK', 'Clicker Tooth Smile', 'aksesoris', 50000, 20000, TRUE);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source) VALUES
      (920, 'WS-PU-920', 'Dina',  '081234567890', '-', 100000, 'paid', 'confirmed', 0, '${PICKUP}', 'whatsapp'),
      (921, 'WS-PU-921', 'Rina',  '081234567891', '-', 100000, 'paid', 'confirmed', 20000, 'J&T',    'whatsapp'),
      (922, 'WS-PU-922', 'Sinta', '081234567892', '-', 100000, 'paid', 'confirmed', 0, '${PICKUP}', 'whatsapp'),
      (923, 'WS-PU-923', 'Tina',  '081234567893', '-', 100000, 'paid', 'confirmed', 0, '${PICKUP}', 'whatsapp'),
      (924, 'WS-PU-924', 'Uni',   '081234567894', '-', 100000, 'pending', 'confirmed', 0, '${PICKUP}', 'whatsapp');
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price,
                             is_po, po_fulfilled, is_custom_size, is_custom_product) VALUES
      (920, 920, 1, 'One Size', 'merah', 'null', 2, 50000, FALSE, FALSE, FALSE, FALSE),
      (921, 921, 1, 'One Size', 'merah', 'null', 2, 50000, FALSE, FALSE, FALSE, FALSE),
      (922, 922, 1, 'One Size', 'merah', 'null', 2, 50000, TRUE,  FALSE, FALSE, FALSE),
      (923, 923, 1, 'One Size', 'merah', 'null', 2, 50000, FALSE, FALSE, TRUE,  FALSE),
      (924, 924, 1, 'One Size', 'merah', 'null', 2, 50000, FALSE, FALSE, FALSE, FALSE);
    `);
}

const selesaikan = (id) => api('PUT', `/api/orders/${id}/status`, { order_status: 'done' });
const status = (id) => one(`SELECT order_status FROM orders WHERE id = ${id}`).order_status;

async function run() {
    await boot(4721);

    group('1. Pickup yang statusnya tertinggal di confirmed bisa diselesaikan');
    seed();
    let r = await selesaikan(920);
    check('permintaan diterima', r.status === 200, r.body);
    check('status jadi done', status(920) === 'done', status(920));
    check('tercatat di timeline',
        many(`SELECT id FROM order_photos WHERE order_id = 920 AND step = 'done'`).length === 1);

    group('2. Kurir biasa TETAP ditolak — jangan jadi pintu belakang lewat Kemas & Kirim');
    seed();
    r = await selesaikan(921);
    check('ditolak 400', r.status === 400, r.body);
    check('pesannya soal transisi',
        String(r.body && r.body.error).includes('Transisi tidak diizinkan'), r.body);
    check('status tidak berubah', status(921) === 'confirmed', status(921));

    group('3. PO katalog belum ready: barangnya belum ada, mustahil sudah diambil');
    seed();
    r = await selesaikan(922);
    check('ditolak 409', r.status === 409, r.body);
    check('pesannya menyebut Pre-Order',
        String(r.body && r.body.error).toLowerCase().includes('pre-order'), r.body);
    check('status tidak berubah', status(922) === 'confirmed', status(922));

    group('4. Item custom ikut ditandai siap, tidak nyangkut di menu Pre-Order');
    seed();
    r = await selesaikan(923);
    check('permintaan diterima', r.status === 200, r.body);
    check('status jadi done', status(923) === 'done', status(923));
    check('item custom jadi po_fulfilled',
        one('SELECT po_fulfilled FROM order_items WHERE id = 923').po_fulfilled === true,
        one('SELECT po_fulfilled FROM order_items WHERE id = 923').po_fulfilled);

    group('5. Belum lunas tidak boleh diselesaikan');
    seed();
    r = await selesaikan(924);
    check('ditolak 400', r.status === 400, r.body);
    check('pesannya soal pelunasan',
        String(r.body && r.body.error).toLowerCase().includes('lunas'), r.body);
    check('status tidak berubah', status(924) === 'confirmed', status(924));

    // Jeda sebelum process.exit() di finish() — lihat catatan di route-order.test.js.
    await new Promise(r2 => setTimeout(r2, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
