// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — POST /api/orders/:id/items (tambah item ke pesanan yang sudah ada)
//
//   Jalankan:  npm test     (atau: node test/run-all.js add-order-item)
//
// Latar (James, 13 Okt 2026, order WS-WA-20261013-9982): pesanan sudah dibuat,
// lalu client menambah baju dengan bordir nama dokter lain. Sebelumnya satu-
// satunya jalan adalah membatalkan pesanan dan membuat ulang dari nol — ikut
// menghapus riwayat, nomor kwitansi, dan pesan WA yang sudah dikirim.
//
// Yang dijaga ketat di sini, karena paling gampang rusak diam-diam:
//
//  1. **Harga memakai harga VARIANT**, bukan products.price (yang isinya harga
//     TERMURAH). Salah di sini = customer ditagih kurang, dan pernah terjadi
//     (lihat debug_variant_price_resolution).
//  2. **Harga item sudah termasuk bordir** — aturan yang sama dipakai seluruh
//     sistem; kalau tidak, invoice dan laporan tidak cocok.
//  3. **Total pesanan bertambah persis sebesar baris barunya**, ongkir tidak
//     dihitung ulang dan diskon nominal TIDAK diutak-atik.
//  4. **Stok TIDAK dipotong** (order belum bayar) tapi barangnya DITAHAN, dengan
//     batas waktu yang mengikuti tahanan lama — menambah item bukan alasan
//     memperpanjang tahanan.
//  5. **Pre-Order dihitung dari KETERSEDIAAN**, bukan stok mentah: barang yang
//     sedang ditahan pesanan lain tidak boleh dijanjikan lagi.
//  6. **Entry bordir nyambung ke barisnya** lewat item_label, dan status review
//     bordir kembali ke 'pending' supaya ejaan nama baru ikut diperiksa.
//  7. Pesanan yang sudah dibayar / dikemas / batal DITOLAK.
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4734;
// Batas waktu tahanan dihitung RELATIF terhadap hari ini, bukan ditulis mati.
// Dulu tertulis '2026-10-20' dan '2026-11-30' — yang pertama kedaluwarsa pada
// 21 Okt 2026 dan diam-diam mengubah hasil tes (tahanan pesanan lain dianggap
// sudah lepas), yang kedua akan menyusul akhir November.
// Dibulatkan ke jam 09:00 UTC supaya nilainya tetap khas: asersi "batas waktu
// tidak diperpanjang" butuh angka yang jelas BUKAN "sekarang + 72 jam".
function hariLagi(n) {
    const d = new Date(Date.now() + n * 86400000);
    d.setUTCHours(9, 0, 0, 0);
    return d.toISOString();
}
const EXP_JAUH  = hariLagi(40);   // tahanan pesanan ini — jauh dari +72 jam
const EXP_DEKAT = hariLagi(2);    // tahanan pesanan LAIN — masih aktif saat tes jalan
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
const ADMIN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, SECRET, { expiresIn: '1h' });
const LIHAT = jwt.sign({ id: 9, username: 'sindy', role: 'staff', allowed_menus: { orders: 'view' } }, SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + (token === undefined ? ADMIN : token), 'connection': 'close' } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const t = await res.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: res.status, body: b };
}

const tambah = (orderId, fields, token) => req('POST', `/api/orders/${orderId}/items`, fields, token);
const ord = (id) => one(`SELECT total_amount, discount_amount, has_bordir_nama, has_bordir_logo, bordir_status, embroidery_details FROM orders WHERE id = ${id}`);
const baris = (id) => many(`SELECT id, product_id, size, color, variant_type, quantity, price, bordir_nama, bordir_nama_price, bordir_logo, is_po, unit_cogs, total_cogs FROM order_items WHERE order_id = ${id} ORDER BY id`);
// Baris yang BARU dibuat diambil lewat id dari jawaban server, bukan lewat urutan:
// SERIAL pg-mem mulai dari 1, jadi baris baru bisa ber-id LEBIH KECIL dari baris
// yang di-seed dengan id eksplisit — mengambil "yang terakhir" salah baris.
const barisBaru = (r) => one(`SELECT * FROM order_items WHERE id = ${Number(r.body.item_id)}`);
const tahanan = (id) => many(`SELECT product_id, size, quantity, expires_at, released_at FROM stock_holds WHERE order_id = ${id} AND released_at IS NULL`);

const MINNA = { product_id: 25, color: 'charcoal-grey', variant_type: 'panjang', size: 'M' };

function seed() {
    none(`DELETE FROM stock_holds; DELETE FROM stock_movements; DELETE FROM order_items;
          DELETE FROM order_photos; DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, price_by_type, cogs_default, cogs_by_type, is_active) VALUES
      (25, 'MIN', 'Minna', 'tops', 270000, '{"pendek":270000,"panjang":290000}', 123096, '{"pendek":123096,"panjang":144586}', TRUE),
      (28, 'DYL', 'Dylan', 'pants', 240000, NULL, 123230, NULL, TRUE);
    INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES
      (25, 'M', 'charcoal-grey', 'panjang', 5, 0),
      (25, 'S', 'charcoal-grey', 'panjang', 1, 0),
      (25, 'M', 'charcoal-grey', 'pendek',  4, 0),
      (28, 'L', 'charcoal-grey', 'straight', 3, 0);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source,
                        discount_amount, discount_label, discount_percent, has_bordir_nama, has_bordir_logo,
                        bordir_status, embroidery_details) VALUES
      (380, 'WS-WA-20261013-9982', 'Bamed dental', '0811', 'Jl. Uji', 340000, 'pending', 'waiting_payment',
       20000, 'J&T', 'whatsapp', 0, NULL, 0, TRUE, FALSE, 'review',
       '[{"type":"nama","item_label":"Minna (charcoal-grey, S)","value":"drg. Lama","color":"Putih","position":"kanan"}]'),
      (381, 'WS-WA-381', 'Sudah Bayar', '0812', '-', 290000, 'paid',    'confirmed', 0, 'J&T', 'whatsapp', 0, NULL, 0, FALSE, FALSE, NULL, '[]'),
      (382, 'WS-WA-382', 'Dikemas',     '0813', '-', 290000, 'pending', 'packed',    0, 'J&T', 'whatsapp', 0, NULL, 0, FALSE, FALSE, NULL, '[]'),
      (383, 'WS-WA-383', 'Batal',       '0814', '-', 290000, 'pending', 'cancelled', 0, 'J&T', 'whatsapp', 0, NULL, 0, FALSE, FALSE, NULL, '[]');
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price,
                             bordir_nama, bordir_nama_price, bordir_logo, bordir_logo_price,
                             is_bonus, is_po, is_custom_size, is_custom_product) VALUES
      (900, 380, 25, 'S', 'charcoal-grey', 'panjang', 1, 320000, TRUE, 20000, FALSE, NULL, FALSE, FALSE, FALSE, FALSE);
    INSERT INTO stock_holds (order_id, product_id, size, color, variant_type, quantity, expires_at) VALUES
      -- Batas waktu sengaja jauh dari "sekarang + 72 jam": kalau dekat, asersi
      -- "tidak diperpanjang" bisa lolos secara kebetulan.
      (380, 25, 'S', 'charcoal-grey', 'panjang', 1, '${EXP_JAUH}');
    `);
}

async function run() {
    await boot(PORT);
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {} }
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE users DROP CONSTRAINT users_constraint_${i}`); } catch (e) {} }
    seed();

    group('1. Kasus James: tambah baju + bordir nama dokter lain');
    let r = await tambah(380, { ...MINNA, quantity: 1, bordir_nama: true,
        nama_text: 'drg. Siti Rahma', nama_text2: 'Sp.KG', nama_color: 'Putih', nama_pos: 'kiri' });
    check('diterima 200', r.status === 200, r.body);
    check('barisnya bertambah jadi 2', baris(380).length === 2, baris(380).length);
    const baru = barisBaru(r);
    // Harga VARIANT panjang = 290.000, BUKAN products.price (270.000 = harga pendek).
    check('harga pakai harga variant panjang + bordir = 310.000',
        Number(baru.price) === 310000, baru.price);
    check('BUKAN 290.000 (lupa bordir) atau 270.000 (harga termurah)',
        Number(baru.price) !== 290000 && Number(baru.price) !== 270000, baru.price);
    check('bordir nama tercatat di barisnya', baru.bordir_nama === true && Number(baru.bordir_nama_price) === 20000, baru);
    check('COGS variant panjang ikut tersimpan', Number(baru.unit_cogs) === 144586, baru.unit_cogs);
    let o = ord(380);
    check('total pesanan 340.000 + 310.000 = 650.000', Number(o.total_amount) === 650000, o.total_amount);

    group('2. Entry bordir nyambung ke barisnya & review diulang');
    let emb = JSON.parse(o.embroidery_details);
    check('entry bordir jadi 2', emb.length === 2, emb.length);
    const eBaru = emb[1];
    check('label menunjuk baris yang benar',
        eBaru.item_label === 'Minna (charcoal-grey, M)', eBaru.item_label);
    check('nama & baris ke-2 tersimpan',
        eBaru.value === 'drg. Siti Rahma' && eBaru.value_line2 === 'Sp.KG', eBaru);
    check('variant ikut dicatat (produksi perlu tahu potong mana)',
        eBaru.variant_type === 'panjang', eBaru);
    check('posisi dipakai sesuai pilihan', eBaru.position === 'kiri', eBaru.position);
    check('entry lama tidak tersentuh', emb[0].value === 'drg. Lama', emb[0]);
    check('status review bordir kembali ke pending', o.bordir_status === 'pending', o.bordir_status);
    check('perubahannya tercatat di jejak audit',
        many(`SELECT note FROM order_photos WHERE order_id = 380 AND step = 'edit'`).length === 1);

    group('3. Stok TIDAK dipotong, tapi barangnya ditahan');
    check('stok fisik tetap 5',
        Number(one(`SELECT stock FROM inventory WHERE product_id=25 AND size='M' AND color='charcoal-grey' AND variant_type='panjang'`).stock) === 5);
    check('tidak ada catatan pergerakan stok',
        one(`SELECT COUNT(*)::int AS n FROM stock_movements`).n === 0);
    const t = tahanan(380);
    check('tahanan jadi 2 baris (lama + baru)', t.length === 2, t);
    const tBaru = t.find(x => x.size === 'M');
    check('tahanan baru 1 pcs size M', tBaru && Number(tBaru.quantity) === 1, t);
    check('batas waktunya ikut tahanan lama PERSIS, tidak diperpanjang',
        tBaru && new Date(tBaru.expires_at).toISOString() === EXP_JAUH,
        tBaru && tBaru.expires_at);

    group('4. Pre-Order dihitung dari KETERSEDIAAN, bukan stok mentah');
    seed();
    // Pesanan LAIN menahan 4 dari 5 pcs. Stok mentah 5, tapi yang benar-benar
    // bisa dijanjikan tinggal 1.
    none(`INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
             payment_status, order_status, shipping_cost, shipping_courier, order_source) VALUES
          (390, 'WS-WA-390', 'Pembeli Lain', '0899', '-', 100000, 'pending', 'waiting_payment', 0, 'J&T', 'whatsapp');
          INSERT INTO stock_holds (order_id, product_id, size, color, variant_type, quantity, expires_at) VALUES
          (390, 25, 'M', 'charcoal-grey', 'panjang', 4, '${EXP_DEKAT}');`);
    r = await tambah(380, { ...MINNA, quantity: 2 });
    check('diterima 200', r.status === 200, r.body);
    check('ditandai Pre-Order (tersedia 1, diminta 2)', r.body.is_po === true, r.body);
    check('alasannya disebut ke admin',
        (r.body.notes || []).some(n => /tersisa 1.*butuh 2|Pre-Order/i.test(n)), r.body.notes);
    // 20 Okt: barisnya DIBELAH — 1 pcs yang tersedia dikunci sekarang, 1 pcs
    // sisanya jadi Pre-Order. Dulu kedua pcs menunggu dan 1 pcs di rak dibiarkan
    // bebas, sehingga konfirmasi bayar tidak memotong apa pun.
    const barisM = many(`SELECT * FROM order_items WHERE order_id = 380 AND size = 'M' AND color = 'charcoal-grey' AND variant_type = 'panjang' ORDER BY id`);
    check('baris M jadi dua: 1 pcs siap + 1 pcs Pre-Order',
        barisM.length === 2
        && barisM.filter(x => !x.is_po).reduce((n, x) => n + x.quantity, 0) === 1
        && barisM.filter(x => x.is_po).reduce((n, x) => n + x.quantity, 0) === 1,
        barisM.map(x => ({ q: x.quantity, po: x.is_po })));
    check('jumlah pcs tetap 2', barisM.reduce((n, x) => n + x.quantity, 0) === 2, barisM.map(x => x.quantity));
    check('yang ditahan HANYA 1 pcs — bagian Pre-Order tidak menahan apa pun',
        tahanan(380).filter(x => x.size === 'M').reduce((n, x) => n + Number(x.quantity), 0) === 1,
        tahanan(380));

    group('5. Diskon nominal DIPERTAHANKAN, tidak dihitung ulang');
    seed();
    none(`UPDATE orders SET discount_amount = 50000, discount_label = 'Diskon Rp 50.000 (produk + bordir)',
                            total_amount = 290000 WHERE id = 380`);
    r = await tambah(380, { product_id: 28, color: 'charcoal-grey', variant_type: 'straight', size: 'L', quantity: 1 });
    check('diterima 200', r.status === 200, r.body);
    o = ord(380);
    check('diskon tetap 50.000', Number(o.discount_amount) === 50000, o.discount_amount);
    check('total 290.000 + 240.000 = 530.000', Number(o.total_amount) === 530000, o.total_amount);

    group('6. Bordir hanya untuk kategori yang boleh');
    seed();
    r = await tambah(380, { product_id: 28, color: 'charcoal-grey', variant_type: 'straight', size: 'L',
        quantity: 1, bordir_nama: true, nama_text: 'drg. X' });
    check('celana + bordir ditolak 400', r.status === 400, { status: r.status, body: r.body });
    check('pesannya menyebut kategorinya', /pants|Atasan, Gown/i.test(String(r.body && r.body.error)), r.body);
    check('tidak ada baris yang terbuat', baris(380).length === 1, baris(380).length);

    group('7. Label bordir kembar ditolak (entry jadi tidak bisa dibedakan)');
    seed();
    // Baris lama = Minna charcoal-grey S berbordir. Menambah Minna charcoal-grey S
    // berbordir lagi membuat item_label-nya kembar.
    r = await tambah(380, { product_id: 25, color: 'charcoal-grey', variant_type: 'panjang', size: 'S',
        quantity: 1, bordir_nama: true, nama_text: 'drg. Kembar' });
    check('ditolak 409', r.status === 409, { status: r.status, body: r.body });
    check('alasannya dijelaskan', /tidak bisa dibedakan|berbordir/i.test(String(r.body && r.body.error)), r.body);
    check('tanpa bordir, kombinasi yang sama TETAP boleh',
        (await tambah(380, { product_id: 25, color: 'charcoal-grey', variant_type: 'panjang', size: 'S', quantity: 1 })).status === 200);

    group('8. Yang HARUS ditolak');
    seed();
    let x = await tambah(381, { ...MINNA, quantity: 1 });
    check('pesanan sudah dibayar: ditolak 400', x.status === 400, { status: x.status, body: x.body });
    check('pesannya mengarahkan ke pesanan baru', /pesanan baru/i.test(String(x.body && x.body.error)), x.body);
    x = await tambah(382, { ...MINNA, quantity: 1 });
    check('pesanan sudah dikemas: ditolak 400', x.status === 400, x.status);
    x = await tambah(383, { ...MINNA, quantity: 1 });
    check('pesanan batal: ditolak 400', x.status === 400, x.status);
    x = await tambah(99999, { ...MINNA, quantity: 1 });
    check('pesanan tidak ada: 404', x.status === 404, x.status);
    x = await tambah(380, { product_id: 25, color: 'warna-ngawur', variant_type: 'panjang', size: 'M', quantity: 1 });
    check('kombinasi di luar katalog: ditolak 400', x.status === 400, x.body);
    x = await tambah(380, { ...MINNA, quantity: 0 });
    check('qty 0: ditolak 400', x.status === 400, x.body);
    x = await tambah(380, { ...MINNA, quantity: 1 }, LIHAT);
    check('akun lihat-saja: ditolak 403', x.status === 403, { status: x.status, body: x.body });

    group('9. Yang ditolak benar-benar TIDAK mengubah apa pun');
    check('pesanan 380 masih 1 baris', baris(380).length === 1, baris(380).length);
    check('totalnya tidak bergeser', Number(ord(380).total_amount) === 340000, ord(380).total_amount);
    check('pesanan yang sudah dibayar tidak tersentuh',
        many(`SELECT id FROM order_items WHERE order_id = 381`).length === 0);
    check('tidak ada tahanan baru dari percobaan gagal',
        tahanan(380).length === 1, tahanan(380));

    group('10. Harga khusus (admin-only) menimpa harga katalog, bordir tetap di atasnya');
    seed();
    r = await tambah(380, { ...MINNA, quantity: 2, custom_price: 250000, bordir_nama: true, nama_text: 'drg. Deal' });
    check('diterima 200', r.status === 200, r.body);
    let bk = barisBaru(r);
    check('harga satuan 250.000 + bordir 20.000 = 270.000', Number(bk.price) === 270000, bk.price);
    check('BUKAN harga katalog 290.000', Number(bk.price) !== 310000, bk.price);
    check('total 340.000 + (270.000 × 2) = 880.000', Number(ord(380).total_amount) === 880000, ord(380).total_amount);
    check('harga khusus tercatat di jejak audit (kalau tidak, angkanya tak punya penjelasan)',
        /harga khusus/i.test(many(`SELECT note FROM order_photos WHERE order_id = 380 AND step = 'edit'`)[0].note || ''),
        many(`SELECT note FROM order_photos WHERE order_id = 380 AND step = 'edit'`)[0]);
    // Staf ber-izin edit pesanan TIDAK boleh menurunkan nilai tagihan.
    seed();
    const STAF = jwt.sign({ id: 8, username: 'gudang', role: 'staff', allowed_menus: { orders: 'edit' } }, SECRET, { expiresIn: '1h' });
    r = await tambah(380, { ...MINNA, quantity: 1, custom_price: 1000 }, STAF);
    check('staf: permintaannya diterima', r.status === 200, r.body);
    check('tapi harga khususnya DIABAIKAN — tetap harga katalog 290.000',
        Number(barisBaru(r).price) === 290000, barisBaru(r).price);

    group('11. Harga khusus ngawur ditolak diam-diam, bukan bikin harga aneh');
    seed();
    for (const nilai of [0, -5000, 'abc']) {
        r = await tambah(380, { ...MINNA, quantity: 1, custom_price: nilai });
        check(`custom_price ${JSON.stringify(nilai)}: jatuh ke harga katalog 290.000`,
            r.status === 200 && Number(barisBaru(r).price) === 290000, { status: r.status, harga: r.status === 200 && barisBaru(r).price });
        none(`DELETE FROM order_items WHERE id = ${Number(r.body.item_id)}`);
    }

    group('12. Rantai kunci stok: ditambah -> terkunci -> dibatalkan -> lepas');
    seed();
    const fisikAwal = Number(one(`SELECT stock FROM inventory WHERE product_id=25 AND size='M' AND color='charcoal-grey' AND variant_type='panjang'`).stock);
    r = await tambah(380, { ...MINNA, quantity: 2 });
    check('item ditambahkan', r.status === 200, r.body);
    const terkunci = () => tahanan(380).filter(x => x.size === 'M').reduce((t, x) => t + Number(x.quantity), 0);
    check('2 pcs terkunci', terkunci() === 2, tahanan(380));
    check('stok fisik TIDAK berubah — yang dikunci bukan dipotong',
        Number(one(`SELECT stock FROM inventory WHERE product_id=25 AND size='M' AND color='charcoal-grey' AND variant_type='panjang'`).stock) === fisikAwal);
    // Inilah yang dilihat Kasir & website: sisa yang bisa dijanjikan sudah berkurang.
    let cek = await req('GET', `/api/inventory/25/check?size=M&color=charcoal-grey&type=panjang`, null, ADMIN);
    check(`tersedia turun ${fisikAwal} -> ${fisikAwal - 2}`, cek.body.available === fisikAwal - 2, cek.body);
    check('angka fisiknya tetap dilaporkan apa adanya', cek.body.stock_fisik === fisikAwal, cek.body);
    // Batalkan pesanannya -> kuncinya lepas, barang kembali bisa dijual.
    r = await req('PUT', `/api/orders/380/cancel`, { cancel_reason: 'uji' }, ADMIN);
    check('pembatalan diterima', r.status === 200, r.body);
    check('tidak ada lagi yang terkunci', tahanan(380).length === 0, tahanan(380));
    cek = await req('GET', `/api/inventory/25/check?size=M&color=charcoal-grey&type=panjang`, null, ADMIN);
    check('tersedia kembali utuh', cek.body.available === fisikAwal, cek.body);
    check('stok fisik tetap tidak pernah bergerak',
        Number(one(`SELECT stock FROM inventory WHERE product_id=25 AND size='M' AND color='charcoal-grey' AND variant_type='panjang'`).stock) === fisikAwal);
    check('tidak ada catatan pergerakan stok sama sekali',
        one(`SELECT COUNT(*)::int AS n FROM stock_movements`).n === 0);

    group('13. Logo bordir yang diunggah dikecilkan jadi WebP, bukan disimpan mentah');
    seed();
    // PNG 2×2 asli (bukan string karangan) supaya sharp benar-benar bisa mengolahnya.
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC';
    r = await tambah(380, { ...MINNA, quantity: 1, bordir_logo: true, logo_color: 'Multi warna', logo_data: PNG });
    check('diterima 200', r.status === 200, r.body);
    let embL = JSON.parse(ord(380).embroidery_details);
    const eLogo = embL.find(e => e.type === 'logo');
    check('entry logonya tersimpan', !!eLogo, embL);
    check('nilainya jadi ALAMAT berkas, bukan base64 mentah di dalam DB',
        eLogo && !String(eLogo.value).startsWith('data:'), eLogo && String(eLogo.value).slice(0, 40));
    check('berkasnya berakhiran .webp', eLogo && /\.webp$/.test(String(eLogo.value)), eLogo && eLogo.value);
    check('harga logo ikut masuk harga item (290.000 + 30.000)',
        Number(barisBaru(r).price) === 320000, barisBaru(r).price);

    group('14. Tanpa unggahan, alur lama tetap jalan (file diminta via WA)');
    seed();
    r = await tambah(380, { ...MINNA, quantity: 1, bordir_logo: true, logo_color: 'Hitam' });
    check('diterima 200', r.status === 200, r.body);
    const eTanpa = JSON.parse(ord(380).embroidery_details).find(e => e.type === 'logo');
    check('ditandai "Logo dikirim via WA"', eTanpa && eTanpa.value === 'Logo dikirim via WA', eTanpa);

    await new Promise(z => setTimeout(z, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
