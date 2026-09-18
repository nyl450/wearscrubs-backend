// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — laporan penjualan memisahkan DISKON PELANGGAN dari CONSIGNMENT
//
//   Jalankan:  npm test     (atau: node test/run-all.js report-potongan)
//
// Permintaan James 18 Sep 2026: di laporan, potongan order event/collab harus
// terbaca sebagai consignment (komisi partner), terpisah dari diskon ke pembeli.
// Angkanya dipecah dari label potongan yang tersimpan di order (satu angka),
// dengan urutan tahap yang sama seperti invoice: promo dulu, consignment dari
// sisanya, tahap terakhir dipaksa = sisa.
//
// Yang dijaga:
//  1. "Consignment 30%" saja       -> seluruhnya consignment.
//  2. "Diskon 5%" saja              -> seluruhnya diskon pelanggan.
//  3. "Promo 10% + Consignment 30%" -> 10% dari kotor = pelanggan, sisanya consignment.
//  4. "(produk saja)"               -> promo dihitung dari kotor TANPA bordir.
//  5. Nominal "Diskon Rp 20.000 + Consignment 30%".
//  6. Label tak terbaca             -> dianggap diskon pelanggan, tidak menebak.
//  7. pelanggan + consignment = total diskon (tidak ada rupiah yang hilang), di
//     ringkasan, per sumber, dan per order untuk Excel.
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, none, check, group, finish } = require('./_bootstrap');

const PORT = 4727;
const BASE = `http://localhost:${PORT}`;
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, 'harness_secret', { expiresIn: '1h' });
async function get(path) {
    const res = await fetch(BASE + path, { headers: { 'Authorization': 'Bearer ' + TOKEN, 'connection': 'close' } });
    const t = await res.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: res.status, body: b };
}

// Semua dibayar 13 Sep. gross = total - ongkir + diskon.
//  901 collab  gross 200.000, "Consignment 30% (produk + bordir)"        disc 60.000
//  902 collab  gross 220.000, "Promo 10% + Consignment 30% (produk + bordir)" disc 81.400 (22.000 + 59.400)
//  903 collab  gross 250.000 (bordir 50.000), "Promo 10% + Consignment 30% (produk saja)"
//              base 200.000 -> promo 20.000 -> sisa 180.000 -> 30% = 54.000 -> disc 74.000
//  904 collab  gross 200.000, "Diskon Rp 25.000 + Consignment 30% (produk + bordir)"
//              25.000 -> sisa 175.000 -> 30% = 52.500 -> disc 77.500
//  905 collab  gross 200.000, "Promo 10% + Consignment 30%" TAPI disc tersimpan 80.000
//              (pernah dikoreksi manual): promo 20.000, consignment = SISA 60.000, bukan 54.000
//  701 whatsapp gross 300.000, "Diskon 5% (produk saja)" disc 15.000
//  702 offline  gross 100.000, "Diskon per produk" (tak terbaca) disc 7.000
function seed() {
    none(`DELETE FROM partner_invoice_orders; DELETE FROM partner_invoices;
          DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM stock_movements;
          DELETE FROM refunds; DELETE FROM orders; DELETE FROM inventory; DELETE FROM products; DELETE FROM event_partners;`);
    none(`
    INSERT INTO event_partners (id, name, is_active) VALUES (1, 'PT Arta Otto Indonesia', TRUE);
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active) VALUES (1, 'MIN', 'Minna', 'tops', 200000, 90000, TRUE);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source,
                        billing_to, partner_id, paid_at, invoice_date, discount_amount, discount_label) VALUES
      (901, 'WS-EV-901', 'A', '0811', '-', 140000, 'paid', 'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', '2026-09-13', 60000, 'Consignment 30% (produk + bordir)'),
      (902, 'WS-EV-902', 'B', '0812', '-', 138600, 'paid', 'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', '2026-09-13', 81400, 'Promo 10% + Consignment 30% (produk + bordir)'),
      (903, 'WS-EV-903', 'C', '0813', '-', 176000, 'paid', 'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', '2026-09-13', 74000, 'Promo 10% + Consignment 30% (produk saja)'),
      (904, 'WS-EV-904', 'D', '0814', '-', 122500, 'paid', 'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', '2026-09-13', 77500, 'Diskon Rp 25.000 + Consignment 30% (produk + bordir)'),
      (905, 'WS-EV-905', 'G', '0817', '-', 120000, 'paid', 'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', '2026-09-13', 80000, 'Promo 10% + Consignment 30% (produk + bordir)'),
      (701, 'WS-WA-701', 'E', '0815', '-', 305000, 'paid', 'done', 20000, 'J&T', 'whatsapp', NULL, NULL, '2026-09-13', '2026-09-13', 15000, 'Diskon 5% (produk saja)'),
      (702, 'WS-OF-702', 'F', '0816', '-', 93000, 'paid', 'done', 0, 'J&T', 'offline', NULL, NULL, '2026-09-13', '2026-09-13', 7000, 'Diskon per produk');
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price, bordir_nama, bordir_nama_price, bordir_logo, bordir_logo_price, total_cogs) VALUES
      (1, 901, 1, 'M', 'black', 'pendek', 1, 200000, FALSE, NULL, FALSE, NULL, 90000),
      (2, 902, 1, 'M', 'black', 'pendek', 1, 220000, FALSE, NULL, FALSE, NULL, 90000),
      (3, 903, 1, 'M', 'black', 'pendek', 1, 250000, TRUE, 20000, TRUE, 30000, 90000),
      (4, 904, 1, 'M', 'black', 'pendek', 1, 200000, FALSE, NULL, FALSE, NULL, 90000),
      (7, 905, 1, 'M', 'black', 'pendek', 1, 200000, FALSE, NULL, FALSE, NULL, 90000),
      (5, 701, 1, 'M', 'black', 'pendek', 1, 300000, FALSE, NULL, FALSE, NULL, 90000),
      (6, 702, 1, 'M', 'black', 'pendek', 1, 100000, FALSE, NULL, FALSE, NULL, 90000);
    `);
}

async function run() {
    await boot(PORT);
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {} }
    seed();
    const Q = 'from=2026-09-01&to=2026-09-30';

    group('1. Ringkasan: pelanggan vs consignment terpisah dan jumlahnya utuh');
    let r = await get('/api/reports/sales?' + Q);
    check('200', r.status === 200, r.body);
    // pelanggan: 902 22.000 + 903 20.000 + 904 25.000 + 905 20.000 + 701 15.000 + 702 7.000 = 109.000
    // consignment: 901 60.000 + 902 59.400 + 903 54.000 + 904 52.500 + 905 60.000 = 285.900
    check('diskon pelanggan 109.000', r.body.discount_customer === 109000, r.body.discount_customer);
    check('consignment 285.900', r.body.consignment === 285900, r.body.consignment);
    check('pelanggan + consignment = total diskon', r.body.discount_customer + r.body.consignment === r.body.discount, r.body);
    check('total diskon 394.900', r.body.discount === 394900, r.body.discount);

    group('2. Saring sumber collab: pelanggan hanya dari promo/nominal collab');
    r = await get('/api/reports/sales?' + Q + '&source=collaboration_event');
    check('pelanggan 87.000', r.body.discount_customer === 87000, r.body.discount_customer);
    check('consignment 285.900', r.body.consignment === 285900, r.body.consignment);

    group('3. Per sumber');
    r = await get('/api/reports/sales-type?' + Q);
    const bySrc = Object.fromEntries((r.body || []).map(x => [x.source, x]));
    check('collab: pelanggan 87.000 / consignment 285.900',
        bySrc.collaboration_event.discount_customer === 87000 && bySrc.collaboration_event.consignment === 285900, bySrc.collaboration_event);
    check('whatsapp: pelanggan 15.000 / consignment 0',
        bySrc.whatsapp.discount_customer === 15000 && bySrc.whatsapp.consignment === 0, bySrc.whatsapp);
    check('offline (label tak terbaca): pelanggan 7.000 / consignment 0',
        bySrc.offline.discount_customer === 7000 && bySrc.offline.consignment === 0, bySrc.offline);

    group('4. Per order untuk Excel (items-detail)');
    r = await get('/api/reports/items-detail?' + Q);
    const baris = Object.fromEntries((r.body || []).map(x => [x.order_code, x]));
    check('903 (produk saja): promo 20.000 dari kotor tanpa bordir, consignment 54.000',
        baris['WS-EV-903'].order_discount_customer === 20000 && baris['WS-EV-903'].order_consignment === 54000, baris['WS-EV-903']);
    check('904 nominal: pelanggan 25.000, consignment 52.500',
        baris['WS-EV-904'].order_discount_customer === 25000 && baris['WS-EV-904'].order_consignment === 52500, baris['WS-EV-904']);
    check('905 dikoreksi manual: consignment = sisa 60.000 supaya jumlahnya utuh 80.000',
        baris['WS-EV-905'].order_discount_customer === 20000 && baris['WS-EV-905'].order_consignment === 60000, baris['WS-EV-905']);
    check('901 consignment murni: pelanggan 0, consignment 60.000',
        baris['WS-EV-901'].order_discount_customer === 0 && baris['WS-EV-901'].order_consignment === 60000, baris['WS-EV-901']);
    check('kotor order ikut dikirim (untuk pembagian per baris)', baris['WS-EV-902'].order_gross === 220000, baris['WS-EV-902'].order_gross);

    await new Promise(x => setTimeout(x, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
