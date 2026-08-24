// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — POST /api/orders/:id/add-bordir (tambah bordir setelah bayar)
//
//   Jalankan:  npm test        atau  node test/run-all.js add-bordir
//
// Dua hal yang dijaga di sini, keduanya pernah bocor:
//
// 1. GATE KATEGORI. Endpoint ini dulu tidak mengecek kategori sama sekali,
//    padahal Kasir memblokirnya — jadi bordir bisa ditambahkan ke CELANA lewat
//    modal "Tambah Bordir" dan ikut tertagih ke customer untuk barang yang tidak
//    mungkin dibordir.
//
// 2. POSISI BORDIR CAP. Cap dibordir depan/belakang, bukan kiri/kanan dada.
//    Posisi dari client dulu dipakai mentah tanpa whitelist, sehingga slug apa
//    pun bisa masuk ke JSON dan dibaca renderer invoice/WA sebagai label.
//
// Kalau menambah kategori yang boleh dibordir atau posisi baru, ubah BORDIR_CATS
// / VALID_BORDIR_POS di server.js DAN kembarannya di public/dashboard.html —
// lalu tambahkan pemeriksaannya di sini.
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, none, check, group, finish } = require('./_bootstrap');

const PORT = 4715;
const BASE = `http://localhost:${PORT}`;
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, 'harness_secret', { expiresIn: '1h' });

// Endpoint ini menerima array of object, jadi tidak bisa lewat helper urlencoded
// bawaan harness — kirim JSON langsung.
async function addBordir(orderId, items) {
    const res = await fetch(`${BASE}/api/orders/${orderId}/add-bordir`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
}

const embOf = (orderId) => {
    const raw = one(`SELECT embroidery_details FROM orders WHERE id = ${orderId}`).embroidery_details;
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
};

function seed() {
    none(`DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM stock_movements;
          DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, price_by_type, cogs_default, is_active) VALUES
      (1, 'ALX', 'Alex SS',  'tops',  245000, '{"pendek":245000}', 120000, TRUE),
      (3, 'DYL', 'Dylan',    'pants', 230000, NULL, 110000, TRUE),
      (7, 'CAP', 'Cap Scrub','caps',  120000, NULL,  60000, TRUE);
    INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES
      (1, 'M', 'black', 'pendek', 5), (3, 'L', 'black', 'jogger', 4), (7, 'L', 'navy', 'null', 6);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source,
                        additional_amount_due) VALUES
      (999, 'WS-TEST-BORDIR', 'Uji Coba', '0811', 'Alamat uji', 595000, 'paid', 'confirmed',
       0, 'J&T', 'whatsapp', 0);
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price,
                             bordir_nama, bordir_logo) VALUES
      (501, 999, 1, 'M', 'black', 'pendek', 1, 245000, FALSE, FALSE),
      (502, 999, 3, 'L', 'black', 'jogger', 1, 230000, FALSE, FALSE),
      (503, 999, 7, 'L', 'navy',  'null',   1, 120000, FALSE, FALSE);
    `);
}

async function run() {
    await boot(PORT);
    // Menambal ALAT UJI, bukan produk: initDB memigrasi CHECK order_status supaya
    // memuat 'bordir' lewat `DROP CONSTRAINT IF EXISTS orders_order_status_check`
    // + ADD CONSTRAINT. Di pg-mem constraint inline-nya bernama lain
    // (orders_constraint_N), jadi DROP-nya tidak kena dan CHECK lama bertahan —
    // padahal endpoint ini memang men-set order_status='bordir'. Buang di sini.
    for (let i = 0; i < 6; i++) {
        try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) { /* tidak ada */ }
    }

    // 1 — celana ditolak
    seed();
    group('1. Celana tidak bisa ditambah bordir');
    let r = await addBordir(999, [{ item_id: 502, bordir_nama: true, nama_text: 'drg. Uji', nama_price: 20000 }]);
    check('ditolak 400', r.status === 400, r);
    check('alasannya menyebut kategori', /kategori|bordir hanya/i.test(r.body.error || ''), r.body);
    check('tidak ada entry bordir tersimpan', embOf(999).length === 0, embOf(999));
    check('flag item celana tidak berubah',
        one('SELECT bordir_nama FROM order_items WHERE id = 502').bordir_nama === false);
    check('tagihan tidak bertambah',
        Number(one('SELECT additional_amount_due FROM orders WHERE id = 999').additional_amount_due || 0) === 0);

    // 2 — satu celana di antara item valid tetap membatalkan semuanya
    seed();
    group('2. Satu item tidak sah -> seluruh permintaan ditolak (tidak separuh jalan)');
    r = await addBordir(999, [
        { item_id: 501, bordir_nama: true, nama_text: 'drg. Uji', nama_price: 20000 },
        { item_id: 502, bordir_nama: true, nama_text: 'drg. Uji', nama_price: 20000 },
    ]);
    check('ditolak 400', r.status === 400, r);
    check('item atasan pun tidak ikut ter-set',
        one('SELECT bordir_nama FROM order_items WHERE id = 501').bordir_nama === false);
    check('embroidery_details tetap kosong', embOf(999).length === 0);

    // 3 — cap boleh, dengan posisi depan/belakang
    seed();
    group('3. Cap bisa dibordir dengan posisi depan & belakang');
    r = await addBordir(999, [{
        item_id: 503,
        bordir_nama: true, nama_text: 'drg. Bram', nama_color: 'Hitam', nama_pos: 'depan', nama_price: 20000,
        bordir_logo: true, logo_color: 'Multi warna', logo_pos: 'belakang', logo_price: 30000,
    }]);
    check('diterima', r.status === 200, r);
    let emb = embOf(999);
    check('2 entry tersimpan', emb.length === 2, emb);
    check('posisi nama = depan', (emb.find(e => e.type === 'nama') || {}).position === 'depan', emb);
    check('posisi logo = belakang', (emb.find(e => e.type === 'logo') || {}).position === 'belakang', emb);
    check('selisih tagihan 50rb',
        Number(one('SELECT additional_amount_due FROM orders WHERE id = 999').additional_amount_due) === 50000);

    // 4 — posisi ngawur tidak ikut tersimpan
    seed();
    group('4. Slug posisi ngawur jatuh ke default kategori, bukan ikut tersimpan');
    r = await addBordir(999, [{
        item_id: 503, bordir_nama: true, nama_text: 'drg. Bram', nama_pos: 'di-atas-kuping', nama_price: 20000,
    }]);
    check('diterima', r.status === 200, r);
    emb = embOf(999);
    check('posisi jadi "depan" (default cap), bukan slug ngawur',
        emb.length === 1 && emb[0].position === 'depan', emb);

    // 5 — nama & logo tidak boleh di posisi yang sama
    seed();
    group('5. Posisi nama & logo tidak boleh sama');
    r = await addBordir(999, [{
        item_id: 503,
        bordir_nama: true, nama_text: 'drg. Bram', nama_pos: 'depan', nama_price: 20000,
        bordir_logo: true, logo_pos: 'depan', logo_price: 30000,
    }]);
    check('ditolak 400', r.status === 400, r);
    check('alasannya menyebut posisi', /posisi/i.test(r.body.error || ''), r.body);
    check('tidak ada yang tersimpan', embOf(999).length === 0);

    // 6 — butuh izin
    seed();
    group('6. Butuh token');
    const res = await fetch(`${BASE}/api/orders/999/add-bordir`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ item_id: 503, bordir_nama: true, nama_text: 'x', nama_price: 20000 }] }),
    });
    check('tanpa token ditolak', res.status === 401 || res.status === 403, res.status);

    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
