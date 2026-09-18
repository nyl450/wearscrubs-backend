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
    console.log('Pratinjau siap: http://localhost:3000/dashboard.html (admin / admin123)');
})();
