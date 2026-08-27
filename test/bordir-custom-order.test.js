// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — urutan JAHIT dulu, baru BORDIR
//
//   Jalankan:  npm test        atau  node test/run-all.js bordir-custom
//
// Bordir dijahit DI ATAS garmennya, jadi tidak ada yang bisa dibordir sebelum
// garmennya jadi. Untuk item custom (dijahit dari nol) itu berarti: "Tandai
// Bordir Selesai" harus ditolak selama masih ada item custom yang belum
// ditandai siap.
//
// Ini pernah salah: endpoint bordir-done dulu HANYA memeriksa PO katalog
// (`is_po`), custom sengaja dilewati dengan alasan bisa dikerjakan paralel.
// Akibatnya WS-WA-20260824-8914 masuk fase bordir padahal 6 item customnya
// belum dijahit sama sekali. Diperbaiki 27 Agu 2026 atas permintaan James.
//
// Yang dijaga di sini:
//   1. Custom belum siap  -> bordir-done DITOLAK, status tidak bergeser
//   2. PO katalog belum siap -> tetap DITOLAK (aturan lama jangan ikut hilang)
//   3. Semua custom siap  -> bordir-done DITERIMA, status pindah ke 'confirmed'
//   4. Gate lama (approval bordir) tidak ikut longgar
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, none, check, group, finish } = require('./_bootstrap');

const PORT = 4716;
const BASE = `http://localhost:${PORT}`;
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, 'harness_secret', { expiresIn: '1h' });

// bordir-done memakai multipart (upload.single) tapi fotonya opsional. Dikirim
// urlencoded seperti helper harness lain: multer melewatkan request non-multipart
// dan express.urlencoded yang mengisi req.body.
async function bordirDone(orderId, note) {
    const res = await fetch(`${BASE}/api/orders/${orderId}/bordir-done`, {
        method: 'PUT',
        headers: {
            'Authorization': 'Bearer ' + TOKEN,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ note: note || 'uji otomatis' }).toString(),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
}

const statusOf = (id) => one(`SELECT order_status FROM orders WHERE id = ${id}`).order_status;

// custom = item custom product belum siap; po = item PO katalog belum siap
function seed({ custom = 0, po = 0, bordirStatus = 'approved' } = {}) {
    none(`DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM stock_movements;
          DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
      (1, 'ALX', 'Alex SS', 'tops', 245000, 120000, TRUE);
    INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES
      (1, 'M', 'black', 'pendek', 5);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address,
                        total_amount, payment_status, order_status, shipping_cost,
                        shipping_courier, order_source, bordir_status,
                        has_bordir_nama, additional_amount_due) VALUES
      (999, 'WS-TEST-CUSTOM', 'Uji Coba', '0811', 'Alamat uji', 500000, 'paid', 'bordir',
       0, 'J&T', 'whatsapp', '${bordirStatus}', TRUE, 0);
    -- item katalog biasa yang memang dibordir, selalu ada
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity,
                             price, bordir_nama) VALUES
      (501, 999, 1, 'M', 'black', 'pendek', 1, 265000, TRUE);
    `);
    for (let i = 0; i < custom; i++) {
        none(`INSERT INTO order_items (id, order_id, product_id, size, color, variant_type,
                                       quantity, price, bordir_nama, is_custom_product,
                                       custom_product_name, custom_product_category, po_fulfilled)
              VALUES (${600 + i}, 999, NULL, 'L', 'Aqua', 'Lengan Panjang', 1, 300000, TRUE,
                      TRUE, 'Ayden', 'set', FALSE)`);
    }
    for (let i = 0; i < po; i++) {
        none(`INSERT INTO order_items (id, order_id, product_id, size, color, variant_type,
                                       quantity, price, bordir_nama, is_po, po_fulfilled)
              VALUES (${700 + i}, 999, 1, 'M', 'black', 'pendek', 1, 265000, TRUE, TRUE, FALSE)`);
    }
}

async function run() {
    await boot(PORT);
    // Menambal ALAT UJI: CHECK order_status bawaan pg-mem belum memuat 'bordir'
    // (migrasi initDB memakai nama constraint Postgres yang tak cocok di pg-mem).
    for (let i = 0; i < 6; i++) {
        try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) { /* tidak ada */ }
    }

    // 1 — custom belum dijahit
    seed({ custom: 2 });
    group('1. Item custom belum siap -> bordir tidak bisa ditandai selesai');
    let r = await bordirDone(999);
    check('ditolak 409', r.status === 409, r);
    check('alasannya menyebut custom', /custom/i.test(r.body.error || ''), r.body);
    check('status tetap di bordir', statusOf(999) === 'bordir', statusOf(999));
    check('tidak ada catatan bordir palsu di audit',
        one(`SELECT COUNT(*)::int AS n FROM order_photos WHERE order_id = 999 AND step = 'bordir'`).n === 0);

    // 2 — satu dari dua sudah siap, satu belum: tetap ditolak
    seed({ custom: 2 });
    none(`UPDATE order_items SET po_fulfilled = TRUE WHERE id = 600`);
    group('2. Sebagian custom siap -> tetap ditolak');
    r = await bordirDone(999);
    check('ditolak 409', r.status === 409, r);
    check('status tetap di bordir', statusOf(999) === 'bordir');

    // 3 — aturan lama: PO katalog belum masuk stok
    seed({ po: 1 });
    group('3. PO katalog belum siap -> tetap ditolak (aturan lama tidak hilang)');
    r = await bordirDone(999);
    check('ditolak 409', r.status === 409, r);
    check('alasannya menyebut Pre-Order', /pre-order/i.test(r.body.error || ''), r.body);

    // 4 — semua custom siap
    seed({ custom: 2 });
    none(`UPDATE order_items SET po_fulfilled = TRUE WHERE id IN (600, 601)`);
    group('4. Semua custom siap -> bordir bisa ditandai selesai');
    r = await bordirDone(999);
    check('diterima', r.status === 200, r);
    check('status pindah ke confirmed (siap kemas)', statusOf(999) === 'confirmed', statusOf(999));
    check('audit bordir tercatat',
        one(`SELECT COUNT(*)::int AS n FROM order_photos WHERE order_id = 999 AND step = 'bordir'`).n === 1);

    // 5 — order tanpa item custom sama sekali tidak ikut terkena aturan baru
    seed({});
    group('5. Order katalog biasa tidak ikut ter-block');
    r = await bordirDone(999);
    check('diterima', r.status === 200, r);
    check('status pindah ke confirmed', statusOf(999) === 'confirmed');

    // 6 — gate approval lama masih berlaku
    seed({ bordirStatus: 'pending' });
    group('6. Bordir belum disetujui -> tetap ditolak');
    r = await bordirDone(999);
    check('ditolak 409', r.status === 409, r);
    check('alasannya menyebut disetujui/review', /disetujui|review/i.test(r.body.error || ''), r.body);

    // 7 — butuh izin
    seed({});
    group('7. Butuh token');
    const res = await fetch(`${BASE}/api/orders/999/bordir-done`, { method: 'PUT' });
    check('tanpa token ditolak', res.status === 401 || res.status === 403, res.status);

    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
