// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — menu Pengaturan untuk akun staf
//
//   Jalankan:  npm test     (atau: node test/run-all.js settings-staff)
//
// Keputusan James 24 Sep 2026: di Pengaturan, akun staf HANYA boleh "Ganti
// Password". Bagian Partner Collaboration Event, Biaya COGS, dan Manajemen
// Pengguna disembunyikan di layar (initSidebar di dashboard.html).
//
// Tes ini menjaga lapisan server-nya: staf benar-benar bisa mengganti password
// sendiri, dan benar-benar ditolak untuk tiga bagian lain — apa pun yang
// terlihat di layar.
//
// Sekalian menjaga perbaikan bug lama yang ketahuan hari itu: staf tanpa izin
// Overview MUSTAHIL membuka Pengaturan, karena initSidebar melempar layarnya
// kembali ke menu pertama setiap kali dipanggil. Akibatnya mereka tak pernah
// bisa ganti password sendiri. Bagian layarnya tidak bisa diuji dari sini
// (butuh DOM), tapi endpoint-nya wajib tetap terbuka untuk staf — itu yang
// diperiksa di kelompok 1.
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { boot, one, none, check, group, finish } = require('./_bootstrap');

const PORT = 4730;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
const STAF  = jwt.sign({ id: 9, username: 'konten', role: 'staff', allowed_menus: { inventory: 'view' } }, SECRET, { expiresIn: '1h' });
const ADMIN = jwt.sign({ id: 1, username: 'bos', role: 'admin' }, SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + token, 'connection': 'close' } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const t = await res.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: res.status, body: b };
}

function seed() {
    none(`DELETE FROM users;`);
    const hash = bcrypt.hashSync('rahasia-lama', 10);
    none(`INSERT INTO users (id, username, password_hash, role, allowed_menus) VALUES
            (1, 'bos',    '${hash}', 'admin', NULL),
            (9, 'konten', '${hash}', 'staff', '{"inventory":"view"}');`);
}

async function run() {
    await boot(PORT);
    // pg-mem memakai CHECK role asli ('admin','manager','viewer'); produksi sudah
    // diperlebar sehingga peran 'staff' sah (akun nyata: Carissa, inventory:view).
    // Lepas constraint-nya supaya tes memakai peran yang sama dengan produksi.
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE users DROP CONSTRAINT users_constraint_${i}`); } catch (e) {} }
    seed();

    group('1. Staf BISA mengganti passwordnya sendiri (satu-satunya yang boleh)');
    let r = await req('PATCH', '/api/auth/change-password',
        { current_password: 'rahasia-lama', new_password: 'rahasia-baru-123' }, STAF);
    check('diterima 200', r.status === 200, r.body);
    const hashBaru = one('SELECT password_hash FROM users WHERE id = 9').password_hash;
    check('password benar-benar berganti', bcrypt.compareSync('rahasia-baru-123', hashBaru));
    check('password admin TIDAK ikut berubah',
        bcrypt.compareSync('rahasia-lama', one('SELECT password_hash FROM users WHERE id = 1').password_hash));

    group('2. Password lama salah tetap ditolak');
    r = await req('PATCH', '/api/auth/change-password',
        { current_password: 'asal-tebak', new_password: 'percobaan-12345' }, STAF);
    check('ditolak 401', r.status === 401, r.body);
    check('password tidak berubah',
        bcrypt.compareSync('rahasia-baru-123', one('SELECT password_hash FROM users WHERE id = 9').password_hash));

    group('3. Bagian Pengaturan lain DITOLAK untuk staf');
    const terlarang = [
        ['GET',    '/api/settings/cogs',   null, 'baca biaya COGS'],
        ['PUT',    '/api/settings/cogs',   { bordir_nama: 1, bordir_logo: 2 }, 'ubah biaya COGS'],
        ['POST',   '/api/admin/partners',  { name: 'PT Selundupan' }, 'tambah partner'],
        ['PUT',    '/api/admin/partners/1',{ name: 'PT Diubah' }, 'ubah partner'],
        ['DELETE', '/api/admin/partners/1',null, 'hapus partner'],
        ['GET',    '/api/admin/users',     null, 'lihat daftar pengguna'],
    ];
    for (const [m, path, body, nama] of terlarang) {
        const x = await req(m, path, body, STAF);
        check(`${nama}: ditolak 403`, x.status === 403, { path, status: x.status, body: x.body });
    }
    check('tidak ada partner yang terbuat', one('SELECT COUNT(*)::int AS n FROM event_partners').n === 0);

    group('4. Kontrol: admin tetap bisa membuka bagian-bagian itu');
    r = await req('GET', '/api/settings/cogs', null, ADMIN);
    check('admin boleh baca biaya COGS', r.status === 200, r.status);
    r = await req('GET', '/api/admin/users', null, ADMIN);
    check('admin boleh lihat daftar pengguna', r.status === 200, r.status);

    await new Promise(x => setTimeout(x, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
