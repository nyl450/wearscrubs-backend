// Server pratinjau LOKAL untuk melihat dashboard dengan data contoh (pg-mem).
// Bukan tes. Jalankan: node test/_preview-inventory.js  → http://localhost:3000/dashboard.html
// Login: admin / admin123 (akun DEV yang dibuat _bootstrap).
const { boot, none } = require('./_bootstrap');
(async () => {
    await boot(3000);
    none(`
    INSERT INTO products (id, sku, name, category, price, cogs_default, is_active, status) VALUES
      (1, 'MIN', 'Minna', 'tops', 290000, 130000, TRUE, 'active'),
      (2, 'DYL', 'Dylan', 'pants', 240000, 110000, TRUE, 'active');
    INSERT INTO product_variants (product_id, color, variant_type, photo_url, slot) VALUES
      (1, 'charcoal-grey', 'pendek', 'images/Minna SS Light Grey/1.webp', 1),
      (1, 'black', 'panjang', 'images/Matteo LS Black/1.webp', 1);
    INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES
      (1, 'S', 'charcoal-grey', 'pendek', 4, 0), (1, 'M', 'charcoal-grey', 'pendek', 12, 1), (1, 'L', 'charcoal-grey', 'pendek', 0, 0),
      (1, 'S', 'charcoal-grey', 'panjang', 2, 0), (1, 'M', 'charcoal-grey', 'panjang', 9, 0), (1, 'L', 'charcoal-grey', 'panjang', 7, 0),
      (1, 'S', 'black', 'panjang', 3, 0), (1, 'M', 'black', 'panjang', 15, 0),
      (2, 'M', 'charcoal-grey', 'straight', 6, 0), (2, 'L', 'charcoal-grey', 'straight', 1, 0);
    `);
    for (let i = 0; i < 6; i++) { try { none(`ALTER TABLE orders DROP CONSTRAINT orders_constraint_${i}`); } catch (e) {} }
    // Data laporan: order lunas dengan potongan campuran (untuk melihat modul Report).
    none(`
    INSERT INTO event_partners (id, name, is_active) VALUES (1, 'PT Arta Otto Indonesia', TRUE);
    INSERT INTO orders (id, order_code, customer_name, customer_phone, customer_address, total_amount,
                        payment_status, order_status, shipping_cost, shipping_courier, order_source,
                        billing_to, partner_id, paid_at, invoice_date, discount_amount, discount_label) VALUES
      (901, 'WS-EV-901', 'Suci', '0811', '-', 140000, 'paid', 'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, NOW(), NOW(), 60000, 'Consignment 30% (produk + bordir)'),
      (902, 'WS-EV-902', 'Ayu',  '0812', '-', 138600, 'paid', 'done', 0, 'J&T', 'collaboration_event', 'PT Arta Otto Indonesia', 1, NOW(), NOW(), 81400, 'Promo 10% + Consignment 30% (produk + bordir)'),
      (701, 'WS-WA-701', 'Budi', '0813', '-', 305000, 'paid', 'done', 20000, 'J&T', 'whatsapp', NULL, NULL, NOW(), NOW(), 15000, 'Diskon 5% (produk saja)');
    INSERT INTO order_items (id, order_id, product_id, size, color, variant_type, quantity, price, total_cogs) VALUES
      (1, 901, 1, 'M', 'charcoal-grey', 'pendek', 1, 200000, 130000),
      (2, 902, 1, 'M', 'charcoal-grey', 'pendek', 1, 220000, 130000),
      (3, 701, 1, 'M', 'charcoal-grey', 'panjang', 1, 300000, 130000);
    `);
    // Satu tagihan yang SUDAH TERBIT — supaya tab "3 · Tagihan Terbit" ada isinya
    // saat melihat modul ini dengan akun lihat-saja.
    none(`
    INSERT INTO partner_invoices (id, invoice_no, partner_id, partner_name_snapshot, status,
                                  gross_total, discount_total, total_due, order_count, item_count, issued_at) VALUES
      (500, 'INV-PTR-0001', 1, 'PT Arta Otto Indonesia', 'issued', 240000, 72000, 168000, 1, 1, NOW());
    `);
    console.log('Pratinjau siap: http://localhost:3000/dashboard.html (admin / admin123)');
})();
