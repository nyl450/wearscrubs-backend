// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — Piutang partner event vs uang yang benar-benar masuk
//
//   Jalankan:  npm test        atau  node test/run-all.js piutang
//
// Order collaboration_event berstatus 'paid' artinya PEMBELI sudah bayar — tapi
// ke PARTNER, bukan ke Wearscrubs. Sebelum perbaikan ini, uang yang masih di
// tangan partner ikut terhitung sebagai "Uang Masuk" di dashboard dan Report.
// Akibatnya dua-duanya salah: uang dihitung sebelum diterima, DAN akan terhitung
// dua kali begitu partner melunasi tagihan.
//
// Aturan yang dikunci (keputusan James 27 Agu 2026):
//   • PENJUALAN dicatat saat barang terjual — termasuk event. Tidak berubah.
//   • UANG MASUK untuk event dicatat saat PARTNER MELUNASI TAGIHAN.
//   • Selisihnya = PIUTANG PARTNER.
//   • Margin/profit tetap ikut tanggal barang terjual, bukan tanggal partner bayar.
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, none, check, group, finish } = require('./_bootstrap');

const PORT = 4719;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, SECRET, { expiresIn: '1h' });

async function req(method, path, body) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + TOKEN } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const t = await res.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: res.status, body: b };
}

const sales = (from, to) => req('GET', `/api/reports/sales?from=${from}&to=${to}`);
const overview = () => req('GET', '/api/stats/overview');

// Dua order dibayar 13 Agu:
//   701 WhatsApp biasa — 500.000 (ongkir 0)  -> uang langsung masuk
//   901 Event partner  — 300.000 (ongkir 0)  -> piutang sampai partner bayar
function seed() {
    none(`DELETE FROM partner_invoice_orders; DELETE FROM partner_invoices;
          DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM stock_movements;
          DELETE FROM refunds; DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;
          DELETE FROM event_partners;`);
    none(`
    INSERT INTO event_partners (id, name, is_active) VALUES (1, 'PT Arta Otto Indonesia', TRUE);
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
      (1, 'MIN', 'Minna', 'tops', 300000, 130000, TRUE);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source,
                        billing_to, partner_id, receipt_no, paid_at, invoice_date, discount_amount) VALUES
      (701, 'WS-WA-701', 'Biasa', '0811', '-', 500000, 'paid', 'done', 0, 'J&T', 'whatsapp',
       NULL, NULL, NULL, '2026-08-13', '2026-08-13', 0),
      (901, 'WS-EV-901', 'Suci',  '0812', '-', 300000, 'paid', 'done', 0, 'J&T', 'collaboration_event',
       'PT Arta Otto Indonesia', 1, '00123', '2026-08-13', '2026-08-13', 0);
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price, total_cogs) VALUES
      (601, 701, 1, 'M', 'black', 'pendek', 1, 500000, 130000),
      (602, 901, 1, 'L', 'black', 'pendek', 1, 300000, 130000);
    `);
}

async function run() {
    await boot(PORT);
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {} }

    // 1 — sebelum partner bayar
    seed();
    group('1. Sebelum partner bayar: event jadi piutang, bukan uang masuk');
    let r = await sales('2026-08-01', '2026-08-31');
    check('penjualan tetap memuat event (800.000)', Number(r.body.net) === 800000, r.body.net);
    check('uang masuk HANYA yang non-event (500.000)', Number(r.body.cash_in) === 500000, r.body.cash_in);
    check('piutang 300.000', Number(r.body.receivable) === 300000, r.body.receivable);
    check('1 order event menggantung', r.body.receivable_orders === 1, r.body.receivable_orders);
    check('penjualan − uang masuk = piutang',
        Number(r.body.net) - Number(r.body.cash_in) === Number(r.body.receivable), r.body);

    r = await overview();
    check('dashboard: uang masuk 500.000 (bukan 800.000)', Number(r.body.total_revenue) === 500000, r.body.total_revenue);
    check('dashboard: piutang partner 300.000', Number(r.body.partner_receivable) === 300000, r.body.partner_receivable);

    // 2 — setelah partner bayar
    group('2. Setelah partner melunasi: piutang jadi uang masuk, TIDAK dobel');
    r = await req('POST', '/api/admin/partner-billing/invoices', { partner_id: 1, order_ids: [901] });
    const invId = r.body.invoice_id;
    check('tagihan terbit', r.status === 200, r);
    // Masih piutang selama tagihan belum lunas.
    r = await sales('2026-08-01', '2026-08-31');
    check('terbit saja belum bikin uang masuk', Number(r.body.cash_in) === 500000, r.body.cash_in);
    check('masih piutang 300.000', Number(r.body.receivable) === 300000, r.body.receivable);

    // Partner bayar, tanggalnya 25 Agu (masih dalam periode yang sama).
    const res = await fetch(`${BASE}/api/admin/partner-billing/invoices/${invId}/paid`, {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ paid_at: '2026-08-25' }).toString(),
    });
    check('pelunasan diterima', res.status === 200, res.status);

    r = await sales('2026-08-01', '2026-08-31');
    check('uang masuk jadi 800.000', Number(r.body.cash_in) === 800000, r.body.cash_in);
    check('piutang jadi 0', Number(r.body.receivable) === 0, r.body.receivable);
    // INI JEBAKAN UTAMANYA: penjualan TIDAK boleh ikut naik saat partner bayar.
    // Kalau naik, artinya penjualan event terhitung dua kali.
    check('penjualan TETAP 800.000 (tidak dobel)', Number(r.body.net) === 800000, r.body.net);

    r = await overview();
    check('dashboard: uang masuk jadi 800.000', Number(r.body.total_revenue) === 800000, r.body.total_revenue);
    check('dashboard: piutang jadi 0', Number(r.body.partner_receivable) === 0, r.body.partner_receivable);

    // 3 — uang masuk ikut BULAN PARTNER BAYAR, bukan bulan barang terjual.
    // Barang dijual Juli, partner melunasi Agustus. (Tanggal bayar tidak boleh di
    // masa depan — itu ditolak endpoint — jadi skenarionya dimundurkan, bukan
    // dimajukan.)
    seed();
    none(`UPDATE orders SET paid_at = '2026-07-13', invoice_date = '2026-07-13'`);
    group('3. Barang terjual Juli, partner melunasi Agustus');
    r = await req('POST', '/api/admin/partner-billing/invoices', { partner_id: 1, order_ids: [901] });
    const bayar = await fetch(`${BASE}/api/admin/partner-billing/invoices/${r.body.invoice_id}/paid`, {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ paid_at: '2026-08-25' }).toString(),
    });
    check('pelunasan diterima', bayar.status === 200, bayar.status);
    let jul = await sales('2026-07-01', '2026-07-31');
    let ags = await sales('2026-08-01', '2026-08-31');
    check('Juli: penjualan 800.000 (barang terjual di Juli)', Number(jul.body.net) === 800000, jul.body.net);
    check('Juli: uang masuk cuma 500.000 (event belum dibayar partner)', Number(jul.body.cash_in) === 500000, jul.body.cash_in);
    // Piutang adalah keadaan SEKARANG, bukan potret bulan itu: partnernya sudah
    // membayar (di Agustus), jadi tidak ada lagi yang menggantung dari Juli.
    check('Juli: piutang 0 karena partner sudah melunasi', Number(jul.body.receivable) === 0, jul.body.receivable);
    check('Agustus: penjualan 0 (tidak ada barang terjual)', Number(ags.body.net) === 0, ags.body.net);
    check('Agustus: uang masuk 300.000 (partner bayar di Agustus)', Number(ags.body.cash_in) === 300000, ags.body.cash_in);

    // 4 — tagihan dibatalkan -> kembali jadi piutang
    seed();
    group('4. Tagihan dibatalkan -> uangnya kembali jadi piutang');
    r = await req('POST', '/api/admin/partner-billing/invoices', { partner_id: 1, order_ids: [901] });
    const inv2 = r.body.invoice_id;
    await fetch(`${BASE}/api/admin/partner-billing/invoices/${inv2}/paid`, {
        method: 'PUT', headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ paid_at: '2026-08-25' }).toString(),
    });
    check('lunas dulu -> uang masuk 800.000',
        Number((await sales('2026-08-01', '2026-08-31')).body.cash_in) === 800000);
    await req('PUT', `/api/admin/partner-billing/invoices/${inv2}/unpaid`, { reason: 'salah klik' });
    r = await sales('2026-08-01', '2026-08-31');
    check('batal lunas -> uang masuk turun lagi ke 500.000', Number(r.body.cash_in) === 500000, r.body.cash_in);
    check('piutang muncul lagi 300.000', Number(r.body.receivable) === 300000, r.body.receivable);

    // 5 — margin TIDAK ikut menunggu partner bayar
    seed();
    group('5. Margin tetap ikut tanggal barang terjual');
    r = await req('GET', '/api/reports/margin?from=2026-08-01&to=2026-08-31');
    check('pendapatan margin memuat event (800.000)', Number(r.body.net_revenue) === 800000, r.body.net_revenue);
    check('modal barang ikut terhitung (260.000)', Number(r.body.cogs) === 260000, r.body.cogs);
    check('untung kotor 540.000', Number(r.body.gross_profit) === 540000, r.body.gross_profit);

    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
