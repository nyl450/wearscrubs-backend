// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — direktori client (impor dari pesanan, autofill Kasir, klaim akun)
//
// Kuncinya NOMOR WA, bukan nama. Datanya memang menuntut begitu: di pesanan yang
// sudah ada, satu nomor bisa membawa beberapa nama (klinik, keluarga, reseller
// pesan untuk orang lain) dan beberapa alamat. Nama & alamat karena itu jadi
// baris penerima di customer_addresses — boleh banyak per nomor.
//
// `password_hash` NULL = baris direktori, belum jadi akun. Saat customer daftar
// dengan nomor yang sama, barisnya diklaim (tinggal isi password) dan riwayat
// pesanannya ikut — itu inti "pendaftaran jadi gampang".
// ═══════════════════════════════════════════════════════════════════════════════
const { boot, api, one, many, none, check, group, finish } = require('./_bootstrap');

function seed() {
    none(`DELETE FROM customer_addresses; DELETE FROM customers; DELETE FROM orders;`);
    none(`
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, shipping_city,
                        total_amount, payment_status, order_status, created_at) VALUES
      -- satu nomor, dua nama, dua alamat (kasus nyata: 087781936679)
      (1, 'WS-A1', 'Caesary Panjaitan', '087781936679', 'Jl. Melati 1',  'Jakarta Selatan', 100000, 'pending', 'waiting_payment', '2026-01-01'),
      (2, 'WS-A2', 'Trijani Suwandi',   '087781936679', 'Jl. Anggrek 9', 'Bekasi',          100000, 'pending', 'waiting_payment', '2026-02-01'),
      -- nomor sama, format tulisan beda (+62 / spasi) -> harus dianggap satu client
      (3, 'WS-B1', 'dr. Ira',  '08159431994',    'Jl. Kenanga 3', 'Bandung', 100000, 'pending', 'waiting_payment', '2026-01-05'),
      (4, 'WS-B2', 'dr. Ira',  '+62 815 9431994','Jl. Kenanga 3', 'Bandung', 100000, 'pending', 'waiting_payment', '2026-03-05'),
      -- pesanan tanpa alamat & nomor tidak wajar -> dilewati, tidak bikin sampah
      (5, 'WS-C1', 'Tanpa HP', '12',             'Jl. Apa Saja',  'Depok',   100000, 'pending', 'waiting_payment', '2026-01-09');
    `);
}

const importNow = () => api('POST', '/api/admin/clients/backfill');
const cari = (q) => api('GET', `/api/admin/clients/search?q=${encodeURIComponent(q)}`);
const clients = () => many(`SELECT * FROM customers ORDER BY id`);

async function run() {
    await boot(4714);

    group('1. Impor dari pesanan: satu baris client per NOMOR');
    seed();
    let r = await importNow();
    check('status 200', r.status === 200, r.body);
    check('2 client dibuat (087.. dan 0815..), nomor aneh dilewati', clients().length === 2, clients().map(c => c.phone));
    check('nomor +62 dinormalkan jadi 08xx', clients().some(c => c.phone === '08159431994'), clients().map(c => c.phone));
    check('nomor tidak wajar dilewati', r.body.skipped >= 1, r.body);
    check('semua client belum punya password (baru kontak, bukan akun)',
        clients().every(c => c.password_hash === null), clients().map(c => c.password_hash));

    group('2. Nama & alamat berbeda di satu nomor tetap tersimpan semua');
    const cA = clients().find(c => c.phone === '087781936679');
    const alamatA = many(`SELECT * FROM customer_addresses WHERE customer_id = ${cA.id} ORDER BY id`);
    check('2 penerima tersimpan', alamatA.length === 2, alamatA.map(a => a.recipient_name));
    check('nama akun = yang TERBARU dipakai', cA.full_name === 'Trijani Suwandi', cA.full_name);
    check('penerima lama tetap ada', alamatA.some(a => a.recipient_name === 'Caesary Panjaitan'), alamatA.map(a => a.recipient_name));
    check('alamat pertama jadi default', alamatA[0].is_default === true, alamatA[0]);

    group('3. Alamat yang sama persis tidak digandakan');
    const cB = clients().find(c => c.phone === '08159431994');
    check('2 pesanan alamat sama -> 1 baris alamat',
        many(`SELECT * FROM customer_addresses WHERE customer_id = ${cB.id}`).length === 1, 'alamat');

    group('4. Impor diulang: idempoten, tidak menggandakan apa pun');
    const sebelum = { c: clients().length, a: many(`SELECT * FROM customer_addresses`).length };
    r = await importNow();
    check('tidak ada client baru', clients().length === sebelum.c, { sebelum: sebelum.c, sesudah: clients().length });
    check('tidak ada alamat baru', many(`SELECT * FROM customer_addresses`).length === sebelum.a, sebelum.a);
    check('laporan menyebut 0 baru', r.body.customers_created === 0 && r.body.addresses_created === 0, r.body);

    group('5. Autofill Kasir: cari pakai nama, nama penerima lama, atau nomor');
    let s = await cari('Trijani');
    check('cari nama akun ketemu', s.body.length > 0 && s.body[0].phone === '087781936679', s.body);
    s = await cari('Caesary');
    check('cari nama PENERIMA lama ketemu', s.body.some(x => x.name === 'Caesary Panjaitan'), s.body);
    check('hasilnya bawa alamat + kota', s.body.some(x => x.address && x.city), s.body);
    s = await cari('8159431994');
    check('cari pakai potongan nomor ketemu', s.body.some(x => x.phone === '08159431994'), s.body);
    s = await cari('a');
    check('kueri 1 huruf tidak dilayani (hemat)', Array.isArray(s.body) && s.body.length === 0, s.body);
    s = await cari('zzzz-tidak-ada');
    check('tidak ketemu -> daftar kosong, bukan error', s.status === 200 && s.body.length === 0, s.body);
    const noAuth = await api('GET', '/api/admin/clients/search?q=Trijani', null, null);
    check('tanpa token ditolak', noAuth.status === 401, noAuth);

    group('6. Pendaftaran: nomor yang sudah dikenal tinggal DIKLAIM');
    const target = clients().find(c => c.phone === '08159431994');
    let reg = await api('POST', '/api/customer/register', {
        full_name: 'dr. Ira Mayasari', phone: '08159431994', password: 'rahasia123', email: 'ira@contoh.com'
    }, null);
    check('daftar berhasil (tidak ditolak "sudah terdaftar")', reg.status === 200, reg.body);
    check('TIDAK bikin client baru — baris lama yang diklaim', clients().length === 2, clients().map(c => c.phone));
    const claimed = one(`SELECT * FROM customers WHERE phone = '08159431994'`);
    check('id-nya tetap sama', claimed.id === target.id, { sebelum: target.id, sesudah: claimed.id });
    check('password terisi', !!claimed.password_hash, 'password');
    check('nama & email ikut diperbarui', claimed.full_name === 'dr. Ira Mayasari' && claimed.email === 'ira@contoh.com', claimed);
    check('alamat lamanya tetap ada', many(`SELECT * FROM customer_addresses WHERE customer_id = ${claimed.id}`).length === 1, 'alamat');
    check('riwayat pesanan lama otomatis tertaut',
        many(`SELECT id FROM orders WHERE customer_id = ${claimed.id}`).length === 2,
        many(`SELECT id, customer_id FROM orders`));

    group('7. Daftar ulang di nomor yang SUDAH punya password ditolak');
    reg = await api('POST', '/api/customer/register', {
        full_name: 'Orang Lain', phone: '08159431994', password: 'rahasia456', email: 'lain@contoh.com'
    }, null);
    check('ditolak 409', reg.status === 409, reg.body);
    check('pesannya mengarahkan login', /login/i.test(reg.body.error || ''), reg.body.error);

    group('8. Login di nomor yang belum diklaim: diarahkan mendaftar');
    const login = await api('POST', '/api/customer/login', { phone: '087781936679', password: 'apa-saja' }, null);
    check('bukan "password salah"', login.status === 409, login.body);
    check('pesannya menyuruh daftar', /daftar/i.test(login.body.error || ''), login.body.error);

    group('9. Login normal setelah diklaim');
    const ok = await api('POST', '/api/customer/login', { phone: '08159431994', password: 'rahasia123' }, null);
    check('berhasil login', ok.status === 200 && !!ok.body.token, ok.body);
    const salah = await api('POST', '/api/customer/login', { phone: '08159431994', password: 'salah-banget' }, null);
    check('password salah tetap ditolak', salah.status === 401, salah.body);

    group('10. Nama akun milik customer — impor admin tidak menimpanya');
    none(`INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, shipping_city,
                              total_amount, payment_status, order_status, created_at)
          VALUES (6, 'WS-D1', 'Ira salah ketik', '08159431994', 'Jl. Baru 7', 'Bandung', 100000, 'pending', 'waiting_payment', '2026-04-01')`);
    await importNow();
    const setelah = one(`SELECT * FROM customers WHERE phone = '08159431994'`);
    check('nama akun TIDAK ditimpa', setelah.full_name === 'dr. Ira Mayasari', setelah.full_name);
    check('tapi alamat barunya tetap dicatat',
        many(`SELECT * FROM customer_addresses WHERE customer_id = ${setelah.id}`).length === 2, 'alamat');

    finish();
}

run().catch(e => { console.error('ERROR:', e && e.message); process.exit(2); });
