// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — Pre-Order SEBAGIAN (20 Okt 2026)
//
//   Jalankan:  npm test     (atau: node test/run-all.js po-sebagian)
//
// Dulu baris Pre-Order selalu utuh: pesan 5 padahal stok 3 → kelimanya menunggu,
// dan 3 pcs di rak tidak dikunci untuk siapa pun. Sekarang barisnya dipecah saat
// pesanan dibuat: 3 jadi baris biasa yang menahan stok, 2 jadi baris Pre-Order.
//
// Yang dijaga paling ketat: **pemecahan ini tidak boleh mengubah uang**. Qty
// total, total tagihan, dan jumlah COGS harus persis sama sebelum dan sesudah —
// kalau tidak, satu fitur tampilan diam-diam mengubah laporan margin.
//
// Yang kedua: **tidak boleh menjanjikan stok yang bukan miliknya**. Stok yang
// sudah ditahan pesanan lain, atau sudah diklaim baris lain di pesanan yang sama,
// tidak boleh dihitung sebagai "tersedia".
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4747;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
const ADMIN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'connection': 'close' } };
    if (token !== null) opts.headers['Authorization'] = 'Bearer ' + (token === undefined ? ADMIN : token);
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const t = await res.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: res.status, body: b };
}

const V = { product_id: 1, size: 'M', color: 'black', variant_type: 'pendek' };
const terakhir = () => Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
const baris = (id) => many(`SELECT id, size, quantity, price, is_po, total_cogs, bordir_nama, is_custom_size, is_custom_product
                              FROM order_items WHERE order_id = ${id} ORDER BY id`);
const ordir = (id) => one(`SELECT total_amount, discount_amount FROM orders WHERE id = ${id}`);
const tahanan = (id) => many(`SELECT product_id, size, quantity FROM stock_holds WHERE order_id = ${id} AND released_at IS NULL ORDER BY size`);
const stok = (size = 'M') => Number(one(
    `SELECT stock FROM inventory WHERE product_id=1 AND size='${size}' AND color='black' AND variant_type='pendek'`).stock);

const jml = (rows, f) => rows.reduce((n, r) => n + Number(f(r) || 0), 0);
const po = (rows) => rows.filter(r => r.is_po);
const nonPo = (rows) => rows.filter(r => !r.is_po);

function pesanan(items, extra = {}) {
    return {
        customer_name: 'Klinik Uji', customer_phone: '08110000009', customer_address: 'Jl. Uji',
        shipping_city: 'Denpasar', shipping_courier: 'J&T', shipping_weight_kg: 1, shipping_cost: 0,
        order_source: 'whatsapp', payment_method: 'Transfer BCA / Mandiri',
        items, force_new: true, ...extra,
    };
}

function seed(stokM = 3, stokL = 0) {
    none(`DELETE FROM stock_holds; DELETE FROM stock_movements; DELETE FROM order_items;
          DELETE FROM order_photos; DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
      (1, 'ALX', 'Alex', 'tops', 300000, 100000, TRUE);
    INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES
      (1, 'M', 'black', 'pendek', ${stokM}, 0),
      (1, 'L', 'black', 'pendek', ${stokL}, 0);
    `);
}

async function run() {
    await boot(PORT);
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {} }

    group('A. Stok 3, dipesan 5 — dipecah jadi 3 + 2');
    seed(3);
    let r = await req('POST', '/api/orders', pesanan([{ ...V, quantity: 5, is_po: true }]));
    check('pesanan dibuat', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const id1 = terakhir();
    let b = baris(id1);
    check('jadi DUA baris', b.length === 2, b);
    check('baris biasa 3 pcs', nonPo(b).length === 1 && nonPo(b)[0].quantity === 3, nonPo(b));
    check('baris Pre-Order 2 pcs — inilah angka yang dicari James',
        po(b).length === 1 && po(b)[0].quantity === 2, po(b));
    check('jumlah pcs tetap 5', jml(b, r => r.quantity) === 5, b.map(x => x.quantity));

    // Uang & biaya TIDAK boleh bergeser sedikit pun.
    check('total tagihan tetap 5 x 300.000', Number(ordir(id1).total_amount) === 1500000, ordir(id1));
    check('harga satuan kedua baris sama',
        b.every(x => Number(x.price) === 300000), b.map(x => x.price));
    check('jumlah COGS tetap 5 x 100.000 — pemecahan tidak boleh menggeser margin',
        jml(b, r => r.total_cogs) === 500000, b.map(x => x.total_cogs));

    // Yang 3 pcs sekarang benar-benar dikunci; yang 2 pcs tidak (barangnya belum ada).
    check('3 pcs ditahan untuk pesanan ini', tahanan(id1).length === 1 && tahanan(id1)[0].quantity === 3, tahanan(id1));
    check('stok fisik belum disentuh (tahanan, bukan potongan)', stok() === 3, stok());

    group('B. Stok 0 — tidak ada yang bisa dipisah, tetap satu baris utuh');
    seed(0);
    r = await req('POST', '/api/orders', pesanan([{ ...V, quantity: 5, is_po: true }]));
    const id2 = terakhir();
    b = baris(id2);
    check('tetap SATU baris', b.length === 1, b);
    check('seluruh 5 pcs Pre-Order', b[0].is_po === true && b[0].quantity === 5, b[0]);
    check('tidak menahan apa pun', tahanan(id2).length === 0, tahanan(id2));

    group('C. Stok cukup — keputusan admin TIDAK dibatalkan');
    // Fitur ini memecah kekurangan, bukan menilai ulang keputusan admin. Kalau
    // stoknya ternyata cukup, barisnya dibiarkan apa adanya: admin yang memasang
    // tanda Pre-Order bisa punya alasan yang tidak diketahui sistem.
    seed(10);
    r = await req('POST', '/api/orders', pesanan([{ ...V, quantity: 5, is_po: true }]));
    const id3 = terakhir();
    b = baris(id3);
    check('tetap satu baris', b.length === 1, b);
    check('tandanya tetap Pre-Order', b[0].is_po === true, b[0]);
    check('dan tetap tidak menahan stok', tahanan(id3).length === 0, tahanan(id3));

    // Tapi jatahnya tetap dianggap terpakai: baris PO kedua pada varian yang sama
    // tidak boleh ikut mengakui stok yang sudah dijanjikan ke baris pertama.
    // Baris kedua (6 pcs) MELEBIHI stok, jadi kalau jatahnya tidak ikut terpakai
    // oleh baris pertama, ia akan terbelah 4 + 2 — menjanjikan 4 pcs yang sama
    // untuk dua baris sekaligus.
    seed(4);
    r = await req('POST', '/api/orders', pesanan([
        { ...V, quantity: 4, is_po: true },
        { ...V, quantity: 6, is_po: true },
    ]));
    const id3b = terakhir();
    b = baris(id3b);
    check('baris kedua tidak dipecah — 4 pcs itu sudah dijanjikan ke baris pertama',
        b.length === 2 && b.every(x => x.is_po === true), b.map(x => ({ q: x.quantity, po: x.is_po })));
    check('jumlahnya tetap 4 + 6', jml(b, r => r.quantity) === 10, b.map(x => x.quantity));
    check('tidak ada tahanan sama sekali', tahanan(id3b).length === 0, tahanan(id3b));

    group('D. Stok yang ada didahulukan untuk baris TANPA bordir');
    // Membelah baris bordir menambah satu baris lagi dengan label bordir yang sama
    // di invoice. Kalau stoknya cukup untuk salah satu, yang utuh harus yang bordir.
    // Stok 1 pcs, dua baris @2 pcs: hanya SATU yang bisa terbelah. Yang terbelah
    // harus baris tanpa bordir.
    seed(1);
    r = await req('POST', '/api/orders', pesanan([
        { ...V, quantity: 2, is_po: true, bordir_nama: true },
        { ...V, quantity: 2, is_po: true },
    ], { embroidery_details: [{ type: 'nama', value: 'dr. Uji', item_label: 'Alex (black, M)' }] }));
    check('pesanan dibuat', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const id4 = terakhir();
    b = baris(id4);
    check('baris bordir TIDAK terbelah', b.filter(x => x.bordir_nama).length === 1, b);
    check('baris bordir tetap 2 pcs dan Pre-Order',
        b.find(x => x.bordir_nama).quantity === 2 && b.find(x => x.bordir_nama).is_po === true,
        b.find(x => x.bordir_nama));
    check('yang terbelah justru baris tanpa bordir: 1 ada + 1 Pre-Order',
        b.filter(x => !x.bordir_nama).length === 2
        && b.filter(x => !x.bordir_nama && !x.is_po)[0]?.quantity === 1
        && b.filter(x => !x.bordir_nama && x.is_po)[0]?.quantity === 1,
        b.filter(x => !x.bordir_nama));
    check('jumlah pcs tetap 4', jml(b, r => r.quantity) === 4, b.map(x => x.quantity));
    check('total tagihan tetap 2 x 320.000 + 2 x 300.000',
        Number(ordir(id4).total_amount) === 1240000, ordir(id4));

    group('E. Stok yang sudah diklaim baris lain tidak boleh dihitung dua kali');
    // Baris biasa 2 pcs memakan seluruh stok; baris PO tidak boleh ikut mengakuinya.
    seed(2);
    r = await req('POST', '/api/orders', pesanan([
        { ...V, quantity: 2 },
        { ...V, quantity: 3, is_po: true },
    ]));
    check('pesanan dibuat', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const id5 = terakhir();
    b = baris(id5);
    check('baris PO tetap utuh 3 pcs — stoknya sudah jadi milik baris biasa',
        po(b).length === 1 && po(b)[0].quantity === 3, po(b));
    check('tahanannya 2 pcs saja, bukan 4', tahanan(id5).length === 1 && tahanan(id5)[0].quantity === 2, tahanan(id5));

    group('F. Stok yang ditahan pesanan LAIN tidak dihitung tersedia');
    seed(3);
    r = await req('POST', '/api/orders', pesanan([{ ...V, quantity: 3 }], { customer_phone: '08110000011' }));
    const idLain = terakhir();
    check('pesanan pertama menahan 3 pcs', tahanan(idLain).length === 1 && tahanan(idLain)[0].quantity === 3, tahanan(idLain));
    r = await req('POST', '/api/orders', pesanan([{ ...V, quantity: 4, is_po: true }], { customer_phone: '08110000012' }));
    const id6 = terakhir();
    b = baris(id6);
    check('tidak dipecah — rak terlihat penuh tapi isinya milik orang lain',
        b.length === 1 && b[0].is_po === true && b[0].quantity === 4, b);
    check('pesanan kedua tidak menahan apa pun', tahanan(id6).length === 0, tahanan(id6));

    group('G. Custom size / custom product tidak pernah dipecah');
    // Sengaja memakai varian yang PUNYA baris stok (M/black/pendek, sisa 2) dan
    // qty di atasnya. Kalau penjaga `!is_custom_size` hilang, baris ini akan
    // terbelah 2 + 2 — padahal barang custom tidak diambil dari rak sama sekali.
    // Dengan size imajiner (3XL) jebakannya tidak kelihatan: stoknya 0, jadi
    // tidak ada yang bisa dipecah walau penjaganya dicopot.
    seed(2);
    r = await req('POST', '/api/orders', pesanan([
        { ...V, quantity: 4, is_custom_size: true, custom_price: 350000 },
    ]));
    check('pesanan dibuat', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const id7 = terakhir();
    b = baris(id7);
    check('tetap SATU baris custom 4 pcs — tidak terbelah oleh stok di rak',
        b.length === 1 && b[0].is_custom_size === true && b[0].quantity === 4, b);
    check('dan bukan Pre-Order', b[0].is_po === false, b[0]);
    check('tidak menahan stok (barang custom tidak diambil dari rak)',
        tahanan(id7).length === 0, tahanan(id7));

    // Custom product: tidak punya product_id sama sekali.
    seed(2);
    r = await req('POST', '/api/orders', pesanan([
        { ...V, quantity: 4, is_custom_product: true, custom_price: 400000,
          custom_product_name: 'Jas Lab', custom_product_category: 'tops' },
    ]));
    check('pesanan custom product dibuat', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const id7b = terakhir();
    b = baris(id7b);
    check('tetap satu baris 4 pcs',
        b.length === 1 && b[0].is_custom_product === true && b[0].quantity === 4, b);

    group('H. Dua varian berbeda dihitung sendiri-sendiri');
    seed(3, 1);   // M = 3, L = 1
    r = await req('POST', '/api/orders', pesanan([
        { ...V, quantity: 5, is_po: true },
        { ...V, size: 'L', quantity: 4, is_po: true },
    ]));
    check('pesanan dibuat', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const id8 = terakhir();
    b = baris(id8);
    check('jadi empat baris', b.length === 4, b.map(x => ({ s: x.size, q: x.quantity, po: x.is_po })));
    check('M: 3 ada, 2 Pre-Order',
        b.filter(x => x.size === 'M' && !x.is_po)[0]?.quantity === 3
        && b.filter(x => x.size === 'M' && x.is_po)[0]?.quantity === 2, b.filter(x => x.size === 'M'));
    check('L: 1 ada, 3 Pre-Order',
        b.filter(x => x.size === 'L' && !x.is_po)[0]?.quantity === 1
        && b.filter(x => x.size === 'L' && x.is_po)[0]?.quantity === 3, b.filter(x => x.size === 'L'));
    check('total pcs tetap 9', jml(b, r => r.quantity) === 9, b.map(x => x.quantity));
    check('total tagihan tetap 9 x 300.000', Number(ordir(id8).total_amount) === 2700000, ordir(id8));
    check('jumlah COGS tetap 9 x 100.000', jml(b, r => r.total_cogs) === 900000, b.map(x => x.total_cogs));
    check('tahanan: M 3 pcs + L 1 pcs',
        tahanan(id8).length === 2
        && tahanan(id8).find(t => t.size === 'M').quantity === 3
        && tahanan(id8).find(t => t.size === 'L').quantity === 1, tahanan(id8));

    group('I. COGS yang tidak habis dibagi tetap berjumlah sama');
    seed(2);
    none(`UPDATE products SET cogs_default = 33333 WHERE id = 1`);
    r = await req('POST', '/api/orders', pesanan([{ ...V, quantity: 3, is_po: true }]));
    const id9 = terakhir();
    b = baris(id9);
    check('terpecah 2 + 1', b.length === 2 && jml(b, r => r.quantity) === 3, b.map(x => x.quantity));
    check('jumlah COGS persis 3 x 33.333 — tidak ada rupiah yang menguap saat dibagi',
        jml(b, r => r.total_cogs) === 99999, b.map(x => x.total_cogs));

    // ── Jalur UBAH dari detail pesanan ─────────────────────────────────────
    // Kasus asli James (WS-WA-20261019-5442): item diganti Ally → Alex lewat
    // detail pesanan, lalu dibayar — dan tidak ada stok yang terpotong sama
    // sekali, karena seluruh baris ditandai Pre-Order.
    const seedDua = (stokAlex, stokAlly) => {
        seed(stokAlex);
        none(`INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
                (2, 'ALY', 'Ally', 'tops', 300000, 100000, TRUE);
              INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES
                (2, 'M', 'black', 'pendek', ${stokAlly}, 0);`);
    };

    group('J. Ganti produk dari detail pesanan: stok yang ada ikut terkunci');
    seedDua(3, 10);
    r = await req('POST', '/api/orders', pesanan([
        { product_id: 2, size: 'M', color: 'black', variant_type: 'pendek', quantity: 5 },
    ]));
    check('pesanan Ally dibuat', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const idJ = terakhir();
    const totalSebelum = Number(ordir(idJ).total_amount);
    const itemJ = baris(idJ)[0];
    check('Ally menahan 5 pcs', tahanan(idJ).length === 1 && tahanan(idJ)[0].quantity === 5, tahanan(idJ));

    r = await req('PUT', `/api/orders/${idJ}/items/${itemJ.id}`,
        { product_id: 1, color: 'black', variant_type: 'pendek', size: 'M', quantity: 5 }, ADMIN);
    check('penggantian diterima', r.status === 200, { status: r.status, body: r.body });
    b = baris(idJ);
    check('jadi dua baris: 3 pcs siap + 2 pcs Pre-Order',
        b.length === 2
        && nonPo(b).reduce((n, x) => n + x.quantity, 0) === 3
        && po(b).reduce((n, x) => n + x.quantity, 0) === 2,
        b.map(x => ({ q: x.quantity, po: x.is_po })));
    check('jumlah pcs tetap 5', jml(b, x => x.quantity) === 5, b.map(x => x.quantity));
    check('total tagihan tidak bergeser', Number(ordir(idJ).total_amount) === totalSebelum,
        { sebelum: totalSebelum, sesudah: ordir(idJ).total_amount });
    check('jumlah COGS tetap 5 x 100.000', jml(b, x => x.total_cogs) === 500000, b.map(x => x.total_cogs));
    check('tahanan pindah ke Alex, 3 pcs saja',
        tahanan(idJ).length === 1 && tahanan(idJ)[0].quantity === 3, tahanan(idJ));
    check('tahanan Ally sudah dilepas',
        many(`SELECT id FROM stock_holds WHERE order_id = ${idJ} AND product_id = 2 AND released_at IS NULL`).length === 0);

    group('K. Dan saat dibayar, 3 pcs itu BENAR-BENAR keluar dari rak');
    none(`UPDATE orders SET payment_method = 'Bonus/Free' WHERE id = ${idJ}`);
    const stokSebelumBayar = stok();
    r = await req('PUT', `/api/orders/${idJ}/confirm-payment`, {}, ADMIN);
    check('konfirmasi bayar diterima', r.status === 200, r.body);
    check('stok Alex turun 3 — dulu NOL yang terpotong', stok() === stokSebelumBayar - 3,
        { sebelum: stokSebelumBayar, sesudah: stok() });
    b = baris(idJ);
    check('2 pcs sisanya tetap menunggu stok',
        po(b).filter(x => !x.po_fulfilled).reduce((n, x) => n + x.quantity, 0) === 2, b);

    group('L. Baris Pre-Order yang SUDAH terpenuhi tidak boleh ikut dibelah');
    // Baris PO yang po_fulfilled = TRUE stoknya SUDAH dipotong. Membelah atau
    // melepas tandanya berarti menghitung barang yang sama dua kali.
    seedDua(10, 10);
    r = await req('POST', '/api/orders', pesanan([
        { ...V, quantity: 6, is_po: true },
        { product_id: 2, size: 'M', color: 'black', variant_type: 'pendek', quantity: 1 },
    ]));
    check('pesanan dibuat', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const idL = terakhir();
    const poL = baris(idL).find(x => x.is_po);
    none(`UPDATE order_items SET po_fulfilled = TRUE WHERE id = ${poL.id}`);
    // Stok dikecilkan supaya kalau penjaganya hilang, barisnya PASTI terbelah.
    none(`UPDATE inventory SET stock = 2 WHERE product_id = 1 AND size = 'M' AND color = 'black' AND variant_type = 'pendek'`);
    const allyL = baris(idL).find(x => !x.is_po);
    r = await req('PUT', `/api/orders/${idL}/items/${allyL.id}`, { quantity: 2 }, ADMIN);
    check('edit baris LAIN diterima', r.status === 200, { status: r.status, body: r.body });
    const poSesudah = many(`SELECT * FROM order_items WHERE order_id = ${idL} AND product_id = 1 ORDER BY id`);
    check('baris PO yang sudah terpenuhi tidak tersentuh',
        poSesudah.length === 1 && poSesudah[0].quantity === 6
        && poSesudah[0].is_po === true && poSesudah[0].po_fulfilled === true,
        poSesudah.map(x => ({ q: x.quantity, po: x.is_po, f: x.po_fulfilled })));
    check('dan tidak ikut menahan stok (stoknya sudah dipotong)',
        tahanan(idL).every(t => t.size !== 'M' || Number(t.quantity) !== 6), tahanan(idL));

    group('M. Tahanan milik pesanan ini sendiri bukan saingan');
    // Pesanan menahan 2 pcs Alex lewat baris biasanya. Saat isinya diubah, tahanan
    // itu akan disusun ulang — jadi ia TIDAK boleh ikut dihitung sebagai stok yang
    // sudah diambil orang lain. Kalau ikut dihitung, barangnya terpotong dua kali
    // dari jatah (sekali sebagai tahanan, sekali sebagai klaim baris) dan bagian
    // yang bisa dikunci jadi lebih kecil dari yang seharusnya.
    seedDua(2, 10);
    r = await req('POST', '/api/orders', pesanan([
        { ...V, quantity: 2 },
        { ...V, quantity: 6, is_po: true },
    ]));
    check('pesanan dibuat', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const idM = terakhir();
    check('saat dibuat baris PO belum bisa dipecah (stok habis diklaim baris biasa)',
        baris(idM).length === 2 && po(baris(idM))[0].quantity === 6, baris(idM));
    check('yang ditahan 2 pcs', tahanan(idM).reduce((n, t) => n + Number(t.quantity), 0) === 2, tahanan(idM));

    // Stok datang: 2 → 7. Lalu pesanan disentuh lewat Tambah Item.
    none(`UPDATE inventory SET stock = 7 WHERE product_id = 1 AND size = 'M' AND color = 'black' AND variant_type = 'pendek'`);
    r = await req('POST', `/api/orders/${idM}/items`,
        { product_id: 2, color: 'black', variant_type: 'pendek', size: 'M', quantity: 1 }, ADMIN);
    check('tambah item diterima', r.status === 200, { status: r.status, body: r.body });
    const alexM = many(`SELECT * FROM order_items WHERE order_id = ${idM} AND product_id = 1 ORDER BY id`);
    check('Alex siap 7 pcs (2 lama + 5 hasil belahan), bukan 5',
        alexM.filter(x => !x.is_po).reduce((n, x) => n + x.quantity, 0) === 7,
        alexM.map(x => ({ q: x.quantity, po: x.is_po })));
    check('sisanya 1 pcs Pre-Order, bukan 3',
        alexM.filter(x => x.is_po).reduce((n, x) => n + x.quantity, 0) === 1,
        alexM.map(x => ({ q: x.quantity, po: x.is_po })));
    check('jumlah pcs Alex tetap 8', alexM.reduce((n, x) => n + x.quantity, 0) === 8, alexM.map(x => x.quantity));
    check('tahanan Alex jadi 7 pcs',
        tahanan(idM).filter(t => Number(t.product_id) === 1).reduce((n, t) => n + Number(t.quantity), 0) === 7,
        tahanan(idM));
    check('Ally yang baru ditambahkan ikut ditahan 1 pcs',
        tahanan(idM).filter(t => Number(t.product_id) === 2).reduce((n, t) => n + Number(t.quantity), 0) === 1,
        tahanan(idM));

    await new Promise(w => setTimeout(w, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
