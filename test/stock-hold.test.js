// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — penahanan stok saat order dibuat (stock_holds)
//
//   Jalankan:  npm test     (atau: node test/run-all.js stock-hold)
//
// Latar (James, 28 Sep 2026): stok BARU dipotong saat pembayaran dikonfirmasi.
// Di antara "order dibuat" dan "order dibayar", barang yang sama masih terlihat
// tersedia untuk pembeli lain — dua orang bisa memesan potongan terakhir yang
// sama dan yang kalah baru ketahuan di kasir (kasus WS-WA-20260903-8151).
//
// Bentuknya penahanan LUNAK: `inventory.stock` TETAP berarti stok fisik dan tetap
// hanya dipotong saat konfirmasi bayar. Yang ditambahkan cuma lapisan
// ketersediaan: tersedia = fisik - yang sedang ditahan pesanan lain.
//
// Yang paling gampang rusak diam-diam, dan karena itu diuji ketat:
//
//  1. **Stok fisik TIDAK boleh ikut berkurang saat order dibuat.** Kalau ini
//     bocor, seluruh invarian "lunas ⇒ potong stok" jadi hitung dua kali dan
//     stok sistem melenceng dari isi rak.
//  2. **Tahanan WAJIB lepas saat lunas.** Stok sudah dipotong betulan di situ;
//     tahanan yang tertinggal membuat barang terhitung dua kali.
//  3. **Tahanan lepas saat batal**, tanpa menunggu waktunya habis.
//  4. **Kedaluwarsa itu pasif** — tahanan yang lewat waktu berhenti dihitung
//     tanpa perlu job apa pun yang harus berhasil jalan.
//  5. **Durasi beda per kanal** (Website 24 jam, sisanya 72 jam) — dari data
//     nyata kecepatan bayar tiap kanal.
//  6. **Pre-Order & custom tidak menahan** (barangnya memang belum ada / tidak
//     punya baris inventory), tapi **bonus menahan** (barangnya tetap keluar rak).
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// Khususnya FOR UPDATE tidak benar-benar mengunci di sini, jadi yang diuji adalah
// KEPUTUSANNYA (ditolak / diterima), bukan penguncian dua permintaan serentak.
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4733;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
const ADMIN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'connection': 'close' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const text = await res.text();
    let out; try { out = JSON.parse(text); } catch { out = text; }
    return { status: res.status, body: out };
}

const V = { product_id: 1, size: 'M', color: 'black', variant_type: 'pendek' };
const stokFisik = () => Number(one(
    `SELECT stock FROM inventory WHERE product_id=1 AND size='M' AND color='black' AND variant_type='pendek'`).stock);
const tersedia = async () => (await req('GET',
    `/api/inventory/1/check?size=M&color=black&type=pendek`)).body;
// confirm-payment mewajibkan foto bukti transfer kecuali ordernya memang tanpa
// pembayaran. Tes ini menguji STOK, bukan unggah berkas — jadi metodenya disetel
// ke Bonus/Free dulu. Pemotongan stok tetap jalan penuh (invarian "lunas ⇒ potong
// stok" berlaku juga untuk order gratis).
const bebaskanBukti = (id) => none(`UPDATE orders SET payment_method = 'Bonus/Free' WHERE id = ${id}`);
const tahanan = (orderId) => many(`SELECT quantity, released_at, release_reason, expires_at FROM stock_holds WHERE order_id = ${orderId}`);

// Satu order publik (website) memesan `qty` potong varian V.
function orderPublik(qty, extra = {}) {
    return {
        customer_name: 'Pembeli', customer_phone: '08110000000', customer_address: 'Jl. Uji No. 1',
        shipping_city: 'Denpasar', shipping_courier: 'J&T', shipping_weight_kg: 1,
        items: [{ ...V, quantity: qty }],
        // Penjaga order kembar (HP + barang identik < 24 jam) bukan yang diuji di
        // sini, dan tes ini sengaja mengirim pesanan identik berkali-kali.
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
      (1, 'M', 'black', 'pendek', 3, 0);
    `);
}

async function run() {
    await boot(PORT);
    for (let i = 0; i < 6; i++) {
        try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {}
    }
    seed();

    group('1. Order dibuat: stok FISIK utuh, yang berubah cuma ketersediaan');
    let r = await req('POST', '/api/orders', orderPublik(2));
    check('order website diterima', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const orderA = Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
    check('stok fisik TETAP 3 — tidak ikut dipotong', stokFisik() === 3, stokFisik());
    check('tidak ada catatan pergerakan stok',
        one(`SELECT COUNT(*)::int AS n FROM stock_movements`).n === 0);
    let t = tahanan(orderA);
    check('tahanannya tercatat 2 pcs', t.length === 1 && Number(t[0].quantity) === 2, t);
    let av = await tersedia();
    check('tersedia tinggal 1', av.available === 1, av);
    check('angka fisiknya tetap dilaporkan apa adanya', av.stock_fisik === 3 && av.held === 2, av);

    group('2. Pembeli kedua yang minta lebih dari sisanya DITOLAK, bukan menumpuk di kasir');
    r = await req('POST', '/api/orders', orderPublik(2));
    check('ditolak 409', r.status === 409, { status: r.status, body: r.body });
    check('pesannya bisa dimengerti pembeli',
        /keburu diambil|tersisa 1/i.test(String(r.body && r.body.error)), r.body);
    check('tidak ada order kedua yang terbuat',
        one(`SELECT COUNT(*)::int AS n FROM orders`).n === 1);
    check('tidak ada tahanan nyangkut dari percobaan gagal',
        one(`SELECT COUNT(*)::int AS n FROM stock_holds`).n === 1);

    group('3. Pembeli kedua yang minta PAS sisanya tetap boleh');
    r = await req('POST', '/api/orders', orderPublik(1));
    check('diterima', r.status === 201 || r.status === 200, { status: r.status, body: r.body });
    const orderB = Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
    av = await tersedia();
    check('tersedia jadi 0', av.available === 0, av);
    check('stok fisik masih 3', stokFisik() === 3, stokFisik());
    r = await req('POST', '/api/orders', orderPublik(1));
    check('pembeli ketiga ditolak 409', r.status === 409, r.status);

    group('4. Lunas: stok dipotong betulan DAN tahanannya dilepas (jangan hitung dua kali)');
    bebaskanBukti(orderA);
    r = await req('PUT', `/api/orders/${orderA}/confirm-payment`, {}, ADMIN);
    check('konfirmasi diterima', r.status === 200, r.body);
    check('stok fisik turun 3 -> 1', stokFisik() === 1, stokFisik());
    t = tahanan(orderA);
    check('tahanannya berstatus lepas', t[0].released_at !== null, t[0]);
    check('alasannya tercatat "lunas"', t[0].release_reason === 'lunas', t[0]);
    av = await tersedia();
    // Fisik 1, masih ada tahanan 1 pcs milik order B yang belum bayar.
    check('tersedia 0 — sisa 1 pcs masih ditahan order B', av.available === 0, av);
    check('yang ditahan tinggal 1 (punya order B saja)', av.held === 1, av);

    group('5. Batal: tahanan dilepas saat itu juga');
    r = await req('PUT', `/api/orders/${orderB}/cancel`, { cancel_reason: 'uji' }, ADMIN);
    check('pembatalan diterima', r.status === 200, r.body);
    t = tahanan(orderB);
    check('tahanannya lepas', t[0].released_at !== null, t[0]);
    check('alasannya tercatat "dibatalkan"', t[0].release_reason === 'dibatalkan', t[0]);
    av = await tersedia();
    check('sisa 1 pcs kembali bisa dijual', av.available === 1, av);
    check('stok fisik tidak ikut naik (order B belum pernah memotong apa pun)',
        stokFisik() === 1, stokFisik());

    group('6. Kedaluwarsa itu PASIF — tidak butuh job yang harus berhasil jalan');
    seed();
    r = await req('POST', '/api/orders', orderPublik(3));
    check('order dibuat', r.status === 201 || r.status === 200, r.status);
    const orderC = Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
    check('tersedia 0 selagi ditahan', (await tersedia()).available === 0);
    // Majukan waktu dengan memundurkan batasnya — persis yang terjadi saat waktunya lewat.
    none(`UPDATE stock_holds SET expires_at = '2020-01-01T00:00:00Z' WHERE order_id = ${orderC}`);
    av = await tersedia();
    check('lewat waktu -> stok kembali bisa dijual tanpa ada yang dijalankan',
        av.available === 3 && av.held === 0, av);
    check('barisnya TIDAK dihapus — jejaknya tetap ada untuk ditelusuri',
        tahanan(orderC).length === 1 && tahanan(orderC)[0].released_at === null);
    r = await req('POST', '/api/orders', orderPublik(3));
    check('pembeli berikutnya kini diterima', r.status === 201 || r.status === 200, r.body);

    group('7. Durasi beda per kanal: Website 24 jam, WhatsApp/Kasir 72 jam');
    seed();
    r = await req('POST', '/api/orders', orderPublik(1));
    const web = Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
    r = await req('POST', '/api/orders', orderPublik(1, { order_source: 'whatsapp' }), ADMIN);
    check('order Kasir diterima', r.status === 201 || r.status === 200, r.body);
    const wa = Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
    const jam = (id) => Math.round(
        (new Date(tahanan(id)[0].expires_at).getTime() - Date.now()) / 3600000);
    check('tahanan order website ~24 jam', Math.abs(jam(web) - 24) <= 1, jam(web));
    check('tahanan order WhatsApp ~72 jam', Math.abs(jam(wa) - 72) <= 1, jam(wa));

    group('8. Pre-Order & custom TIDAK menahan; bonus menahan');
    seed();
    r = await req('POST', '/api/orders', {
        customer_name: 'Admin Kasir', customer_phone: '08110000001', customer_address: '-',
        shipping_city: 'Denpasar', shipping_courier: 'J&T', shipping_weight_kg: 1, shipping_cost: 0,
        items: [
            { ...V, quantity: 1, is_po: true },
            { ...V, quantity: 1, is_custom_size: true, custom_price: 300000 },
            { ...V, quantity: 1, is_bonus: true },
        ],
    }, ADMIN);
    check('order Kasir campuran diterima', r.status === 201 || r.status === 200, r.body);
    const campur = Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
    t = tahanan(campur);
    check('hanya SATU baris tahanan (dari item bonus)', t.length === 1, t);
    check('jumlahnya 1 pcs — PO & custom tidak ikut', Number(t[0].quantity) === 1, t);
    av = await tersedia();
    check('tersedia 3 - 1 = 2', av.available === 2 && av.held === 1, av);

    group('9. Kasir (admin) TIDAK dipalang — admin berhak membuat Pre-Order');
    seed();
    r = await req('POST', '/api/orders', orderPublik(3));
    check('tahanan pertama terpasang', r.status === 201 || r.status === 200, r.status);
    r = await req('POST', '/api/orders', orderPublik(2, { order_source: 'whatsapp' }), ADMIN);
    check('order Kasir tetap diterima walau ketersediaan 0', r.status === 201 || r.status === 200, r.body);
    r = await req('POST', '/api/orders', orderPublik(1));
    check('pembeli website tetap dipalang', r.status === 409, r.status);

    group('10. Edit item: tahanannya ikut pindah varian, batas waktunya tidak mundur');
    seed();
    none(`INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject)
          VALUES (1, 'L', 'black', 'pendek', 5, 0);`);
    r = await req('POST', '/api/orders', orderPublik(2, { order_source: 'whatsapp' }), ADMIN);
    const edit = Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
    // Batas waktunya dimajukan ke angka yang KHAS dulu. Kalau dibiarkan apa adanya,
    // "72 jam dari sekarang" dan "72 jam dihitung ulang sedetik kemudian" nyaris
    // sama — asersi di bawah akan lolos walaupun kodenya diam-diam memperpanjang.
    const expPatok = new Date(Date.now() + 5 * 3600 * 1000);
    none(`UPDATE stock_holds SET expires_at = '${expPatok.toISOString()}' WHERE order_id = ${edit}`);
    const expSebelum = new Date(tahanan(edit)[0].expires_at).getTime();
    const itemId = Number(one(`SELECT id FROM order_items WHERE order_id = ${edit}`).id);
    r = await req('PUT', `/api/orders/${edit}/items/${itemId}`,
        { product_id: 1, color: 'black', variant_type: 'pendek', size: 'L', quantity: 2 }, ADMIN);
    check('edit item diterima', r.status === 200, r.body);
    const aktif = many(`SELECT size, quantity FROM stock_holds WHERE order_id = ${edit} AND released_at IS NULL`);
    check('tahanannya kini di size L', aktif.length === 1 && aktif[0].size === 'L', aktif);
    check('varian M sudah tidak ditahan lagi', (await tersedia()).held === 0, await tersedia());
    const expSesudah = new Date(
        one(`SELECT expires_at FROM stock_holds WHERE order_id = ${edit} AND released_at IS NULL`).expires_at).getTime();
    check('batas waktunya dipertahankan, tidak diperpanjang',
        Math.abs(expSesudah - expSebelum) < 2000, [expSebelum, expSesudah]);

    group('11. Pesanan dipisah: tahanan ikut pindah ke pesanan anak');
    seed();
    r = await req('POST', '/api/orders', {
        customer_name: 'Pembeli', customer_phone: '08110000009', customer_address: '-',
        shipping_city: 'Denpasar', shipping_courier: 'J&T', shipping_weight_kg: 1, shipping_cost: 0,
        items: [{ ...V, quantity: 1 }, { ...V, quantity: 2, bordir_nama: true }],
    }, ADMIN);
    check('order dengan 2 baris dibuat', r.status === 201 || r.status === 200, r.body);
    const induk = Number(one(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`).id);
    check('semuanya ditahan induk (3 pcs)', (await tersedia()).held === 3, await tersedia());
    const barisPindah = Number(many(`SELECT id FROM order_items WHERE order_id = ${induk} ORDER BY id`)[1].id);
    r = await req('POST', `/api/orders/${induk}/split`, { item_ids: [barisPindah] }, ADMIN);
    check('pemisahan diterima', r.status === 200, r.body);
    const anak = Number(r.body.new_order_id);
    check('induk kini menahan 1 pcs',
        many(`SELECT quantity FROM stock_holds WHERE order_id = ${induk} AND released_at IS NULL`)
            .reduce((t, x) => t + Number(x.quantity), 0) === 1);
    check('anak menahan 2 pcs',
        many(`SELECT quantity FROM stock_holds WHERE order_id = ${anak} AND released_at IS NULL`)
            .reduce((t, x) => t + Number(x.quantity), 0) === 2);
    check('jumlah yang ditahan TIDAK berubah — barangnya itu-itu juga',
        (await tersedia()).held === 3, await tersedia());
    // Inti perbaikannya: membatalkan induk tidak boleh melepas stok milik anak.
    r = await req('PUT', `/api/orders/${induk}/cancel`, { cancel_reason: 'uji' }, ADMIN);
    check('induk dibatalkan', r.status === 200, r.body);
    check('stok milik pesanan anak TETAP ditahan', (await tersedia()).held === 2, await tersedia());

    await new Promise(x => setTimeout(x, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
