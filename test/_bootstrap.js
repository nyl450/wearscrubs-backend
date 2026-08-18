// ═══════════════════════════════════════════════════════════════════════════════
// Fondasi bersama untuk semua tes di folder ini.
//
// Modul `pg` ditukar dengan pg-mem (Postgres in-memory), lalu server.js ASLI
// di-load apa adanya. Endpoint dipanggil lewat HTTP sungguhan, jadi yang diuji
// benar-benar handler yang dipakai produksi — dan DB produksi tidak tersentuh.
//
// Dipakai begini di tiap file tes:
//   const { boot, api, db, one, many, none, check, finish } = require('./_bootstrap');
//   await boot(4711);              // port khusus file itu (jangan bentrok)
//
// Catatan: pg-mem melewati sebagian statement initDB() (fungsi window, ALTER
// tertentu). Skema yang dipakai tes tetap yang berhasil dibuat initDB() sendiri.
//
// ⚠️  JEBAKAN pg-mem YANG SUDAH MEMAKAN KORBAN — JANGAN menulis asersi aritmetika
//     pada kolom yang diubah lewat parameter. pg-mem menghitung `kolom - $1`
//     TERBALIK, sebagai `$1 - kolom`:
//         stok 10, dikurangi 3  ->  Postgres: 7   |  pg-mem: -7
//     Penjumlahan aman (komutatif), literal tanpa parameter juga aman.
//     Jadi untuk stok: periksa BARIS MANA yang berubah dan baca `stock_movements`
//     (angkanya dihitung di JS, bukan oleh pg-mem) — bukan hasil hitungannya.
//     Asersi "stok berkurang 2" pernah lolos di sini semata karena 2-2 simetris.
// ═══════════════════════════════════════════════════════════════════════════════
const Module = require('module');
const path = require('path');
const { newDb } = require('pg-mem');
const jwt = require('jsonwebtoken');

const db = newDb();
const pgAdapter = db.adapters.createPg();
const initErrors = [];
let swallow = true;

class SafePool extends pgAdapter.Pool {
    async query(...args) {
        try { return await super.query(...args); }
        catch (e) {
            // Saat initDB berjalan, statement yang tidak didukung pg-mem cukup dilewati.
            if (swallow) { initErrors.push(String(e.message).slice(0, 100)); return { rows: [], rowCount: 0 }; }
            throw e;
        }
    }
}
const fakePg = { Pool: SafePool, Client: pgAdapter.Client, types: pgAdapter.types };
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === 'pg') return fakePg;
    return origRequire.apply(this, arguments);
};

const SECRET = 'harness_secret';
let BASE = '';
let TOKEN = '';

async function boot(port) {
    process.env.DATABASE_URL = 'postgres://test/test';
    process.env.JWT_SECRET = SECRET;
    process.env.PORT = String(process.env.TEST_PORT || port);
    process.env.NODE_ENV = 'test';
    require(path.join(__dirname, '..', 'server.js'));
    BASE = `http://localhost:${process.env.PORT}`;
    TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, SECRET, { expiresIn: '1h' });
    await new Promise(r => setTimeout(r, 1500));   // tunggu initDB selesai
    swallow = false;
    return { initErrors };
}

// Panggil endpoint. Body dikirim urlencoded — multer (upload.any/none) melewatkan
// request non-multipart, jadi express.urlencoded yang mengisi req.body.
async function api(method, pathname, fields, token) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + (token === undefined ? TOKEN : token) } };
    if (fields) {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = body.toString();
    }
    const res = await fetch(BASE + pathname, opts);
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
}

const many = (sql) => db.public.many(sql);
const one = (sql) => many(sql)[0];
const none = (sql) => db.public.none(sql);

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log(`  [OK] ${label}`); }
    else { fail++; console.log(`  [GAGAL] ${label} -> ${JSON.stringify(detail)}`); }
}
function group(title) { console.log(`\n${title}`); }
function finish() {
    console.log(`\n===== HASIL: ${pass} lolos, ${fail} gagal =====`);
    process.exit(fail ? 1 : 0);
}

module.exports = { boot, api, db, many, one, none, check, group, finish };
