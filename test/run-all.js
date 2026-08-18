// Menjalankan semua berkas *.test.js di folder ini, satu per satu.
//
// Tiap tes dijalankan sebagai proses Node sendiri karena masing-masing me-load
// server.js dan membuka portnya sendiri — kalau digabung dalam satu proses,
// database in-memory dan server-nya akan saling menimpa.
//
//   npm test                    -> semua
//   node test/run-all.js edit   -> hanya berkas yang namanya mengandung "edit"
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.test.js'))
    .filter(f => !filter || f.includes(filter))
    .sort();

if (files.length === 0) {
    console.error(filter ? `Tidak ada tes yang cocok dengan "${filter}".` : 'Tidak ada berkas tes.');
    process.exit(1);
}

const hasil = [];
for (const f of files) {
    console.log(`\n${'═'.repeat(72)}\n▶  ${f}\n${'═'.repeat(72)}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
    hasil.push({ f, ok: r.status === 0 });
}

console.log(`\n${'═'.repeat(72)}\nRINGKASAN`);
for (const h of hasil) console.log(`  ${h.ok ? '[LOLOS]' : '[GAGAL]'} ${h.f}`);
const gagal = hasil.filter(h => !h.ok).length;
console.log(`${hasil.length - gagal}/${hasil.length} berkas lolos\n`);
process.exit(gagal ? 1 : 0);
