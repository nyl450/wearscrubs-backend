// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — alur lapangan 16 Okt 2026
//
//   Jalankan:  npm test     (atau: node test/run-all.js ambil-dulu)
//
// Tiga hal dari James, semuanya berasal dari kejadian nyata di lapangan:
//
//  A. **Barang diambil dulu, bayar belakangan.** Kerabat/kenalan membawa pulang
//     barangnya sekarang, uangnya menyusul.
//     ⚠️ Ini SATU-SATUNYA pengecualian invarian "lunas ⇒ potong stok". Aturannya
//     tetap: stok dipotong TEPAT SEKALI per pesanan, saat barangnya fisik keluar.
//     Karena itu yang dijaga paling ketat di sini adalah TIDAK ADA pemotongan
//     ganda (saat diserahkan DAN saat lunas) dan TIDAK ADA stok yang hilang
//     selamanya (batal sebelum bayar harus mengembalikan barangnya).
//     Menahan stok saja tidak cukup untuk kasus ini: tahanan kedaluwarsa sendiri
//     setelah 72 jam, dan sesudahnya sistem mengira barang yang sudah dibawa
//     pulang masih ada di rak.
//
//  B. **Nomor HP boleh kosong untuk penjualan tatap muka.** Di event ada dokter
//     yang tidak mau memberikan nomornya; tanpa ini penjualannya sama sekali
//     tidak bisa dicatat. Order website & WhatsApp TETAP wajib bernomor.
//
//  C. **shipped_at dicatat saat resi diisi** — dasar penyelesaian otomatis
//     1x24 jam (job-nya di database, lihat docs/db-cron-jobs.sql).
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4735;
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
const stok = () => Number(one(
    `SELECT stock FROM inventory WHERE product_id=1 AND size='M' AND color='black' AND variant_type='pendek'`).stock);
const ordir = (id) => one(`SELECT order_code, order_status, payment_status, shipping_courier, shipping_cost, total_amount, picked_up_at, shipped_at, customer_phone FROM orders WHERE id = ${id}`);
const terakhir = () => Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
const gerakan = () => many(`SELECT movement_type, quantity_change, note FROM stock_movements ORDER BY id`);
const tahanan = (id) => many(`SELECT quantity FROM stock_holds WHERE order_id = ${id} AND released_at IS NULL`);
// confirm-payment mewajibkan foto bukti transfer kecuali pesanan memang tanpa
// pembayaran. Yang diuji di sini STOK, bukan unggah berkas — jadi metodenya
// disetel ke Bonus/Free dulu. Pemotongan stok tetap jalan penuh.
const bebaskanBukti = (id) => none(`UPDATE orders SET payment_method = 'Bonus/Free' WHERE id = ${id}`);

function pesanan(extra = {}) {
    return {
        customer_name: 'Kerabat', customer_phone: '08110000000', customer_address: 'Jl. Uji',
        shipping_city: 'Denpasar', shipping_courier: 'J&T', shipping_weight_kg: 1, shipping_cost: 25000,
        order_source: 'offline', payment_method: 'Cash',
        items: [{ ...V, quantity: 2 }],
        force_new: true,
        ...extra,
    };
}

function seed() {
    none(`DELETE FROM stock_holds; DELETE FROM stock_movements; DELETE FROM order_items;
          DELETE FROM order_photos; DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;`);
    none(`
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
      (1, 'MIN', 'Minna', 'tops', 290000, 130000, TRUE);
    INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES
      (1, 'M', 'black', 'pendek', 10, 0);
    `);
}

async function run() {
    await boot(PORT);
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {} }
    seed();

    group('A1. Barang diserahkan: stok dipotong SEKARANG, bukan ditahan');
    let r = await req('POST', '/api/orders', pesanan({ picked_up: true }));
    check('diterima', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const id1 = terakhir();
    check('stok langsung turun 10 -> 8', stok() === 8, stok());
    const g = gerakan();
    check('tercatat sebagai barang keluar', g.length === 1 && g[0].movement_type === 'order_out', g);
    check('catatannya menyebut sebabnya', /diambil dulu/i.test(g[0].note || ''), g[0]);
    check('TIDAK ikut ditahan (stoknya sudah dipotong, menahan lagi = hitung dua kali)',
        tahanan(id1).length === 0, tahanan(id1));
    let o = ordir(id1);
    check('ditandai waktunya', o.picked_up_at !== null, o.picked_up_at);
    check('kurir dipaksa ambil langsung', o.shipping_courier === 'Diambil di event / walkin', o.shipping_courier);
    check('ongkir dinolkan', Number(o.shipping_cost) === 0, o.shipping_cost);
    check('total = harga barang saja (580.000)', Number(o.total_amount) === 580000, o.total_amount);
    check('statusnya masih menunggu bayar', o.order_status === 'waiting_payment' && o.payment_status === 'pending', o);

    group('A2. Saat dibayar: LANGSUNG selesai, dan stok TIDAK dipotong lagi');
    bebaskanBukti(id1);
    r = await req('PUT', `/api/orders/${id1}/confirm-payment`, {}, ADMIN);
    check('konfirmasi diterima', r.status === 200, r.body);
    o = ordir(id1);
    check('langsung selesai, tidak lewat Kemas & Kirim', o.order_status === 'done', o.order_status);
    check('tercatat lunas', o.payment_status === 'paid', o.payment_status);
    check('stok TETAP 8 — tidak dipotong dua kali', stok() === 8, stok());
    check('tetap hanya ada SATU catatan barang keluar',
        gerakan().filter(x => x.movement_type === 'order_out').length === 1, gerakan());

    group('A3. Dibatalkan sebelum dibayar: barangnya kembali ke rak');
    seed();
    r = await req('POST', '/api/orders', pesanan({ picked_up: true }));
    const id2 = terakhir();
    check('stok turun jadi 8', stok() === 8, stok());
    r = await req('PUT', `/api/orders/${id2}/cancel`, { cancel_reason: 'jadi tidak diambil' }, ADMIN);
    check('pembatalan diterima', r.status === 200, r.body);
    check('stok kembali 10 — tanpa ini barangnya hilang selamanya dari sistem',
        stok() === 10, stok());
    check('pengembaliannya tercatat',
        gerakan().some(x => x.movement_type === 'order_cancel_restore'), gerakan());

    group('A4. Pesanan BIASA tidak ikut berubah perilakunya');
    seed();
    r = await req('POST', '/api/orders', pesanan());
    const id3 = terakhir();
    check('stok TIDAK dipotong saat dibuat', stok() === 10, stok());
    check('barangnya ditahan seperti biasa', tahanan(id3).length === 1, tahanan(id3));
    o = ordir(id3);
    check('tidak ditandai diambil', o.picked_up_at === null, o.picked_up_at);
    check('kurir & ongkir apa adanya', o.shipping_courier === 'J&T' && Number(o.shipping_cost) === 25000, o);
    bebaskanBukti(id3);
    r = await req('PUT', `/api/orders/${id3}/confirm-payment`, {}, ADMIN);
    check('baru dipotong saat lunas', r.status === 200 && stok() === 8, { status: r.status, body: r.body, stok: stok() });
    check('statusnya ke Kemas, bukan selesai', ordir(id3).order_status === 'confirmed', ordir(id3).order_status);

    group('A5. Yang HARUS ditolak');
    seed();
    let x = await req('POST', '/api/orders', pesanan({ picked_up: true, items: [{ ...V, quantity: 1, is_po: true }] }));
    check('Pre-Order + diambil dulu: ditolak 400', x.status === 400, { status: x.status, body: x.body });
    check('alasannya jelas', /belum ada untuk diserahkan/i.test(String(x.body && x.body.error)), x.body);
    x = await req('POST', '/api/orders', pesanan({ picked_up: true, items: [{ ...V, quantity: 1, is_custom_size: true, custom_price: 300000 }] }));
    check('custom + diambil dulu: ditolak 400', x.status === 400, x.body);
    x = await req('POST', '/api/orders', pesanan({ picked_up: true, items: [{ ...V, quantity: 99 }] }));
    // Pemeriksaan stok umum (sebelum transaksi) sudah menolak lebih dulu dengan 400;
    // penjagaan 409 di dalam transaksi adalah lapisan kedua untuk perlombaan.
    check('stok tidak cukup untuk diserahkan: ditolak', x.status === 400 || x.status === 409, { status: x.status, body: x.body });
    check('stok tidak tersentuh sama sekali', stok() === 10, stok());
    check('tidak ada pesanan yang terbuat', one(`SELECT COUNT(*)::int AS n FROM orders`).n === 0);
    // Pembeli website TIDAK boleh menyerahkan barang kepada dirinya sendiri.
    x = await req('POST', '/api/orders', { ...pesanan({ picked_up: true }), order_source: 'website' }, null);
    check('tanpa login: picked_up diabaikan (bukan error)', x.status === 201 || x.status === 200, x.status);
    check('stoknya TIDAK dipotong di muka', stok() === 10, stok());
    check('tidak ditandai diambil', ordir(terakhir()).picked_up_at === null, ordir(terakhir()).picked_up_at);

    group('B. Nomor HP boleh kosong HANYA untuk penjualan tatap muka');
    seed();
    for (const src of ['event_offline', 'offline', 'collaboration_event']) {
        const body = pesanan({ customer_phone: '', order_source: src });
        if (src === 'collaboration_event') body.billing_to = 'PT Uji';
        const y = await req('POST', '/api/orders', body);
        check(`${src}: diterima tanpa nomor`, y.status === 201 || y.status === 200, { src, status: y.status, body: y.body });
        check(`${src}: nomornya tersimpan kosong, bukan diisi karangan`,
            String(ordir(terakhir()).customer_phone || '') === '', ordir(terakhir()).customer_phone);
    }
    let z = await req('POST', '/api/orders', pesanan({ customer_phone: '', order_source: 'whatsapp' }));
    check('whatsapp: TETAP wajib bernomor', z.status === 400, { status: z.status, body: z.body });
    z = await req('POST', '/api/orders', { ...pesanan({ customer_phone: '' }), order_source: 'website' }, null);
    check('website: TETAP wajib bernomor', z.status === 400, z.status);
    z = await req('POST', '/api/orders', pesanan({ customer_phone: '12345', order_source: 'offline' }));
    check('kalau diisi, formatnya tetap diperiksa (nomor ngawur lebih buruk dari kosong)',
        z.status === 400, { status: z.status, body: z.body });

    group('C. shipped_at dicatat saat resi diisi (dasar auto-selesai 1x24 jam)');
    seed();
    r = await req('POST', '/api/orders', pesanan());
    const id4 = terakhir();
    bebaskanBukti(id4);
    await req('PUT', `/api/orders/${id4}/confirm-payment`, {}, ADMIN);
    none(`UPDATE orders SET order_status = 'packed' WHERE id = ${id4}`);
    check('sebelum dikirim, waktunya masih kosong', ordir(id4).shipped_at === null, ordir(id4).shipped_at);
    r = await req('PUT', `/api/orders/${id4}/ship`, { tracking_number: 'JT123456789' }, ADMIN);
    check('pengiriman diterima', r.status === 200, r.body);
    o = ordir(id4);
    check('statusnya dikirim', o.order_status === 'shipped', o.order_status);
    check('waktunya tercatat', o.shipped_at !== null, o.shipped_at);
    check('waktunya masuk akal (beberapa detik terakhir)',
        Math.abs(Date.now() - new Date(o.shipped_at).getTime()) < 60000, o.shipped_at);

    await new Promise(w => setTimeout(w, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
