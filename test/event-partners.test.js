// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — Partner Collaboration Event
//
// `orders.billing_to` selama ini teks bebas, jadi nama PT yang sama gampang
// tertulis beda-beda ejaan dan rekap per partner ikut berantakan. Daftar partner
// ini menyeragamkannya: admin memilih, bukan mengetik ulang.
//
// Partner TIDAK pernah dihapus permanen — hanya dinonaktifkan. Order lama
// menyimpan nama partner sebagai teks, dan riwayat kerja sama yang sudah selesai
// masih perlu terbaca.
// ═══════════════════════════════════════════════════════════════════════════════
const { boot, api, one, many, none, check, group, finish } = require('./_bootstrap');

function seed() {
    none(`DELETE FROM event_partners; DELETE FROM orders;`);
    // Tanpa id eksplisit: kalau id diisi manual, urutan SERIAL tidak ikut maju
    // (perilaku Postgres asli juga) dan insert berikutnya bentrok primary key.
    none(`INSERT INTO event_partners (name, pic_name, phone, city, is_active) VALUES
            ('PT Sehat Bersama',   'Bu Rina',  '0811000111', 'Jakarta Selatan', TRUE),
            ('PT Medika Jaya',     'Pak Doni', '0811000222', 'Bandung',         TRUE),
            ('PT Kerja Sama Lama', NULL,       NULL,         'Depok',           FALSE);`);
}

// id-nya dicari lewat nama supaya tes tidak bergantung pada angka SERIAL.
const idOf = (nama) => one(`SELECT id FROM event_partners WHERE name = '${nama}'`).id;

const list = (qs = '') => api('GET', '/api/admin/partners' + qs);
const add = (fields, token) => api('POST', '/api/admin/partners', fields, token);
const edit = (id, fields) => api('PUT', `/api/admin/partners/${id}`, fields);
const off = (id) => api('DELETE', `/api/admin/partners/${id}`);

async function run() {
    await boot(4715);

    group('1. Daftar partner: default hanya yang aktif');
    seed();
    let r = await list();
    check('status 200', r.status === 200, r.body);
    check('2 partner aktif, yang nonaktif disembunyikan', r.body.length === 2, r.body.map(p => p.name));
    r = await list('?all=1');
    check('all=1 menampilkan yang nonaktif juga', r.body.length === 3, r.body.map(p => p.name));

    group('2. Cari partner (sumber autocomplete Kasir)');
    r = await list('?q=medika');
    check('cari sebagian nama, tidak peduli besar-kecil huruf', r.body.length === 1 && r.body[0].name === 'PT Medika Jaya', r.body);
    r = await list('?q=Rina');
    check('bisa cari lewat nama PIC', r.body.length === 1 && r.body[0].name === 'PT Sehat Bersama', r.body);
    r = await list('?q=zzz');
    check('tidak ketemu -> kosong, bukan error', r.status === 200 && r.body.length === 0, r.body);
    r = await list('?q=lama');
    check('yang nonaktif tidak ikut hasil pencarian Kasir', r.body.length === 0, r.body);

    group('3. Tambah partner');
    seed();
    r = await add({ name: 'PT Baru Sentosa', pic_name: 'Bu Ani', phone: '0812345678', city: 'Surabaya', note: 'consignment 30%' });
    check('status 200', r.status === 200, r.body);
    const baru = one(`SELECT * FROM event_partners WHERE name = 'PT Baru Sentosa'`);
    check('tersimpan lengkap', baru.pic_name === 'Bu Ani' && baru.city === 'Surabaya' && baru.note === 'consignment 30%', baru);
    check('otomatis aktif', baru.is_active === true, baru.is_active);

    group('4. Nama kembar ditolak (inti masalah ejaan tidak konsisten)');
    r = await add({ name: 'pt sehat bersama' });
    check('beda huruf besar-kecil tetap dianggap sama', r.status === 409, r.body);
    r = await add({ name: '   PT Sehat Bersama  ' });
    check('spasi berlebih juga dianggap sama', r.status === 409, r.body);
    r = await add({ name: '' });
    check('nama kosong ditolak', r.status === 400, r.body);

    group('5. Ubah partner');
    seed();
    const idSehat = idOf('PT Sehat Bersama');
    r = await edit(idSehat, { name: 'PT Sehat Bersama', pic_name: 'Pak Budi', phone: '0899', city: 'Depok' });
    check('status 200', r.status === 200, r.body);
    check('PIC & kota berubah', one(`SELECT * FROM event_partners WHERE id=${idSehat}`).pic_name === 'Pak Budi', one(`SELECT * FROM event_partners WHERE id=${idSehat}`));
    r = await edit(idSehat, { name: 'PT Medika Jaya' });
    check('ganti nama jadi kembar ditolak', r.status === 409, r.body);
    r = await edit(999, { name: 'Entah' });
    check('id tidak ada -> 404', r.status === 404, r.body);

    group('6. Nonaktifkan, bukan hapus permanen');
    seed();
    none(`INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                              payment_status, order_status, order_source, billing_to)
          VALUES (1, 'WS-E1', 'Pembeli', '0811', 'Alamat', 100000, 'pending', 'waiting_payment', 'whatsapp', 'PT Sehat Bersama')`);
    const idOff = idOf('PT Sehat Bersama');
    r = await off(idOff);
    check('status 200', r.status === 200, r.body);
    check('barisnya masih ada, hanya nonaktif', one(`SELECT * FROM event_partners WHERE id=${idOff}`).is_active === false, 'is_active');
    check('order lama TIDAK berubah', one(`SELECT billing_to FROM orders WHERE id=1`).billing_to === 'PT Sehat Bersama', 'billing_to');
    check('dilaporkan berapa order terkait', r.body.orders_terkait === 1, r.body);
    check('hilang dari pilihan Kasir', (await list()).body.every(p => p.id !== idOff), (await list()).body.map(p => p.name));

    group('7. Aktifkan lagi');
    r = await edit(idOff, { name: 'PT Sehat Bersama', is_active: 'true' });
    check('kembali muncul di pilihan Kasir', (await list()).body.some(p => p.id === idOff), (await list()).body.map(p => p.name));

    group('8. Izin akses');
    const tanpaToken = await api('GET', '/api/admin/partners', null, null);
    check('baca tanpa token ditolak', tanpaToken.status === 401, tanpaToken);
    const tulisTanpaToken = await add({ name: 'PT Nyelonong' }, null);
    check('tulis tanpa token ditolak', tulisTanpaToken.status === 401, tulisTanpaToken);
    check('tidak ada partner nyelonong masuk', !one(`SELECT COUNT(*)::int AS n FROM event_partners WHERE name='PT Nyelonong'`).n, 'jml');

    finish();
}

run().catch(e => { console.error('ERROR:', e && e.message); process.exit(2); });
