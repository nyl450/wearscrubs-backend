// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — konfirmasi bayar saat stok sudah berkurang (kekurangan -> Pre-Order)
//
//   Jalankan:  npm test     (atau: node test/run-all.js confirm-shortfall)
//
// Stok TIDAK ditahan saat pesanan dibuat, baru dipotong saat bayar dikonfirmasi.
// Di antara keduanya stok bisa berkurang: pesanan lain lunas duluan, barang
// dibawa ke event, koreksi. Kasus nyata 3-4 Sep 2026 (WS-WA-20260903-8151):
// pesanan dibuat dengan stok 2, esoknya 1 pcs dibawa ke Bali, konfirmasi bayar
// buntu dengan "Sesuaikan stok atau batalkan pesanan".
//
// Yang dijaga di sini:
//  1. Tanpa persetujuan -> TETAP ditolak 409, tapi balasannya membawa rincian
//     kekurangan (dashboard memakainya untuk bertanya ke admin). Tidak ada yang
//     berubah di database.
//  2. Dengan po_shortfall=1 -> unit yang kurang jadi Pre-Order, stok yang ada
//     dipotong, pesanan lunas & tertahan di 'confirmed' (gate Kemas menunggu PO).
//  3. Baris dibelah kalau kekurangannya lebih kecil dari qty baris; COGS dibagi.
//  4. Varian lain di pesanan yang stoknya cukup dipotong normal.
//  5. Baris bordir dikorbankan TERAKHIR.
//  6. Stok cukup -> jalur lama tidak berubah, flag diabaikan.
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const { boot, api, one, many, none, check, group, finish } = require('./_bootstrap');

function seedDasar() {
    none(`DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM stock_movements;
          DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, is_active) VALUES
      (25, 'MIN', 'Minna', 'tops', 290000, TRUE);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source, payment_method) VALUES
      (900, 'WS-TEST-SHORT', 'Ayu', '081234567890', 'Jl. Mawar', 580000, 'pending', 'waiting_payment',
       0, 'J&T', 'whatsapp', 'Bonus/Free');
    `);
}
const bayar = (flag) => api('PUT', '/api/orders/900/confirm-payment', flag ? { po_shortfall: '1' } : undefined);
const stok = (size, vt = 'panjang') => one(`SELECT stock FROM inventory WHERE product_id=25 AND size='${size}' AND color='charcoal-grey' AND variant_type='${vt}'`).stock;
const baris = () => many('SELECT id, size, variant_type, quantity, is_po, po_fulfilled, total_cogs, bordir_nama FROM order_items WHERE order_id = 900 ORDER BY id');
const order = () => one('SELECT payment_status, order_status FROM orders WHERE id = 900');

async function run() {
    await boot(4723);

    // Persis kasus 8151: dua baris qty 1 (S/panjang) + satu baris yang memang PO,
    // stok tinggal 1.
    group('1. Tanpa persetujuan: ditolak 409 dengan rincian, database tidak tersentuh');
    seedDasar();
    none(`INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES (25, 'S', 'charcoal-grey', 'panjang', 1);
          INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price, is_po, po_fulfilled, total_cogs) VALUES
            (545, 900, 25, 'S', 'charcoal-grey', 'panjang', 1, 290000, FALSE, FALSE, 130000),
            (546, 900, 25, 'S', 'charcoal-grey', 'panjang', 1, 290000, FALSE, FALSE, 130000),
            (547, 900, 25, 'S', 'charcoal-grey', 'panjang', 1, 290000, TRUE,  FALSE, 130000);`);
    let r = await bayar(false);
    check('ditolak 409', r.status === 409, r.body);
    check('membawa can_po', r.body && r.body.can_po === true, r.body);
    check('rincian: 1 varian kurang 1', Array.isArray(r.body.shortfall) && r.body.shortfall.length === 1
        && r.body.shortfall[0].stock === 1 && r.body.shortfall[0].needed === 2 && r.body.shortfall[0].kurang === 1, r.body.shortfall);
    check('pesan menyebut Pre-Order', String(r.body.error).includes('Pre-Order'), r.body.error);
    check('stok tidak berubah', stok('S') === 1, stok('S'));
    check('pesanan masih pending', order().payment_status === 'pending', order());
    check('baris tidak berubah', baris().filter(b => b.is_po).length === 1, baris());

    group('2. Dengan persetujuan: 1 baris jadi PO, stok yang ada dipotong, pesanan lunas');
    r = await bayar(true);
    check('diterima 200', r.status === 200, r.body);
    check('stok jadi 0 (bukan minus)', stok('S') === 0, stok('S'));
    let b = baris();
    check('baris PO kini 2 (547 lama + 1 baru), 1 baris tetap stok', b.filter(x => x.is_po).length === 2 && b.filter(x => !x.is_po).length === 1, b);
    check('yang dikorbankan baris terbaru (546), 545 tetap', b.find(x => x.id === 546).is_po === true && b.find(x => x.id === 545).is_po === false, b);
    check('tidak ada baris baru dibuat (tidak perlu belah)', b.length === 3, b.length);
    check('pesanan lunas & tertahan di confirmed', order().payment_status === 'paid' && order().order_status === 'confirmed', order());
    check('pergerakan stok tercatat -1', one(`SELECT quantity_change FROM stock_movements WHERE order_id = 900`).quantity_change === -1);
    check('jejak audit tercatat', many(`SELECT note FROM order_photos WHERE order_id = 900 AND step = 'edit'`).some(p => p.note.includes('Pre-Order')));
    check('muncul di antrean Pre-Order', (await api('GET', '/api/pre-orders')).body.some(x => x.order_code === 'WS-TEST-SHORT'));

    group('3. Baris qty 3, stok 1: dibelah jadi 1 stok + 2 PO, COGS dibagi');
    seedDasar();
    none(`INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES (25, 'M', 'charcoal-grey', 'straight', 1);
          INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price, is_po, po_fulfilled, total_cogs) VALUES
            (552, 900, 25, 'M', 'charcoal-grey', 'straight', 3, 290000, FALSE, FALSE, 390000);`);
    r = await bayar(true);
    check('diterima 200', r.status === 200, r.body);
    b = baris();
    check('jadi 2 baris', b.length === 2, b);
    const asli = b.find(x => x.id === 552), belahan = b.find(x => x.id !== 552);
    check('baris asli qty 1, bukan PO, cogs 130000', asli.quantity === 1 && asli.is_po === false && asli.total_cogs === 130000, asli);
    check('belahan qty 2, PO, cogs 260000', !!belahan && belahan.quantity === 2 && belahan.is_po === true && belahan.po_fulfilled === false && belahan.total_cogs === 260000, belahan);
    check('stok jadi 0', stok('M', 'straight') === 0, stok('M', 'straight'));
    check('total qty pesanan tetap 3', b.reduce((s, x) => s + x.quantity, 0) === 3);

    group('4. Varian lain yang stoknya cukup dipotong normal');
    seedDasar();
    none(`INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES
            (25, 'S', 'charcoal-grey', 'panjang', 0), (25, 'L', 'charcoal-grey', 'panjang', 5);
          INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price, is_po, po_fulfilled, total_cogs) VALUES
            (1, 900, 25, 'S', 'charcoal-grey', 'panjang', 1, 290000, FALSE, FALSE, 130000),
            (2, 900, 25, 'L', 'charcoal-grey', 'panjang', 2, 290000, FALSE, FALSE, 260000);`);
    r = await bayar(false);
    check('rincian hanya menyebut S (L cukup)', r.status === 409 && r.body.shortfall.length === 1 && r.body.shortfall[0].size === 'S', r.body);
    check('L belum dipotong saat ditolak', stok('L') === 5, stok('L'));
    r = await bayar(true);
    check('diterima 200', r.status === 200, r.body);
    check('L dipotong 2', stok('L') === 3, stok('L'));
    check('S tetap 0, tidak minus', stok('S') === 0, stok('S'));
    b = baris();
    check('S jadi PO, L bukan', b.find(x => x.id === 1).is_po === true && b.find(x => x.id === 2).is_po === false, b);
    check('tidak ada pergerakan stok untuk S (tak ada yang dipotong)',
        many(`SELECT size FROM stock_movements WHERE order_id = 900`).every(m => m.size === 'L'));

    group('5. Baris bordir dikorbankan terakhir');
    seedDasar();
    none(`INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES (25, 'S', 'charcoal-grey', 'panjang', 1);
          INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price, is_po, po_fulfilled, total_cogs, bordir_nama) VALUES
            (1, 900, 25, 'S', 'charcoal-grey', 'panjang', 1, 290000, FALSE, FALSE, 130000, FALSE),
            (2, 900, 25, 'S', 'charcoal-grey', 'panjang', 1, 320000, FALSE, FALSE, 150000, TRUE);`);
    r = await bayar(true);
    check('diterima 200', r.status === 200, r.body);
    b = baris();
    check('baris polos (1) jadi PO, baris bordir (2, lebih baru) tetap stok',
        b.find(x => x.id === 1).is_po === true && b.find(x => x.id === 2).is_po === false, b);

    group('6. Stok cukup: jalur lama tidak berubah, flag diabaikan');
    seedDasar();
    none(`INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES (25, 'S', 'charcoal-grey', 'panjang', 3);
          INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price, is_po, po_fulfilled, total_cogs) VALUES
            (1, 900, 25, 'S', 'charcoal-grey', 'panjang', 2, 290000, FALSE, FALSE, 260000);`);
    r = await bayar(true);
    check('diterima 200', r.status === 200, r.body);
    check('stok 3 -> 1', stok('S') === 1, stok('S'));
    check('tidak ada yang jadi PO', baris().every(x => x.is_po === false), baris());
    check('tidak ada jejak audit PO', many(`SELECT id FROM order_photos WHERE order_id = 900 AND step = 'edit'`).length === 0);

    await new Promise(x => setTimeout(x, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
