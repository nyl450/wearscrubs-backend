// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — PUT /api/orders/:id/edit, khusus field `invoice_date`
//
//   Jalankan:  npm test          (atau: node test/run-all.js edit-order-date)
//
// Kenapa field ini perlu dijaga tes sendiri:
//
//  1. `invoice_date` bukan sekadar hiasan invoice. Untuk order collaboration_event
//     dialah yang menentukan order masuk PERIODE TAGIHAN PARTNER yang mana
//     (PARTNER_ORDER_DATE = COALESCE(invoice_date, created_at)). Salah simpan =
//     order hilang dari tagihan atau tertagih di bulan yang keliru.
//
//  2. Aturan izinnya halus: hak diperiksa HANYA kalau tanggalnya benar-benar
//     berubah. Modal Edit Pesanan selalu mengirim field ini, jadi kalau suatu
//     saat pengecekannya dibuat tanpa syarat, staff yang tidak berhak
//     mem-backdate akan tertolak untuk SEMUA perubahan lain — nama, alamat,
//     ongkir, semuanya. Kasus 4 di bawah yang menjaganya.
//
//  3. Tanggal disimpan sebagai tengah malam UTC. Kalau suatu saat diganti jadi
//     waktu lokal, tanggalnya bergeser sehari untuk sebagian timezone.
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, api, one, none, check, group, finish } = require('./_bootstrap');

const SECRET = 'harness_secret';
// Staff dengan hak edit menu Orders, TAPI tanpa hak edit manual-order — persis
// profil yang boleh membetulkan alamat tapi tidak boleh mem-backdate penjualan.
const TOKEN_STAFF = jwt.sign(
    { id: 2, username: 'staff', role: 'staff', allowed_menus: { orders: 'edit' } },
    SECRET, { expiresIn: '1h' });

function seed(invoiceDate) {
    none(`DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM orders;`);
    none(`INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address,
                              total_amount, payment_status, order_status, shipping_cost,
                              shipping_courier, order_source, invoice_date)
          VALUES (900, 'WS-TEST-DATE', 'Uji Tanggal', '081234567890', 'Alamat uji',
                  300000, 'pending', 'waiting_payment', 0, 'J&T', 'collaboration_event',
                  ${invoiceDate ? `'${invoiceDate}'` : 'NULL'})`);
}

const tanggalDb = () => {
    const v = one('SELECT invoice_date FROM orders WHERE id = 900').invoice_date;
    return v ? new Date(v).toISOString().slice(0, 10) : null;
};

// Field wajib yang selalu ikut terkirim dari modal Edit Pesanan.
const dasar = { customer_name: 'Uji Tanggal', customer_phone: '081234567890', customer_address: 'Alamat uji' };
const edit = (fields, token) => api('PUT', '/api/orders/900/edit', { ...dasar, ...fields }, token);

async function run() {
    await boot(4718);
    // pg-mem tidak menjalankan ALTER ... DROP/ADD CONSTRAINT yang memperlebar
    // whitelist order_source di initDB, jadi 'collaboration_event' masih ditolak
    // CHECK bawaan. Pola yang sama dipakai partner-invoice.test.js.
    for (let i = 0; i < 6; i++) {
        try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {}
    }

    group('1. Admin membetulkan tanggal yang salah input');
    seed('2026-08-29T00:00:00Z');
    let r = await edit({ invoice_date: '2026-08-13' });
    check('permintaan diterima', r.status === 200, r.body);
    check('tanggal tersimpan jadi 13 Agustus', tanggalDb() === '2026-08-13', tanggalDb());
    check('disimpan sebagai tengah malam UTC, bukan waktu lokal',
        new Date(one('SELECT invoice_date FROM orders WHERE id = 900').invoice_date)
            .toISOString().endsWith('T00:00:00.000Z'),
        one('SELECT invoice_date FROM orders WHERE id = 900').invoice_date);

    group('2. Dikosongkan = hapus override, invoice kembali ke tanggal dibuat');
    seed('2026-08-29T00:00:00Z');
    r = await edit({ invoice_date: '' });
    check('permintaan diterima', r.status === 200, r.body);
    check('invoice_date jadi NULL', tanggalDb() === null, tanggalDb());

    group('3. Format tanggal ngawur ditolak, data lama tidak rusak');
    seed('2026-08-13T00:00:00Z');
    r = await edit({ invoice_date: '13-08-2026' });
    check('ditolak 400', r.status === 400, r.body);
    check('tanggal lama tetap utuh', tanggalDb() === '2026-08-13', tanggalDb());

    group('4. Staff tanpa hak backdate tetap bisa menyimpan perubahan lain');
    // Modal Edit SELALU mengirim invoice_date. Selama nilainya sama dengan yang
    // tersimpan, itu bukan perubahan tanggal dan tidak boleh memblokir apa pun.
    seed('2026-08-13T00:00:00Z');
    r = await edit({ invoice_date: '2026-08-13', customer_address: 'Alamat sudah dibetulkan' }, TOKEN_STAFF);
    check('permintaan diterima', r.status === 200, r.body);
    check('alamat benar-benar berubah',
        one('SELECT customer_address FROM orders WHERE id = 900').customer_address === 'Alamat sudah dibetulkan',
        one('SELECT customer_address FROM orders WHERE id = 900').customer_address);
    check('tanggal tidak bergeser', tanggalDb() === '2026-08-13', tanggalDb());

    group('5. Staff tanpa hak backdate TIDAK boleh menggeser tanggal');
    seed('2026-08-13T00:00:00Z');
    r = await edit({ invoice_date: '2026-07-01' }, TOKEN_STAFF);
    check('ditolak 403', r.status === 403, r.body);
    check('tanggal tidak berubah', tanggalDb() === '2026-08-13', tanggalDb());

    group('6. Staff juga tidak boleh MENGHAPUS tanggal yang sudah ada');
    seed('2026-08-13T00:00:00Z');
    r = await edit({ invoice_date: '' }, TOKEN_STAFF);
    check('ditolak 403', r.status === 403, r.body);
    check('tanggal tidak berubah', tanggalDb() === '2026-08-13', tanggalDb());

    group('7. Order tanpa tanggal: staff kirim kosong = bukan perubahan');
    seed(null);
    r = await edit({ invoice_date: '', customer_name: 'Nama Baru' }, TOKEN_STAFF);
    check('permintaan diterima', r.status === 200, r.body);
    check('nama berubah', one('SELECT customer_name FROM orders WHERE id = 900').customer_name === 'Nama Baru',
        one('SELECT customer_name FROM orders WHERE id = 900').customer_name);
    check('invoice_date tetap NULL', tanggalDb() === null, tanggalDb());

    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
