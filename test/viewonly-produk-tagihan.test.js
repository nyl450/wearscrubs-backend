// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — akun "lihat saja" di menu Produk & Tagihan Partner
//
//   Jalankan:  npm test     (atau: node test/run-all.js viewonly-produk-tagihan)
//
// Latar (24 Sep 2026): James memakai akun Sindy/Thea yang di-set lihat-saja.
// Dua keluhan:
//   a) di Produk, tombol Tambah/Edit/Hapus masih ditawarkan;
//   b) di Tagihan Partner layarnya malah DITOLAK — padahal yang diinginkan cuma
//      bisa melihat tagihan yang sudah terbit.
//
// (a) murni tampilan (kelas .edit-action di dashboard.html); yang dijaga di sini
// adalah lapisan yang benar-benar mengamankan data: server harus menolak setiap
// perubahan, apa pun yang terlihat di layar.
//
// (b) BUKAN soal tampilan: daftar partner (`GET /api/admin/partners`) dulu hanya
// mengizinkan menu Kasir, jadi staf yang cuma punya Tagihan Partner kena 403 dan
// dropdown partnernya kosong — layarnya jadi tak terpakai. Sekarang endpoint itu
// menerima salah satu dari dua menu. Kelompok 3 & 5 menjaga perbaikan itu supaya
// tidak diam-diam kembali (termasuk: menerima dua menu BUKAN berarti membuka
// pintu untuk staf yang tidak punya keduanya).
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, none, check, group, finish } = require('./_bootstrap');

const PORT = 4731;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';

// Sindy/Thea: lihat-saja di Produk DAN Tagihan Partner (tanpa menu Kasir).
const LIHAT  = jwt.sign({ id: 9, username: 'sindy', role: 'staff',
    allowed_menus: { products: 'view', 'partner-billing': 'view' } }, SECRET, { expiresIn: '1h' });
// Kontrol: staf gudang yang benar-benar boleh mengubah produk & tagihan.
const EDIT   = jwt.sign({ id: 8, username: 'gudang', role: 'staff',
    allowed_menus: { products: 'edit', 'partner-billing': 'edit' } }, SECRET, { expiresIn: '1h' });
// Kontrol: staf Kasir — dia juga butuh daftar partner (jalur lama, jangan rusak).
const KASIR  = jwt.sign({ id: 7, username: 'kasir', role: 'staff',
    allowed_menus: { 'manual-order': 'edit' } }, SECRET, { expiresIn: '1h' });
// Kontrol negatif: tidak punya Kasir MAUPUN Tagihan Partner.
const ORANG_LAIN = jwt.sign({ id: 6, username: 'konten', role: 'staff',
    allowed_menus: { inventory: 'view' } }, SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + token, 'connection': 'close' } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const t = await res.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: res.status, body: b };
}

function seed() {
    none(`DELETE FROM partner_invoice_orders; DELETE FROM partner_invoices;
          DELETE FROM order_items; DELETE FROM orders; DELETE FROM inventory;
          DELETE FROM products; DELETE FROM event_partners;`);
    none(`
    INSERT INTO event_partners (id, name, is_active) VALUES (1, 'PT Arta Otto Indonesia', TRUE);
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
      (1, 'MIN', 'Minna', 'tops', 290000, 130000, TRUE);
    INSERT INTO partner_invoices (id, invoice_no, partner_id, partner_name_snapshot, status,
                                  gross_total, discount_total, total_due, order_count, item_count) VALUES
      (500, 'INV-PTR-0001', 1, 'PT Arta Otto Indonesia', 'issued', 240000, 72000, 168000, 1, 1);
    `);
}

async function run() {
    await boot(PORT);
    // pg-mem memakai CHECK role asli ('admin','manager','viewer'); produksi sudah
    // diperlebar sehingga peran 'staff' sah. Lepas supaya tes memakai peran nyata.
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE users DROP CONSTRAINT users_constraint_${i}`); } catch (e) {} }
    seed();

    group('1. Produk: semua jalur tulis DITOLAK untuk akun lihat-saja');
    const jalurProduk = [
        ['POST',   '/api/products',   { sku: 'XXX', name: 'Selundupan', category: 'tops', price: 1 }, 'tambah produk'],
        ['PUT',    '/api/products/1', { sku: 'MIN', name: 'Diubah', category: 'tops', price: 1 }, 'ubah produk'],
        ['DELETE', '/api/products/1', null, 'hapus produk'],
    ];
    for (const [m, path, body, nama] of jalurProduk) {
        const r = await req(m, path, body, LIHAT);
        check(`${nama}: ditolak 403`, r.status === 403, { path, status: r.status, body: r.body });
        check(`${nama}: pesannya menyebut akses lihat`,
            /lihat|view-only/i.test(String(r.body && r.body.error)), r.body && r.body.error);
    }

    group('2. Datanya memang tidak berubah (bukan cuma status 403)');
    check('tidak ada produk baru', one('SELECT COUNT(*)::int AS n FROM products').n === 1);
    const p = one('SELECT name, is_active FROM products WHERE id = 1');
    check('nama produk utuh', p.name === 'Minna', p.name);
    // "Hapus" di sini = menonaktifkan (is_active = FALSE), bukan DELETE baris.
    check('produk tidak ikut dinonaktifkan', p.is_active === true, p.is_active);

    group('3. Tagihan Partner: akun lihat-saja BISA melihat (inti keluhan James)');
    let r = await req('GET', '/api/admin/partners?all=1', null, LIHAT);
    check('daftar partner boleh dibaca — dropdown-nya terisi', r.status === 200, { status: r.status, body: r.body });
    check('isinya benar-benar terkirim', Array.isArray(r.body) && r.body.length === 1, r.body);
    // Catatan: daftar tagihan (`GET .../invoices`) TIDAK bisa diuji di sini —
    // query-nya LEFT JOIN ke event_partners dan pg-mem menolaknya ("lookups on
    // joins"). Yang diperiksa penolakannya saja (kelompok 5, izinnya dicek sebelum
    // SQL jalan); sisi "boleh"-nya diwakili endpoint detail di bawah, yang memakai
    // penjaga izin yang sama persis.
    r = await req('GET', '/api/admin/partner-billing/invoices/500', null, LIHAT);
    check('tagihan yang sudah terbit boleh dibuka', r.status === 200, { status: r.status, body: r.body });
    check('isinya benar-benar terkirim',
        r.body && r.body.invoice_no === 'INV-PTR-0001', r.body);

    group('4. Tagihan Partner: jalur tulisnya tetap DITOLAK');
    const jalurTagihan = [
        ['PUT',  '/api/admin/partner-billing/receipts', { partner_id: 1, entries: [{ order_id: 901, receipt_no: '00999' }] }, 'simpan nomor kwitansi'],
        ['POST', '/api/admin/partner-billing/invoices', { partner_id: 1, order_ids: [901] }, 'terbitkan tagihan'],
        ['PUT',  '/api/admin/partner-billing/invoices/500/unpaid', null, 'batalkan lunas'],
        ['PUT',  '/api/admin/partner-billing/invoices/500/void',   { reason: 'iseng' }, 'batalkan tagihan'],
        ['PUT',  '/api/admin/partner-billing/orders/901/consignment', { consignment: true }, 'ubah consignment order'],
    ];
    for (const [m, path, body, nama] of jalurTagihan) {
        const x = await req(m, path, body, LIHAT);
        check(`${nama}: ditolak 403`, x.status === 403, { path, status: x.status, body: x.body });
    }
    check('tidak ada tagihan baru', one('SELECT COUNT(*)::int AS n FROM partner_invoices').n === 1);
    check('tagihan lama tetap berstatus issued',
        one('SELECT status FROM partner_invoices WHERE id = 500').status === 'issued');

    group('5. Kontrol: menerima dua menu tidak membuka pintu untuk orang lain');
    r = await req('GET', '/api/admin/partners?all=1', null, KASIR);
    check('staf Kasir tetap bisa memuat daftar partner (jalur lama)', r.status === 200, r.status);
    r = await req('GET', '/api/admin/partners?all=1', null, ORANG_LAIN);
    check('staf tanpa Kasir & tanpa Tagihan Partner tetap ditolak 403', r.status === 403, r.status);
    r = await req('GET', '/api/admin/partner-billing/invoices', null, ORANG_LAIN);
    check('…dan tidak bisa melihat daftar tagihan', r.status === 403, r.status);

    group('6. Kontrol: akun ber-izin edit tetap bisa mengubah');
    r = await req('DELETE', '/api/products/1', null, EDIT);
    check('hapus produk diterima 200', r.status === 200, r.body);
    check('produk jadi nonaktif', one('SELECT is_active FROM products WHERE id = 1').is_active === false);
    r = await req('PUT', '/api/admin/partner-billing/invoices/500/void', { reason: 'uji kontrol' }, EDIT);
    check('batalkan tagihan diterima 200', r.status === 200, r.body);
    check('statusnya benar-benar void',
        one('SELECT status FROM partner_invoices WHERE id = 500').status === 'void');

    await new Promise(x => setTimeout(x, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
