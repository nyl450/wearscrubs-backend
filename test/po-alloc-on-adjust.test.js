// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — alokasi Pre-Order FIFO saat stok bertambah lewat JALUR APA PUN
//
//   Jalankan:  npm test     (atau: node test/run-all.js po-alloc-on-adjust)
//
// Dulu alokasi PO hanya berjalan di "Terima Stok". Edit satuan dan bulk
// add/set melewatinya, sehingga "Kembali dari Event" (bulk add) meninggalkan
// PO lunas menggantung padahal barangnya sudah di rak. Kasus nyata 17 Sep 2026:
// Minna charcoal-grey/panjang/S, PO WS-WA-20260903-8151 (Bamed Dental).
//
// Yang dijaga di sini:
//  1. Bulk add  -> PO lunas dipenuhi, stok terpotong, movement tercatat.
//  2. Edit satuan ke atas -> sama.
//  3. Edit satuan ke BAWAH / bulk subtract -> TIDAK memicu alokasi.
//  4. PO belum lunas TIDAK dipenuhi (jangan kunci stok untuk yang belum bayar).
//  5. FIFO utuh: kalau PO tertua tidak muat, BERHENTI, jangan lompat ke yang kecil.
//  6. Pesan balasan menyebut order yang terpenuhi (admin tahu harus mengemas).
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4724;
const BASE = `http://localhost:${PORT}`;
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, 'harness_secret', { expiresIn: '1h' });
async function json(method, path, body) {
    const res = await fetch(BASE + path, {
        method, headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'connection': 'close' },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let b; try { b = JSON.parse(text); } catch { b = text; }
    return { status: res.status, body: b };
}

const V = { product_id: 25, size: 'S', color: 'charcoal-grey', variant_type: 'panjang' };
function seed({ stok = 0, poPaidQty = 1, poPendingQty = 0, poBigQty = 0 } = {}) {
    none(`DELETE FROM order_items; DELETE FROM stock_movements; DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;`);
    none(`INSERT INTO products (id, sku, name, category, price, is_active) VALUES (25, 'MIN', 'Minna', 'tops', 290000, TRUE);
          INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES (25, 'S', 'charcoal-grey', 'panjang', ${stok});`);
    // 901 = PO lunas TERTUA; 902 = belum bayar; 903 = PO lunas besar (lebih tua dari 901 bila poBigQty)
    if (poBigQty) none(`INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount, payment_status, order_status, shipping_cost, shipping_courier, order_source, created_at)
        VALUES (903, 'WS-PO-BESAR', 'Klinik', '081234567892', '-', 0, 'paid', 'confirmed', 0, 'J&T', 'whatsapp', '2026-09-01');
        INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price, is_po, po_fulfilled) VALUES (3, 903, 25, 'S', 'charcoal-grey', 'panjang', ${poBigQty}, 290000, TRUE, FALSE);`);
    if (poPaidQty) none(`INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount, payment_status, order_status, shipping_cost, shipping_courier, order_source, created_at)
        VALUES (901, 'WS-PO-LUNAS', 'Bamed', '081234567890', '-', 0, 'paid', 'confirmed', 0, 'J&T', 'whatsapp', '2026-09-03');
        INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price, is_po, po_fulfilled) VALUES (1, 901, 25, 'S', 'charcoal-grey', 'panjang', ${poPaidQty}, 290000, TRUE, FALSE);`);
    if (poPendingQty) none(`INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount, payment_status, order_status, shipping_cost, shipping_courier, order_source, created_at)
        VALUES (902, 'WS-PO-BELUM', 'Rina', '081234567891', '-', 0, 'pending', 'waiting_payment', 0, 'J&T', 'whatsapp', '2026-09-02');
        INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price, is_po, po_fulfilled) VALUES (2, 902, 25, 'S', 'charcoal-grey', 'panjang', ${poPendingQty}, 290000, TRUE, FALSE);`);
}
const stok = () => one(`SELECT stock FROM inventory WHERE product_id=25 AND size='S' AND color='charcoal-grey' AND variant_type='panjang'`).stock;
const fulfilled = (id) => one(`SELECT po_fulfilled FROM order_items WHERE id = ${id}`).po_fulfilled;
const bulk = (operation, value) => json('POST', '/api/inventory/bulk', { operation, value, cells: [V], reason: 'Kembali dari Event', note: '' });
const single = (stock) => json('PUT', '/api/inventory/single', { ...V, stock, reason: 'Koreksi', note: '' });

async function run() {
    await boot(PORT);

    group('1. Bulk add "Kembali dari Event" memenuhi PO lunas (kasus 17 Sep)');
    seed({ stok: 0, poPaidQty: 1 });
    let r = await bulk('add', 1);
    check('200', r.status === 200, r.body);
    check('PO terpenuhi', fulfilled(1) === true);
    check('stok kembali 0 (1 masuk, 1 langsung ke PO)', stok() === 0, stok());
    check('movement order_out tercatat', many(`SELECT * FROM stock_movements WHERE order_id = 901 AND movement_type = 'order_out'`).length === 1);
    check('pesan menyebut ordernya', String(r.body.message).includes('WS-PO-LUNAS'), r.body.message);
    check('fulfilled_pos di balasan', Array.isArray(r.body.fulfilled_pos) && r.body.fulfilled_pos[0] === 'WS-PO-LUNAS', r.body);

    group('2. Edit satuan ke atas memenuhi PO lunas');
    seed({ stok: 0, poPaidQty: 1 });
    r = await single(2);
    check('200', r.status === 200, r.body);
    check('PO terpenuhi', fulfilled(1) === true);
    check('stok 2 - 1 = 1', stok() === 1, stok());
    check('stock_final = 1 di balasan', r.body.stock_final === 1, r.body);
    check('pesan menyebut ordernya', String(r.body.message).includes('WS-PO-LUNAS'), r.body.message);

    group('3. Turun / subtract TIDAK memicu alokasi');
    seed({ stok: 3, poPaidQty: 1 });
    r = await single(2);
    check('PO tetap menunggu (edit ke bawah)', fulfilled(1) === false);
    check('stok 2', stok() === 2, stok());
    r = await bulk('subtract', 1);
    check('PO tetap menunggu (subtract)', fulfilled(1) === false);
    check('stok 1', stok() === 1, stok());

    group('4. PO belum lunas tidak dipenuhi');
    seed({ stok: 0, poPaidQty: 0, poPendingQty: 1 });
    r = await bulk('add', 1);
    check('PO belum bayar tetap menunggu', fulfilled(2) === false);
    check('stok tetap 1', stok() === 1, stok());

    group('5. FIFO utuh: PO tertua qty 3 tidak muat -> berhenti, PO kecil di belakangnya tidak dilompati');
    seed({ stok: 0, poPaidQty: 1, poBigQty: 3 });
    r = await bulk('add', 2);
    check('PO besar (tertua) menunggu', fulfilled(3) === false);
    check('PO kecil (lebih muda) JUGA menunggu', fulfilled(1) === false);
    check('stok 2 utuh', stok() === 2, stok());
    r = await bulk('add', 1);
    check('setelah stok 3: PO besar terpenuhi', fulfilled(3) === true);
    check('PO kecil masih menunggu (stok habis)', fulfilled(1) === false);
    check('stok 0', stok() === 0, stok());

    group('6. Bulk set ke atas juga memicu; set ke angka sama tidak');
    seed({ stok: 0, poPaidQty: 1 });
    r = await bulk('set', 0);
    check('set 0 -> 0: tidak ada apa-apa', fulfilled(1) === false && stok() === 0);
    r = await bulk('set', 1);
    check('set 0 -> 1: PO terpenuhi', fulfilled(1) === true && stok() === 0, { f: fulfilled(1), s: stok() });

    await new Promise(x => setTimeout(x, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
