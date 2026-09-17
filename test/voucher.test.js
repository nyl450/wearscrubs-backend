// ═══════════════════════════════════════════════════════════════════════════════
// UJI OTOMATIS — nomor voucher promo partner (orders.voucher_no)
//
//   Jalankan:  npm test     (atau: node test/run-all.js voucher)
//
// Event Bali Sept 2026: pembeli produk partner dapat voucher bernomor yang
// ditukar 1 baju Wearscrubs (Ally lengan pendek / Dylan), boleh kelipatan, dan
// boleh berdampingan dengan pembelian biasa (kwitansi). Ditagih ke partner
// seperti pembelian biasa (harga katalog, consignment 30%).
//
// Yang dijaga di sini:
//  1. Satu voucher hanya bisa ditukar SEKALI per partner: kembar dalam satu
//     kiriman, bentrok dengan order tersimpan, lewat 3 jalur (tab Nomor
//     Kwitansi, POST Kasir, PUT Edit Pesanan). Abai huruf besar/kecil.
//  2. Voucher order BATAL tidak memblokir (vouchernya hangus, boleh dipakai lagi
//     hanya kalau ordernya memang batal).
//  3. Order yang hanya punya voucher (tanpa kwitansi) DIHITUNG terisi dan BISA
//     ditagih; nomornya tersalin ke snapshot tagihan.
//  4. Beberapa nomor dalam satu order dinormalisasi "V1, V2" dan kembar di
//     dalam order dibuang diam-diam.
//  5. Order dipindah keluar dari collaboration_event -> voucher dibersihkan.
//
// Batasnya: pg-mem bukan Postgres asli (lihat catatan di edit-order-item.test.js).
// ═══════════════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { boot, one, many, none, check, group, finish } = require('./_bootstrap');

const PORT = 4726;
const BASE = `http://localhost:${PORT}`;
const TOKEN = jwt.sign({ id: 1, username: 'harness', role: 'admin' }, 'harness_secret', { expiresIn: '1h' });
async function req(method, path, body) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + TOKEN, 'connection': 'close' } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const text = await res.text();
    let out; try { out = JSON.parse(text); } catch { out = text; }
    return { status: res.status, body: out };
}
const simpan = (entries) => req('PUT', '/api/admin/partner-billing/receipts', { partner_id: 1, entries });
const kandidat = () => req('GET', '/api/admin/partner-billing/candidates?partner_id=1');
const vch = (id) => one(`SELECT voucher_no, receipt_no FROM orders WHERE id = ${id}`);

// 901 Suci  kwitansi 00123, tanpa voucher
// 902 Ayu   tanpa kwitansi, voucher "V-0001"   -> penukaran murni
// 903 Heidi DIBATALKAN, voucher "V-0002"       -> hangus
// 904 Deo   kosong dua-duanya
function seed() {
    none(`DELETE FROM partner_invoice_orders; DELETE FROM partner_invoices;
          DELETE FROM order_items; DELETE FROM order_photos; DELETE FROM stock_movements;
          DELETE FROM orders; DELETE FROM inventory; DELETE FROM products; DELETE FROM event_partners;`);
    none(`
    INSERT INTO event_partners (id, name, is_active) VALUES (1, 'PT Arta Otto Indonesia', TRUE);
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active, status) VALUES
      (1, 'DYL', 'Dylan', 'pants', 240000, 110000, TRUE, 'active');
    INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES (1, 'M', 'black', 'straight', 10);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source,
                        billing_to, partner_id, invoice_date, discount_amount, discount_label, receipt_no, voucher_no) VALUES
      (901, 'WS-EV-901', 'Suci',  '081234567890', '-', 168000, 'paid', 'done',      0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', 72000, 'Consignment 30% (produk + bordir)', '00123', NULL),
      (902, 'WS-EV-902', 'Ayu',   '081234567891', '-', 168000, 'paid', 'confirmed', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', 72000, 'Consignment 30% (produk + bordir)', NULL,    'V-0001'),
      (903, 'WS-EV-903', 'Heidi', '081234567892', '-', 168000, 'paid', 'cancelled', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-13', 72000, 'Consignment 30% (produk + bordir)', NULL,    'V-0002'),
      (904, 'WS-EV-904', 'Deo',   '081234567893', '-', 168000, 'paid', 'confirmed', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, '2026-09-14', 72000, 'Consignment 30% (produk + bordir)', NULL,    NULL);
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price) VALUES
      (801, 901, 1, 'M', 'black', 'straight', 1, 240000),
      (802, 902, 1, 'M', 'black', 'straight', 1, 240000),
      (803, 903, 1, 'M', 'black', 'straight', 1, 240000),
      (804, 904, 1, 'M', 'black', 'straight', 1, 240000);
    `);
}

async function run() {
    await boot(PORT);
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {} }

    group('1. Tab Nomor Kwitansi: simpan voucher, normalisasi, kembar dalam order dibuang');
    seed();
    let r = await simpan([{ order_id: 904, receipt_no: '', voucher_no: ' v-0010 ; V-0011,v-0010 ' }]);
    check('diterima', r.status === 200, r.body);
    check('tersimpan "v-0010, V-0011"', vch(904).voucher_no === 'v-0010, V-0011', vch(904));
    check('kwitansi tetap kosong', vch(904).receipt_no === null, vch(904));

    group('2. Voucher kembar di dua baris dalam SATU kiriman ditolak');
    seed();
    r = await simpan([{ order_id: 901, receipt_no: '00123', voucher_no: 'V-0010' }, { order_id: 904, receipt_no: '', voucher_no: 'v-0010' }]);
    check('ditolak 400', r.status === 400, r.body);
    check('tidak ada yang tersimpan (semua-atau-tidak)', vch(901).voucher_no === null && vch(904).voucher_no === null);

    group('3. Bentrok dengan voucher order tersimpan (abai huruf besar/kecil)');
    seed();
    r = await simpan([{ order_id: 904, receipt_no: '', voucher_no: 'v-0001' }]);
    check('ditolak 409', r.status === 409, r.body);
    check('pesannya menyebut order pemilik', String(r.body.error).includes('WS-EV-902'), r.body.error);
    check('904 tetap kosong', vch(904).voucher_no === null);

    group('4. Voucher order BATAL tidak memblokir');
    seed();
    r = await simpan([{ order_id: 904, receipt_no: '', voucher_no: 'V-0002' }]);
    check('diterima', r.status === 200, r.body);
    check('tersimpan', vch(904).voucher_no === 'V-0002');

    group('5. Kiriman tanpa field voucher_no tidak menyentuh nilai lama');
    seed();
    r = await simpan([{ order_id: 902, receipt_no: '00130' }]);
    check('diterima', r.status === 200, r.body);
    check('voucher 902 tetap V-0001, kwitansi terisi', vch(902).voucher_no === 'V-0001' && vch(902).receipt_no === '00130', vch(902));
    // Menyimpan ulang voucher milik order itu sendiri bukan bentrokan (layar tab
    // mengirim semua baris yang tampil, termasuk yang tidak berubah).
    r = await simpan([{ order_id: 902, receipt_no: '00130', voucher_no: 'V-0001' }]);
    check('simpan ulang voucher sendiri diterima', r.status === 200, r.body);
    r = await req('PUT', '/api/orders/902/edit', { voucher_no: 'v-0001' });
    check('edit dengan voucher sendiri (beda huruf) diterima', r.status === 200, r.body);

    group('6. Order voucher-saja dihitung terisi dan bisa ditagih; snapshot memuat vouchernya');
    seed();
    r = await req('GET', '/api/admin/partner-billing/receipts?partner_id=1');
    check('filled = 2 (901 kwitansi, 902 voucher), missing = 1 (904)', r.body.filled === 2 && r.body.missing === 1, { filled: r.body.filled, missing: r.body.missing });
    r = await kandidat();
    const ayu = (r.body.orders || []).find(o => o.order_code === 'WS-EV-902');
    check('902 tidak diblokir', ayu && ayu.blocked_reason === null, ayu && ayu.blocked_reason);
    const deo = (r.body.orders || []).find(o => o.order_code === 'WS-EV-904');
    check('904 diblokir: nomor kwitansi / voucher belum diisi', deo && /voucher/i.test(deo.blocked_reason || ''), deo && deo.blocked_reason);
    r = await req('POST', '/api/admin/partner-billing/invoices', { partner_id: 1, order_ids: [901, 902] });
    check('tagihan terbit', r.status === 200, r.body);
    const snap = one(`SELECT voucher_no, receipt_no FROM partner_invoice_orders WHERE order_id = 902`);
    check('snapshot 902 memuat voucher', snap && snap.voucher_no === 'V-0001', snap);

    group('7. Kasir (POST /api/orders): voucher bentrok ditolak, yang baru tersimpan ternormalisasi');
    seed();
    const pesanan = (v) => ({
        customer_name: 'Rara', customer_phone: '081234567899', customer_address: 'Jl. Melati', shipping_cost: 0,
        shipping_courier: 'J&T', order_source: 'collaboration_event', payment_method: 'Cash',
        billing_to: 'PT Arta Otto Indonesia', receipt_no: '', voucher_no: v,
        items: [{ product_id: 1, size: 'M', color: 'black', variant_type: 'straight', quantity: 1 }],
    });
    r = await req('POST', '/api/orders', pesanan('V-0001'));
    check('bentrok -> 409', r.status === 409, r.body);
    r = await req('POST', '/api/orders', pesanan('v-0020, V-0021'));
    check('diterima', r.status === 200 || r.status === 201, r.body);
    const baru = one(`SELECT voucher_no, partner_id FROM orders WHERE customer_name = 'Rara'`);
    check('tersimpan ternormalisasi + partner terhubung', baru.voucher_no === 'v-0020, V-0021' && Number(baru.partner_id) === 1, baru);

    group('8. Edit Pesanan: bentrok ditolak; pindah keluar dari collab membersihkan voucher');
    seed();
    r = await req('PUT', '/api/orders/904/edit', { voucher_no: 'V-0001' });
    check('bentrok -> 409', r.status === 409, r.body);
    r = await req('PUT', '/api/orders/904/edit', { voucher_no: 'V-0030' });
    check('diterima', r.status === 200, r.body);
    check('tersimpan', vch(904).voucher_no === 'V-0030');
    r = await req('PUT', '/api/orders/902/edit', { order_source: 'whatsapp' });
    check('diterima', r.status === 200, r.body);
    check('voucher 902 dibersihkan', vch(902).voucher_no === null, vch(902));

    await new Promise(x => setTimeout(x, 250));
    finish();
}

run().catch(e => { console.error(e); process.exit(1); });
