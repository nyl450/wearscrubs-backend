// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — akun Inventori "lihat saja" tidak bisa mengubah stok
//
//   Jalankan:  npm test     (atau: node test/run-all.js inventory-viewonly)
//
// Latar (24 Sep 2026): James membuat akun staf konten sosmed dengan izin
// Inventori "lihat saja", tapi di layar tombol Edit / + / Riwayat masih muncul.
// Tampilannya sudah dibereskan (kelas .edit-action & .viewonly-hide di
// dashboard.html). Tes ini menjaga lapisan yang SEBENARNYA mengamankan data:
// server harus menolak setiap perubahan stok dari akun lihat-saja, apa pun yang
// terlihat di layar — termasuk kalau seseorang memanggil API-nya langsung.
//
// Yang dijaga di sini:
//  1. Keempat jalur tulis inventory ditolak 403 untuk akun lihat-saja.
//  2. Stoknya benar-benar TIDAK berubah (bukan cuma status 403).
//  3. Akun lihat-saja TETAP boleh membaca (itu memang tujuannya).
//  4. Akun ber-izin edit tetap bisa mengubah (kontrol: bukan semua ditolak).
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, none, check, group, finish } = require('./_bootstrap');

const PORT = 4729;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
// Staf konten: HANYA lihat inventori.
const LIHAT = jwt.sign({ id: 9, username: 'konten', role: 'staff', allowed_menus: { inventory: 'view' } }, SECRET, { expiresIn: '1h' });
// Staf gudang: boleh edit inventori (kontrol).
const EDIT  = jwt.sign({ id: 8, username: 'gudang', role: 'staff', allowed_menus: { inventory: 'edit' } }, SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + token, 'connection': 'close' } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const t = await res.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: res.status, body: b };
}

const V = { product_id: 1, size: 'M', color: 'black', variant_type: 'pendek' };
const stok = () => one(`SELECT stock FROM inventory WHERE product_id=1 AND size='M' AND color='black' AND variant_type='pendek'`).stock;

function seed() {
    none(`DELETE FROM stock_movements; DELETE FROM order_items; DELETE FROM orders;
          DELETE FROM inventory; DELETE FROM products;`);
    none(`INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
            (1, 'MIN', 'Minna', 'tops', 290000, 130000, TRUE);
          INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES
            (1, 'M', 'black', 'pendek', 10, 2);`);
}

async function run() {
    await boot(PORT);
    seed();

    group('1. Keempat jalur tulis inventory DITOLAK untuk akun lihat-saja');
    const awal = stok();
    const jalur = [
        ['PUT',  '/api/inventory/single',          { ...V, stock: 99, reason: 'Koreksi Salah Input' }, 'ubah stok satuan'],
        ['POST', '/api/inventory/bulk',            { operation: 'set', value: 99, cells: [V], reason: 'Koreksi Salah Input' }, 'ubah massal'],
        ['POST', '/api/inventory/receive',         { ...V, quantity: 5 }, 'terima stok'],
        ['PUT',  '/api/inventory/reject-to-normal',{ ...V, quantity: 1 }, 'reject jadi normal'],
    ];
    for (const [m, path, body, nama] of jalur) {
        const r = await req(m, path, body, LIHAT);
        check(`${nama}: ditolak 403`, r.status === 403, { path, status: r.status, body: r.body });
        check(`${nama}: pesannya menyebut akses lihat`,
            /lihat|view-only/i.test(String(r.body && r.body.error)), r.body && r.body.error);
    }

    group('2. Stoknya memang tidak berubah (bukan cuma status 403)');
    check(`stok tetap ${awal}`, stok() === awal, { awal, sekarang: stok() });
    check('tidak ada catatan pergerakan stok sama sekali',
        one('SELECT COUNT(*)::int AS n FROM stock_movements').n === 0);

    group('3. Akun lihat-saja TETAP boleh membaca inventori');
    let r = await req('GET', '/api/inventory/all', null, LIHAT);
    check('daftar inventori boleh dibaca', r.status === 200, r.status);
    check('isinya benar-benar terkirim', Array.isArray(r.body) && r.body.length === 1, r.body);
    r = await req('GET', '/api/inventory/movements', null, LIHAT);
    check('riwayat pergerakan juga masih boleh dibaca (layarnya saja yang disembunyikan)',
        r.status === 200, r.status);

    group('4. Kontrol: akun ber-izin edit tetap bisa mengubah');
    r = await req('PUT', '/api/inventory/single', { ...V, stock: 12, reason: 'Koreksi Salah Input' }, EDIT);
    check('diterima 200', r.status === 200, r.body);
    check('stok berubah jadi 12', stok() === 12, stok());

    await new Promise(x => setTimeout(x, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
