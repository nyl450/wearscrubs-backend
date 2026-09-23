// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — batas laju permintaan (rate limit) & urutan middleware
//
//   Jalankan:  npm test     (atau: node test/run-all.js rate-limit)
//
// Bug nyata 23 September 2026: setelah menginput banyak pesanan berturut-turut,
// dashboard tiba-tiba "Failed to fetch" selama belasan menit, padahal Railway
// dan Supabase sehat. Dua sebab yang menumpuk:
//
//   1. Satu jatah 300 permintaan / 15 menit dibagi PER IP untuk semua orang di
//      kantor (James, istri, dan pengunjung website lewat IP yang sama).
//   2. Balasan 429-nya keluar TANPA header CORS karena limiter dipasang sebelum
//      cors, sehingga browser memblokirnya sebelum dibaca — yang terlihat
//      "Failed to fetch", bukan pesan sebenarnya.
//
// Yang dijaga di sini:
//  1. Balasan biasa MEMBAWA header CORS (kontrol).
//  2. Permintaan ber-token dihitung di jatah admin yang besar, bukan jatah
//     publik — ini yang membuat input massal tidak lagi mentok.
//  3. Jatah admin dipisah PER TOKEN: dua admin tidak saling menghabiskan.
//  4. Permintaan tanpa token tetap dibatasi per IP (rem anti-penyalahgunaan).
//
// Catatan: tes ini TIDAK menembak 300+ permintaan (lambat dan rapuh). Yang
// diperiksa adalah penghitung yang dikirim server lewat header RateLimit-*,
// yang memang jadi sumber kebenaran limiternya.
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, check, group, finish } = require('./_bootstrap');

const PORT = 4728;
const BASE = `http://localhost:${PORT}`;
const ORIGIN = 'https://wearscrubs.id';
const TOKEN_A = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, 'harness_secret', { expiresIn: '1h' });
const TOKEN_B = jwt.sign({ id: 2, username: 'istri', role: 'admin' }, 'harness_secret', { expiresIn: '1h' });

async function get(path, token) {
    const headers = { 'Origin': ORIGIN, 'connection': 'close' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(BASE + path, { headers });
    await res.text();
    return {
        status: res.status,
        cors: res.headers.get('access-control-allow-origin'),
        limit: Number(res.headers.get('ratelimit-limit')),
        remaining: Number(res.headers.get('ratelimit-remaining')),
    };
}

async function run() {
    await boot(PORT);

    group('1. Balasan membawa header CORS (kontrol: cors terpasang sebelum limiter)');
    let r = await get('/api/cities');
    check('balas 200', r.status === 200, r);
    check('Access-Control-Allow-Origin ikut terkirim', r.cors === ORIGIN, r.cors);

    group('2. Permintaan ber-token memakai jatah ADMIN yang besar');
    const adm = await get('/api/cities', TOKEN_A);
    check('jatah admin jauh di atas jatah publik (>= 3000)', adm.limit >= 3000, adm.limit);
    check('header CORS tetap ada', adm.cors === ORIGIN, adm.cors);

    group('3. Tanpa token: jatah publik yang ketat, dihitung terpisah dari admin');
    const pub = await get('/api/cities');
    check('jatah publik 300', pub.limit === 300, pub.limit);
    check('jatah publik LEBIH KECIL dari jatah admin', pub.limit < adm.limit, { pub: pub.limit, adm: adm.limit });

    group('4. Jatah admin dipisah per token — dua admin tidak saling menghabiskan');
    // Token A dipakai beberapa kali; sisa token B harus tetap (hampir) penuh.
    await get('/api/cities', TOKEN_A);
    await get('/api/cities', TOKEN_A);
    const a = await get('/api/cities', TOKEN_A);
    const b = await get('/api/cities', TOKEN_B);
    check('token A sudah terpakai beberapa', a.remaining < a.limit - 2, a);
    check('token B masih hampir penuh (tidak ikut terpakai)', b.remaining >= b.limit - 1, b);
    check('keduanya memakai jatah admin', a.limit === b.limit && a.limit >= 3000, { a: a.limit, b: b.limit });

    group('5. Jatah publik tidak ikut berkurang saat admin sibuk');
    const pub2 = await get('/api/cities');
    check('sisa publik berkurang hanya oleh permintaan publik',
        pub.remaining - pub2.remaining === 1, { sebelum: pub.remaining, sesudah: pub2.remaining });

    group('4b. Saat jatah HABIS, balasan 429 TETAP membawa header CORS');
    // Inti bug 23 Sep: tanpa header ini browser memblokir balasannya dan admin
    // melihat "Failed to fetch", bukan pesan sebenarnya. Jatah publik sengaja
    // dihabiskan (300) karena itu yang paling murah untuk ditembak.
    let habis = null;
    for (let i = 0; i < 400 && !habis; i++) {
        const x = await get('/api/cities');
        if (x.status === 429) habis = x;
    }
    check('jatah publik memang bisa habis (429)', !!habis, habis);
    check('429 membawa Access-Control-Allow-Origin', habis && habis.cors === ORIGIN, habis && habis.cors);

    group('4c. Admin TIDAK ikut terkunci saat jatah publik habis');
    const admSetelah = await get('/api/cities', TOKEN_A);
    check('admin tetap dilayani', admSetelah.status === 200, admSetelah);

    await new Promise(x => setTimeout(x, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
