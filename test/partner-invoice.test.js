// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — Penerbitan tagihan partner (Tahap B)
//
//   Jalankan:  npm test        atau  node test/run-all.js partner-invoice
//
// Ini endpoint yang mengeluarkan angka tagihan ke pihak luar, jadi yang dijaga
// bukan cuma "jalan atau tidak" tapi ANGKANYA BENAR dan tidak bisa dobel:
//
//   1. Ongkir TIDAK ikut ditagihkan (ditanggung Wearscrubs) — ini paling gampang
//      salah karena orders.total_amount SUDAH memuat ongkir
//   2. Order batal TIDAK masuk lembar tagihan sama sekali
//   2b. Bordir ikut tertagih (harga item sudah termasuk) DAN rinciannya tercatat,
//       tanpa pernah ditambahkan dua kali
//   3. Order tanpa nomor kwitansi tidak bisa ditagih
//   4. Satu order tidak bisa masuk dua tagihan aktif
//   5. Batalkan tagihan -> ordernya bebas ditagih ulang
//   6. Isi tagihan adalah SALINAN BEKU — order yang diedit setelah terbit tidak
//      mengubah lembar yang sudah dikirim ke partner
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4718;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'harness_secret';
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, SECRET, { expiresIn: '1h' });
const TOKEN_STAFF = jwt.sign(
    { id: 2, username: 'staff', role: 'staff', allowed_menus: { orders: 'edit' } }, SECRET, { expiresIn: '1h' });

async function req(method, path, body, token) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + (token === undefined ? TOKEN : token) } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const text = await res.text();
    let out; try { out = JSON.parse(text); } catch { out = text; }
    return { status: res.status, body: out };
}

const candidates = (partnerId, qs = '') => req('GET', `/api/admin/partner-billing/candidates?partner_id=${partnerId}${qs}`);
const issue = (payload, token) => req('POST', '/api/admin/partner-billing/invoices', payload, token);

// Tiga order milik partner 1:
//   901 Suci   — 1 pcs, kotor 240.000, potongan 72.000, ONGKIR 50.000  -> ditagih 168.000
//   902 Ayu    — 2 pcs, kotor 565.000, potongan 169.500, ongkir 0      -> ditagih 395.500
//   903 Heidi  — DIBATALKAN                                            -> 0
//   904 Deo    — belum punya nomor kwitansi                            -> tidak bisa ditagih
function seed() {
    none(`DELETE FROM partner_invoice_orders; DELETE FROM partner_invoices;
          DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM stock_movements;
          DELETE FROM orders; DELETE FROM inventory; DELETE FROM products;
          DELETE FROM event_partners;`);
    none(`
    INSERT INTO event_partners (id, name, is_active) VALUES (1, 'PT Arta Otto Indonesia', TRUE), (2, 'PT Lain', TRUE);
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES
      (1, 'DYL', 'Dylan', 'pants', 240000, 110000, TRUE),
      (2, 'MIN', 'Minna', 'tops',  290000, 130000, TRUE);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source,
                        billing_to, partner_id, invoice_date, discount_amount, discount_label, receipt_no) VALUES
      (901, 'WS-EV-901', 'Suci',  '0811', '-', 218000, 'paid', 'done',      50000, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-13', 72000,  'Consignment 30%', '00123'),
      (902, 'WS-EV-902', 'Ayu',   '0812', '-', 395500, 'paid', 'confirmed',     0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-14', 169500, 'Consignment 30%', '00124'),
      (903, 'WS-EV-903', 'Heidi', '0813', '-', 546000, 'paid', 'cancelled',     0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-13', 0,      NULL, '00125'),
      (904, 'WS-EV-904', 'Deo',   '0814', '-', 300000, 'paid', 'done',          0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-08-15', 0,      NULL, NULL);
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price,
                             bordir_nama, bordir_nama_price, bordir_logo, bordir_logo_price) VALUES
      (801, 901, 1, 'L', 'black', 'straight', 1, 240000, FALSE, NULL, FALSE, NULL),
      -- 802 punya bordir nama+logo; harganya SUDAH termasuk bordir 50.000
      (802, 902, 2, 'L', 'black', 'panjang',  1, 290000, TRUE, 20000, TRUE, 30000),
      (803, 902, 2, 'L', 'black', 'pendek',   1, 275000, FALSE, NULL, FALSE, NULL),
      (804, 903, 1, 'M', 'black', 'straight', 1, 546000, FALSE, NULL, FALSE, NULL),
      (805, 904, 1, 'M', 'black', 'straight', 1, 300000, FALSE, NULL, FALSE, NULL);
    `);
}

async function run() {
    await boot(PORT);
    for (let i = 0; i < 6; i++) {
        try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {}
    }

    // 1 — perhitungan kandidat
    seed();
    group('1. Perhitungan kandidat: ongkir tidak ikut, batal tidak bisa ditagih');
    let r = await candidates(1);
    check('diterima', r.status === 200, r);
    const byCode = Object.fromEntries((r.body.orders || []).map(o => [o.order_code, o]));
    check('Suci: kotor 240.000 (bukan 290.000 dgn ongkir)', byCode['WS-EV-901']?.gross_amount === 240000, byCode['WS-EV-901']);
    check('Suci: ditagih 168.000 (ongkir 50.000 TIDAK ikut)', byCode['WS-EV-901']?.net_amount === 168000, byCode['WS-EV-901']);
    check('Ayu: ditagih 395.500', byCode['WS-EV-902']?.net_amount === 395500, byCode['WS-EV-902']);
    check('Heidi (batal): nilai 0', byCode['WS-EV-903']?.net_amount === 0, byCode['WS-EV-903']);
    check('Heidi tetap tampil, tidak dihilangkan', !!byCode['WS-EV-903']);
    check('Heidi tidak bisa ditagih', byCode['WS-EV-903']?.billable === false);
    check('Deo tanpa nomor kwitansi tidak bisa ditagih', byCode['WS-EV-904']?.billable === false);
    check('alasan Deo menyebut kwitansi', /kwitansi/i.test(byCode['WS-EV-904']?.blocked_reason || ''), byCode['WS-EV-904']);
    check('total ringkasan = 563.500 (168.000 + 395.500)', r.body.summary?.total_due === 563500, r.body.summary);
    check('urut menurut nomor kwitansi',
        (r.body.orders || []).map(o => o.receipt_no).join(',') === '00123,00124,00125,', (r.body.orders || []).map(o => o.receipt_no));

    // 2 — terbitkan
    group('2. Terbitkan tagihan');
    r = await issue({ partner_id: 1, order_ids: [901, 902] });
    check('diterima', r.status === 200, r);
    check('total 563.500', r.body.total_due === 563500, r.body);
    check('nomor tagihan berpola WS-TP-', /^WS-TP-\d{8}-\d{4}$/.test(r.body.invoice_no || ''), r.body.invoice_no);
    const invId = r.body.invoice_id;
    check('2 order tersalin aktif',
        one(`SELECT COUNT(*)::int AS n FROM partner_invoice_orders WHERE invoice_id=${invId} AND is_active AND NOT is_cancelled`).n === 2);
    check('order batal TIDAK ikut disalin ke tagihan',
        one(`SELECT COUNT(*)::int AS n FROM partner_invoice_orders WHERE invoice_id=${invId} AND is_cancelled`).n === 0);
    check('total baris tagihan = 2 (hanya yang ditagih)',
        one(`SELECT COUNT(*)::int AS n FROM partner_invoice_orders WHERE invoice_id=${invId}`).n === 2);
    check('status issued', one(`SELECT status FROM partner_invoices WHERE id=${invId}`).status === 'issued');

    // 2b — bordir ikut tertagih DAN terterangkan di tagihan
    group('2b. Bordir ikut ditagih dan tercatat rinciannya');
    r = await req('GET', `/api/admin/partner-billing/invoices/${invId}`);
    const brs = (r.body.orders || []).find(o => o.order_code === 'WS-EV-902');
    const itemBordir = (brs?.items || []).find(i => i.bordir_nama || i.bordir_logo);
    check('item berbordir tersalin dengan penanda', !!itemBordir, brs?.items);
    check('nilai bordir per item tercatat 50.000', Number(itemBordir?.bordir_total) === 50000, itemBordir);
    check('nilai bordir order ikut di ringkasan tagihan',
        Number(r.body.bordir_total || 0) === 50000, r.body.bordir_total);
    // Harga item memang SUDAH termasuk bordir - ini yang menjaga supaya suatu
    // saat nilai bordir tidak tanpa sengaja ditambahkan dua kali.
    check('bordir TIDAK ditambahkan dua kali ke total',
        Number(r.body.gross_total) === 805000, r.body.gross_total);
    check('total tetap 563.500', Number(r.body.total_due) === 563500, r.body.total_due);

    // 3 — anti tagih ganda
    group('3. Order yang sudah ditagih tidak bisa masuk tagihan lain');
    r = await candidates(1);
    const suci = (r.body.orders || []).find(o => o.order_code === 'WS-EV-901');
    check('Suci kini terkunci', suci?.billable === false, suci);
    check('alasannya menyebut tagihan', /tagihan/i.test(suci?.blocked_reason || ''), suci);
    r = await issue({ partner_id: 1, order_ids: [901] });
    check('penerbitan ulang ditolak', r.status === 400, r);
    check('tidak ada tagihan kedua',
        one(`SELECT COUNT(*)::int AS n FROM partner_invoices`).n === 1);

    // 4 — order tanpa kwitansi ditolak saat terbit
    group('4. Order tanpa nomor kwitansi ditolak saat terbit');
    r = await issue({ partner_id: 1, order_ids: [904] });
    check('ditolak 400', r.status === 400, r);
    check('alasannya menyebut kwitansi', /kwitansi/i.test(r.body.error || ''), r.body);

    // 5 — order batal ditolak saat dipilih
    group('5. Order batal tidak bisa dipilih untuk ditagih');
    r = await issue({ partner_id: 1, order_ids: [903] });
    check('ditolak 400', r.status === 400, r);
    check('alasannya menyebut dibatalkan', /batal/i.test(r.body.error || ''), r.body);

    // 6 — salinan beku
    group('6. Isi tagihan adalah salinan beku');
    none(`UPDATE orders SET customer_name = 'NAMA BERUBAH', total_amount = 999 WHERE id = 901`);
    none(`UPDATE order_items SET price = 1 WHERE order_id = 901`);
    r = await req('GET', `/api/admin/partner-billing/invoices/${invId}`);
    const baris = (r.body.orders || []).find(o => o.order_code === 'WS-EV-901');
    check('nama pembeli di tagihan tidak ikut berubah', baris?.customer_name === 'Suci', baris?.customer_name);
    check('nilai di tagihan tidak ikut berubah', Number(baris?.net_amount) === 168000, baris?.net_amount);
    check('total tagihan tidak ikut berubah', Number(r.body.total_due) === 563500, r.body.total_due);

    // 7 — batalkan tagihan
    group('7. Batalkan tagihan -> order bebas ditagih ulang');
    r = await req('PUT', `/api/admin/partner-billing/invoices/${invId}/void`, { reason: 'salah rentang tanggal' });
    check('diterima', r.status === 200, r);
    check('status void', one(`SELECT status FROM partner_invoices WHERE id=${invId}`).status === 'void');
    check('alasan tersimpan', /salah rentang/.test(one(`SELECT void_reason FROM partner_invoices WHERE id=${invId}`).void_reason || ''));
    check('baris isinya dinonaktifkan',
        one(`SELECT COUNT(*)::int AS n FROM partner_invoice_orders WHERE invoice_id=${invId} AND is_active`).n === 0);
    check('tagihan TIDAK dihapus (jejak tetap ada)',
        one(`SELECT COUNT(*)::int AS n FROM partner_invoices WHERE id=${invId}`).n === 1);
    seed();   // reset harga yang sengaja dirusak di langkah 6
    r = await candidates(1);
    check('order bebas lagi',
        (r.body.orders || []).find(o => o.order_code === 'WS-EV-901')?.billable === true);
    check('batal wajib pakai alasan',
        (await req('PUT', `/api/admin/partner-billing/invoices/1/void`, { reason: '' })).status !== 200);

    // 8 — order partner lain
    seed();
    group('8. Order partner lain ditolak');
    r = await issue({ partner_id: 2, order_ids: [901] });
    check('ditolak 400', r.status === 400, r);
    check('alasannya menyebut bukan milik partner', /bukan order/i.test(r.body.error || ''), r.body);

    // 9 — rentang tanggal membatasi pilihan
    seed();
    group('9. Order di luar rentang tanggal ditolak');
    r = await issue({ partner_id: 1, from: '2026-08-14', to: '2026-08-14', order_ids: [901] });
    check('ditolak (901 tanggal 13 Agu)', r.status === 400, r);
    r = await issue({ partner_id: 1, from: '2026-08-14', to: '2026-08-14', order_ids: [902] });
    check('902 di dalam rentang diterima', r.status === 200, r);
    check('hanya 1 order ditagih', r.body.order_count === 1, r.body);

    // 10 — izin
    seed();
    group('10. Butuh izin menu partner-billing');
    r = await issue({ partner_id: 1, order_ids: [901] }, TOKEN_STAFF);
    check('staff tanpa menu ditolak', r.status === 403, r.status);
    r = await issue({ partner_id: 1, order_ids: [901] }, null);
    check('tanpa token ditolak', r.status === 401 || r.status === 403, r.status);
    check('tidak ada tagihan terbit', one(`SELECT COUNT(*)::int AS n FROM partner_invoices`).n === 0);

    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
