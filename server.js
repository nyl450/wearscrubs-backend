const path = require('path');
const dns = require('dns');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');
const fetch = require('node-fetch');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { CITIES } = require('./cities');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

dns.setDefaultResultOrder('ipv4first');

if (!process.env.DATABASE_URL) {
    console.error('[Config Error] DATABASE_URL tidak ditemukan. Pastikan backend/.env ada dan berisi koneksi PostgreSQL Supabase.');
    process.exit(1);
}

// ─── Security: Helmet ─────────────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// ─── Trust Proxy (Railway / Heroku behind reverse proxy) ──────────────────────
app.set('trust proxy', 1);

// ─── Rate Limiting ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak request, coba lagi setelah 15 menit.' }
});
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: { error: 'Terlalu banyak percobaan login, coba lagi setelah 15 menit.' }
});
app.use('/api/', apiLimiter);

// ─── Middleware ────────────────────────────────────────────────────────────────
// CORS: allow multiple origins (localhost dev + wearscrubs.id production + Railway URL)
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://wearscrubs.id',
    'https://www.wearscrubs.id',
    ...(process.env.RAILWAY_STATIC_URL ? [`https://${process.env.RAILWAY_STATIC_URL}`] : []),
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : []),
];
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, Hostinger server-side) or matching origins
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error(`CORS: Origin ${origin} tidak diizinkan`));
    },
    credentials: true
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ─── In-Memory Cache ──────────────────────────────────────────────────────────
const _cache = new Map();
function getCache(key) {
    const entry = _cache.get(key);
    if (!entry || Date.now() > entry.expiry) { _cache.delete(key); return null; }
    return entry.data;
}
function setCache(key, data, ttlMs = 30000) {
    _cache.set(key, { data, expiry: Date.now() + ttlMs });
}
function invalidateCache(...patterns) {
    for (const key of _cache.keys()) {
        if (patterns.some(p => key.includes(p))) _cache.delete(key);
    }
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(roles = []) {
    return (req, res, next) => {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Autentikasi diperlukan.' });
        try {
            const user = jwt.verify(token, JWT_SECRET);
            if (roles.length && !roles.includes(user.role))
                return res.status(403).json({ error: 'Akses ditolak. Peran tidak cukup.' });
            req.user = user;
            next();
        } catch {
            res.status(401).json({ error: 'Token tidak valid atau sudah kadaluarsa.' });
        }
    };
}

// ─── Static: serve website dari folder public/ ────────────────────────────────
const websiteDir = path.join(__dirname, 'public');
app.use(express.static(websiteDir));

// ─── Multer (memory storage → Supabase Storage) ───────────────────────────────
// Tetap serve /uploads untuk backward-compat dengan foto lama di DB
const uploadsDir = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Supabase Storage client (hanya aktif kalau env vars ada)
const SUPABASE_URL    = process.env.SUPABASE_URL    || null;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY || null;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'wearscrubs';

let supabaseClient = null;
if (SUPABASE_URL && SUPABASE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('[Storage] Supabase Storage aktif — bucket:', SUPABASE_BUCKET);
} else {
    console.warn('[Storage] SUPABASE_URL/SERVICE_KEY tidak ditemukan → fallback ke local disk');
}

/**
 * Upload file buffer ke Supabase Storage.
 * Kalau Supabase tidak dikonfigurasi, fallback ke disk lokal.
 * @param {Buffer} buffer - file buffer dari multer memoryStorage
 * @param {string} originalname - nama file asli (untuk ekstensi)
 * @param {string} folder - subfolder di bucket ('products' | 'orders')
 * @returns {Promise<string>} URL publik foto
 */
async function uploadToSupabase(buffer, originalname, folder = 'products') {
    const ext = path.extname(originalname).toLowerCase();
    const filename = `${folder}/ws_${Date.now()}_${Math.round(Math.random() * 9999)}${ext}`;

    if (supabaseClient) {
        // Upload ke Supabase Storage
        const { data, error } = await supabaseClient
            .storage
            .from(SUPABASE_BUCKET)
            .upload(filename, buffer, {
                contentType: ext === '.jpg' || ext === '.jpeg'
                    ? 'image/jpeg'
                    : ext === '.png' ? 'image/png'
                    : ext === '.webp' ? 'image/webp'
                    : 'image/jpeg',
                upsert: false
            });
        if (error) throw new Error(`Supabase upload error: ${error.message}`);
        // Return URL publik permanen
        const { data: urlData } = supabaseClient
            .storage
            .from(SUPABASE_BUCKET)
            .getPublicUrl(filename);
        return urlData.publicUrl;
    } else {
        // Fallback: simpan ke disk lokal (untuk development)
        const localFilename = `ws_${Date.now()}_${Math.round(Math.random() * 9999)}${ext}`;
        const localPath = path.join(uploadsDir, localFilename);
        fs.writeFileSync(localPath, buffer);
        return `/uploads/${localFilename}`;
    }
}

// Multer: memoryStorage (buffer di RAM, lalu kita upload ke Supabase)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },  // 10 MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Hanya file gambar yang diperbolehkan'));
    }
});

// ─── Database (PostgreSQL / Supabase) ─────────────────────────────────────────
// GANTI: Tidak pakai file .sqlite lagi, pakai koneksi ke Supabase via DATABASE_URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },  // wajib untuk Supabase
    connectionTimeoutMillis: 10000
});

// Helper functions — interface sama seperti sebelumnya, tinggal ganti isinya
const dbRun = async (sql, params = []) => {
    return await pool.query(sql, params);
};
const dbGet = async (sql, params = []) => {
    const result = await pool.query(sql, params);
    return result.rows[0];  // ambil 1 baris
};
const dbAll = async (sql, params = []) => {
    const result = await pool.query(sql, params);
    return result.rows;     // ambil semua baris
};

// ─── DB Initialization: Tables & Seed ────────────────────────────────────────
// GANTI: Hapus semua PRAGMA (itu khusus SQLite). PostgreSQL tidak butuh itu.
// GANTI: INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
// GANTI: datetime('now') → NOW()
async function initDB() {
    // ── Users table ───────────────────────────────────────────────────────────
    await dbRun(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin','manager','viewer')),
        allowed_menus TEXT DEFAULT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW()
    )`);
    await dbRun(`ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_menus TEXT DEFAULT NULL`);

    // ── Products table ────────────────────────────────────────────────────────
    await dbRun(`CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        sku TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('tops','pants','caps','gown')),
        price INTEGER NOT NULL DEFAULT 0,
        price_by_type TEXT DEFAULT NULL,
        short_description TEXT DEFAULT '',
        long_description TEXT DEFAULT '',
        short_description_en TEXT DEFAULT '',
        long_description_en TEXT DEFAULT '',
        sizes TEXT NOT NULL DEFAULT '[]',
        colors TEXT NOT NULL DEFAULT '[]',
        types TEXT NOT NULL DEFAULT '[]',
        is_popular INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','draft','out_of_stock')),
        created_at TIMESTAMP DEFAULT NOW()
    )`);
    // Migrate: add columns if missing (safe for existing tables)
    await dbRun(`ALTER TABLE products ADD COLUMN IF NOT EXISTS price_by_type TEXT DEFAULT NULL`);
    await dbRun(`ALTER TABLE products ADD COLUMN IF NOT EXISTS short_description_en TEXT DEFAULT ''`);
    await dbRun(`ALTER TABLE products ADD COLUMN IF NOT EXISTS long_description_en TEXT DEFAULT ''`);
    await dbRun(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`);

    // ── Product Variants (photos per color/type combination) ─────────────────
    await dbRun(`CREATE TABLE IF NOT EXISTS product_variants (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL,
        color TEXT NOT NULL,
        variant_type TEXT,
        photo_url TEXT,
        CONSTRAINT fk_variants_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);

    // ── Migrate: add slot column (identify which photo 1/2/3 per color/type) ──
    await dbRun(`ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS slot INTEGER`);
    await dbRun(`UPDATE product_variants pv SET slot = sub.rn FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY product_id, color, variant_type ORDER BY id) AS rn
        FROM product_variants WHERE slot IS NULL
    ) sub WHERE pv.id = sub.id AND pv.slot IS NULL`).catch(() => {});
    await dbRun(`ALTER TABLE product_variants ALTER COLUMN slot SET DEFAULT 1`).catch(() => {});
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS uq_variants_slot ON product_variants(product_id, color, variant_type, slot)`).catch(() => {});

    // ── Inventory (stock per product+size+color+type) ─────────────────────────
    await dbRun(`CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL,
        size TEXT NOT NULL,
        color TEXT NOT NULL,
        variant_type TEXT NOT NULL DEFAULT 'null',
        stock INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT fk_inventory_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        CONSTRAINT uq_inventory UNIQUE(product_id, size, color, variant_type)
    )`);

    // ── Orders ────────────────────────────────────────────────────────────────
    await dbRun(`CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_code TEXT UNIQUE NOT NULL,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_address TEXT NOT NULL,
        shipping_city TEXT DEFAULT '',
        shipping_courier TEXT DEFAULT '',
        shipping_weight_kg INTEGER DEFAULT 0,
        shipping_cost INTEGER NOT NULL DEFAULT 0,
        total_amount INTEGER NOT NULL,
        embroidery_details TEXT DEFAULT NULL,
        payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending','paid','rejected')),
        order_status TEXT NOT NULL DEFAULT 'waiting_payment' CHECK(order_status IN ('waiting_payment','confirmed','packed','shipped','done','cancelled')),
        notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
    )`);
    // Migrate: add new columns to existing orders table
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_city TEXT DEFAULT ''`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_courier TEXT DEFAULT ''`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_cost INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_weight_kg INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS embroidery_details TEXT DEFAULT NULL`);

    // ── Order Items ───────────────────────────────────────────────────────────
    await dbRun(`CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        size TEXT NOT NULL,
        color TEXT NOT NULL,
        variant_type TEXT NOT NULL DEFAULT 'null',
        quantity INTEGER NOT NULL DEFAULT 1,
        price INTEGER NOT NULL,
        CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products(id)
    )`);

    // ── Order Photos (proof per process step) ─────────────────────────────────
    await dbRun(`CREATE TABLE IF NOT EXISTS order_photos (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL,
        step TEXT NOT NULL,
        photo_url TEXT NOT NULL,
        note TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT fk_photos_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )`);

    // Migrate: new columns for order tracking & bordir/cancel
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS has_bordir_logo BOOLEAN DEFAULT FALSE`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS has_bordir_nama BOOLEAN DEFAULT FALSE`);
    // Bordir review status: NULL = no bordir, 'pending' = waiting admin review, 'approved' = ok to produce, 'rejected' = admin reject (revisi/refund)
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bordir_status TEXT DEFAULT NULL`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bordir_reject_reason TEXT DEFAULT NULL`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bordir_logo_requested BOOLEAN DEFAULT FALSE`);
    // Migrate: per-item bordir flags on order_items (so invoice can derive base price per item)
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS bordir_nama BOOLEAN DEFAULT FALSE`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS bordir_logo BOOLEAN DEFAULT FALSE`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT DEFAULT NULL`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT DEFAULT NULL`);
    // Migrate: order channel & payment method
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_source TEXT DEFAULT 'website' CHECK(order_source IN ('website', 'whatsapp'))`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT ''`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_percent INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_label TEXT DEFAULT NULL`);

    // ── Migrate: add gown to category constraint ──────────────────────────────
    // Drop old constraint and recreate to include gown (PostgreSQL approach)
    await dbRun(`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_check`).catch(() => {});
    await dbRun(`ALTER TABLE products ADD CONSTRAINT products_category_check CHECK(category IN ('tops','pants','caps','gown'))`).catch(() => {});

    // ── Migrate: add 'bordir' to order_status check constraint ────────────────
    await dbRun(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_status_check`).catch(() => {});
    await dbRun(`ALTER TABLE orders ADD CONSTRAINT orders_order_status_check CHECK(order_status IN ('waiting_payment','confirmed','bordir','packed','shipped','done','cancelled'))`).catch(() => {});


    // ── Stock Movements (log semua perubahan stok) ────────────────────────────
    await dbRun(`CREATE TABLE IF NOT EXISTS stock_movements (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL,
        size TEXT NOT NULL,
        color TEXT NOT NULL,
        variant_type TEXT NOT NULL DEFAULT 'null',
        movement_type TEXT NOT NULL CHECK(movement_type IN ('receive','manual_set','order_out','order_cancel_restore')),
        quantity_change INTEGER NOT NULL,
        quantity_before INTEGER NOT NULL DEFAULT 0,
        quantity_after INTEGER NOT NULL DEFAULT 0,
        note TEXT DEFAULT '',
        order_id INTEGER DEFAULT NULL,
        admin_user TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT fk_sm_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);

    // ── Indexes ───────────────────────────────────────────────────────────────
    const createIdx = (sql) => dbRun(sql).catch(() => {});
    await createIdx('CREATE INDEX IF NOT EXISTS idx_products_category  ON products(category)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_products_status    ON products(status)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_products_popular   ON products(is_popular)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_products_created   ON products(created_at DESC)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_inventory_product  ON inventory(product_id)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_inventory_stock    ON inventory(stock)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_variants_product   ON product_variants(product_id)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(order_status)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_orders_payment     ON orders(payment_status)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_orders_created     ON orders(created_at DESC)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_order_items_order  ON order_items(order_id)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_order_items_prod   ON order_items(product_id)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_sm_product         ON stock_movements(product_id)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_sm_lookup          ON stock_movements(product_id, color, size, variant_type)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_sm_created         ON stock_movements(created_at DESC)');

    // ── Migrate: reject stock support ─────────────────────────────────────────
    await dbRun(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS stock_reject INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS is_reject BOOLEAN DEFAULT FALSE`);
    // Extend movement_type CHECK to allow reject movement types
    await dbRun(`ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check`);
    await dbRun(`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
        CHECK(movement_type IN ('receive','manual_set','order_out','order_cancel_restore','receive_reject','reject_to_normal'))`);

    // ── Refunds (state machine: pending → transferred → completed) ────────────
    // Separate table because: 1 order can have multiple refunds (cancel + partial bordir).
    // Fields are LOCKED after status='transferred' except internal_notes.
    await dbRun(`CREATE TABLE IF NOT EXISTS refunds (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL,
        refund_type TEXT NOT NULL DEFAULT 'order_cancel' CHECK(refund_type IN ('order_cancel','bordir_reject','partial')),
        amount INTEGER NOT NULL DEFAULT 0,
        reason TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','transferred','completed','cancelled')),
        bank_name TEXT DEFAULT '',
        bank_account_number TEXT DEFAULT '',
        bank_account_holder TEXT DEFAULT '',
        proof_url TEXT DEFAULT NULL,
        internal_notes TEXT DEFAULT '',
        created_by TEXT DEFAULT '',
        transferred_by TEXT DEFAULT NULL,
        transferred_at TIMESTAMP DEFAULT NULL,
        completed_at TIMESTAMP DEFAULT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT fk_refunds_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )`);
    await dbRun('CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id)').catch(() => {});
    await dbRun('CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status)').catch(() => {});
    await dbRun('CREATE INDEX IF NOT EXISTS idx_refunds_created ON refunds(created_at DESC)').catch(() => {});

    // ── Seed default admin ────────────────────────────────────────────────────
    const existingAdmin = await dbGet('SELECT id FROM users WHERE username = $1', ['admin']);
    if (!existingAdmin) {
        const hash = await bcrypt.hash('admin123', 10);
        await dbRun(
            'INSERT INTO users (username, password_hash, role, allowed_menus) VALUES ($1, $2, $3, $4)',
            ['admin', hash, 'admin', null]
        );
        console.log('[Auth] Admin default dibuat: username=admin, password=admin123');
        console.log('[Auth] SEGERA GANTI PASSWORD setelah login pertama!');
    }
}
initDB().catch(err => console.error('[DB Init Error]', err));


// ─── WhatsApp Notification (Fonnte) ──────────────────────────────────────────
async function sendWANotification(message) {
    const token = process.env.FONNTE_TOKEN;
    const target = process.env.ADMIN_WA_NUMBER;
    if (!token || token === 'GANTI_DENGAN_TOKEN_FONNTE_ANDA') {
        console.log('[WA] Token belum dikonfigurasi. Notifikasi dilewati.');
        return;
    }
    try {
        const res = await fetch('https://api.fonnte.com/send', {
            method: 'POST',
            headers: { 'Authorization': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ target, message, countryCode: '62' })
        });
        const data = await res.json();
        console.log('[WA] Notifikasi terkirim:', data);
    } catch (err) {
        console.error('[WA] Gagal kirim notifikasi:', err.message);
    }
}

function generateOrderCode(source = 'website') {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const prefix = source === 'whatsapp' ? 'WS-WA' : 'WS';
    return `${prefix}-${y}${m}${d}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
}

function safeJSON(str, fallback = []) {
    try { return JSON.parse(str); } catch { return fallback; }
}

const COLOR_HEX = {
    'black': '#000000',
    'beige': '#d7c5a9',
    'olive': '#696250',
    'charcoal-grey': '#5f5051',
    'light-grey': '#898391',
    'maroon': '#6c1b22',
    'purple': '#a4b4e8',
    'blush': '#f0c6bb',
    'turquoise': '#40e0d0',
    'white': '#f0f0f0'
};
const COLOR_LABEL = {
    'black': 'Black',
    'beige': 'Beige',
    'olive': 'Olive',
    'charcoal-grey': 'Charcoal Grey',
    'light-grey': 'Light Grey',
    'maroon': 'Maroon',
    'purple': 'Purple',
    'blush': 'Blush',
    'turquoise': 'Turquoise',
    'white': 'White'
};

function formatProduct(p, mainPhoto = null) {
    const priceByType = safeJSON(p.price_by_type, null);
    return {
        ...p,
        sizes: safeJSON(p.sizes, []),
        colors: safeJSON(p.colors, []),
        types: safeJSON(p.types, []),
        price_by_type: priceByType,
        main_photo: mainPhoto || '',
        price_formatted: `Rp ${Number(p.price).toLocaleString('id-ID')}`,
        color_hex_map: COLOR_HEX,
        color_label_map: COLOR_LABEL,
        short_description: p.short_description || '',
        long_description: p.long_description || '',
        short_description_en: p.short_description_en || '',
        long_description_en: p.long_description_en || ''
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── AUTH ──────────────────────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi.' });

        // GANTI: ? → $1
        const user = await dbGet('SELECT * FROM users WHERE username = $1 AND is_active = 1', [username.trim()]);
        if (!user) return res.status(401).json({ error: 'Username atau password salah.' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Username atau password salah.' });

        const allowedMenus = user.allowed_menus ? JSON.parse(user.allowed_menus) : null;
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, allowed_menus: allowedMenus },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );
        res.json({
            token,
            user: { id: user.id, username: user.username, role: user.role, allowed_menus: allowedMenus }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth(), (req, res) => {
    res.json({ user: req.user });
});

// ── USER MANAGEMENT ───────────────────────────────────────────────────────────

// GET /api/admin/users
app.get('/api/admin/users', requireAuth(['admin']), async (req, res) => {
    try {
        const users = await dbAll('SELECT id, username, role, allowed_menus, is_active, created_at FROM users ORDER BY id ASC');
        res.json(users.map(u => ({ ...u, allowed_menus: u.allowed_menus ? JSON.parse(u.allowed_menus) : null })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/users
app.post('/api/admin/users', requireAuth(['admin']), async (req, res) => {
    try {
        const { username, password, role, allowed_menus } = req.body;
        if (!username || !password || !role) return res.status(400).json({ error: 'Semua field wajib diisi.' });
        if (!['admin', 'manager', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role tidak valid.' });
        if (password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter.' });

        const hash = await bcrypt.hash(password, 10);
        const allowedMenusStr = (Array.isArray(allowed_menus) && allowed_menus.length > 0)
            ? JSON.stringify(allowed_menus) : null;

        // GANTI: ? → $1,$2,$3,$4 | tambah RETURNING id
        const result = await dbRun(
            'INSERT INTO users (username, password_hash, role, allowed_menus) VALUES ($1, $2, $3, $4) RETURNING id',
            [username.trim(), hash, role, allowedMenusStr]
        );
        const newId = result.rows[0].id; // GANTI: result.lastID → result.rows[0].id
        res.json({ id: newId, username, role, allowed_menus: allowed_menus || null });
    } catch (err) {
        if (err.message.includes('unique') || err.message.includes('UNIQUE'))
            return res.status(409).json({ error: 'Username sudah digunakan.' });
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/admin/users/:id
app.patch('/api/admin/users/:id', requireAuth(['admin']), async (req, res) => {
    try {
        const { id } = req.params;
        const { role, password, is_active, allowed_menus } = req.body;

        // GANTI: ? → $1, $2
        if (role) {
            if (!['admin', 'manager', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role tidak valid.' });
            await dbRun('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
        }
        if (password) {
            if (password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter.' });
            const hash = await bcrypt.hash(password, 10);
            await dbRun('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
        }
        if (is_active !== undefined) {
            await dbRun('UPDATE users SET is_active = $1 WHERE id = $2', [is_active ? 1 : 0, id]);
        }
        if (allowed_menus !== undefined) {
            const allowedMenusStr = (Array.isArray(allowed_menus) && allowed_menus.length > 0)
                ? JSON.stringify(allowed_menus) : null;
            await dbRun('UPDATE users SET allowed_menus = $1 WHERE id = $2', [allowedMenusStr, id]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/auth/change-password
app.patch('/api/auth/change-password', requireAuth(), async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        if (!current_password || !new_password) return res.status(400).json({ error: 'Semua field wajib diisi.' });
        if (new_password.length < 8) return res.status(400).json({ error: 'Password baru minimal 8 karakter.' });

        // GANTI: ? → $1
        const user = await dbGet('SELECT * FROM users WHERE id = $1', [req.user.id]);
        const valid = await bcrypt.compare(current_password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Password lama tidak sesuai.' });

        const hash = await bcrypt.hash(new_password, 10);
        // GANTI: ? → $1, $2
        await dbRun('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', requireAuth(['admin']), async (req, res) => {
    try {
        const { id } = req.params;
        if (parseInt(id) === req.user.id) return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri.' });
        // GANTI: ? → $1
        await dbRun('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────────

// GET /api/products
app.get('/api/products', async (req, res) => {
    try {
        const { category, status, popular } = req.query;
        let sql = `
            SELECT p.*,
                   (SELECT pv.photo_url FROM product_variants pv
                    WHERE pv.product_id = p.id ORDER BY pv.id ASC LIMIT 1) AS main_photo
            FROM products p WHERE p.is_active = TRUE`;
        const params = [];
        let idx = 1; // GANTI: track nomor $N

        if (category) { sql += ` AND p.category = $${idx++}`; params.push(category); }
        if (status && status !== 'all') { sql += ` AND p.status = $${idx++}`; params.push(status); }
        else if (!status) { sql += ` AND p.status != 'draft'`; }
        if (popular === '1') { sql += ` AND p.is_popular = 1`; }

        sql += ' ORDER BY p.created_at DESC';
        const rows = await dbAll(sql, params);
        res.json(rows.map(r => formatProduct(r, r.main_photo)));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/products/popular
app.get('/api/products/popular', async (req, res) => {
    try {
        // GANTI: GROUP_CONCAT → STRING_AGG (PostgreSQL)
        const rows = await dbAll(`
            SELECT p.*,
                   (SELECT pv.photo_url FROM product_variants pv
                    WHERE pv.product_id = p.id ORDER BY pv.id ASC LIMIT 1) AS main_photo,
                   (SELECT STRING_AGG(pv2.photo_url, '||') FROM
                    (SELECT photo_url FROM product_variants WHERE product_id = p.id
                     AND photo_url IS NOT NULL ORDER BY id ASC LIMIT 2) pv2) AS photos_raw
            FROM products p WHERE p.is_popular = 1 AND p.status = 'active' AND p.is_active = TRUE
            ORDER BY p.created_at DESC LIMIT 4`);
        res.json(rows.map(r => {
            const photos = r.photos_raw ? r.photos_raw.split('||').filter(Boolean) : (r.main_photo ? [r.main_photo] : []);
            const formatted = formatProduct(r, r.main_photo);
            formatted.photos = photos;
            return formatted;
        }));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/products/popular
app.put('/api/products/popular', requireAuth(['admin','manager']), async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length > 4)
            return res.status(400).json({ error: 'Maksimal 4 produk popular' });

        await dbRun('UPDATE products SET is_popular = 0');
        if (ids.length > 0) {
            // GANTI: map ? → $1,$2,... sesuai index
            const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
            await dbRun(`UPDATE products SET is_popular = 1 WHERE id IN (${placeholders})`, ids);
        }
        res.json({ message: 'Produk popular diperbarui' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/products/:id
app.get('/api/products/:id', async (req, res) => {
    try {
        // GANTI: ? → $1
        const p = await dbGet('SELECT * FROM products WHERE id = $1', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Produk tidak ditemukan' });

        const variantRows = await dbAll('SELECT * FROM product_variants WHERE product_id = $1 ORDER BY color, variant_type, slot ASC NULLS LAST, id ASC', [p.id]);
        const inventory = await dbAll('SELECT * FROM inventory WHERE product_id = $1', [p.id]);
        const mainPhoto = (variantRows.find(r => r.photo_url) || {}).photo_url || '';

        const variantMap = {};
        variantRows.forEach(row => {
            const key = `${row.color}__${row.variant_type}`;
            if (!variantMap[key]) {
                variantMap[key] = { color: row.color, variant_type: row.variant_type, photos: [] };
            }
            const idx = (row.slot || 1) - 1;
            variantMap[key].photos[idx] = row.photo_url || null;
        });
        const variants = Object.values(variantMap);

        res.json({ ...formatProduct(p, mainPhoto), variants, inventory });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/products
app.post('/api/products', requireAuth(['admin','manager']), upload.any(), async (req, res) => {
    try {
        const { sku, name, category, price, short_description, long_description,
            short_description_en, long_description_en,
            sizes, colors, types, is_popular, status, price_by_type } = req.body;

        if (!sku || !name || !category)
            return res.status(400).json({ error: 'SKU, nama, dan kategori wajib diisi' });

        const priceByTypeObj = price_by_type ? safeJSON(price_by_type, null) : null;
        const values = priceByTypeObj
            ? Object.values(priceByTypeObj).map(Number).filter(v => v > 0)
            : [];
        const basePrice = values.length > 0 ? Math.min(...values) : parseInt(price || 0);

        const result = await dbRun(
            `INSERT INTO products (sku, name, category, price, price_by_type,
              short_description, long_description, short_description_en, long_description_en,
              sizes, colors, types, is_popular, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
            [sku, name, category, basePrice,
                priceByTypeObj ? JSON.stringify(priceByTypeObj) : null,
                short_description || '', long_description || '',
                short_description_en || '', long_description_en || '',
                typeof sizes === 'string' ? sizes : JSON.stringify(sizes),
                typeof colors === 'string' ? colors : JSON.stringify(colors),
                typeof types === 'string' ? types : JSON.stringify(types),
                is_popular === '1' || is_popular === true ? 1 : 0,
                status || 'active']
        );

        // GANTI: result.lastID → result.rows[0].id
        const productId = result.rows[0].id;

        const photoMap = safeJSON(req.body.photo_map, {});
        const selColors = safeJSON(colors, []);
        const selTypes = safeJSON(types, []);
        const selSizes = safeJSON(sizes, []);

        for (const color of selColors) {
            for (const type of selTypes) {
                const NUM_PHOTOS = 3;
                let mainPhotoUrl = null;

                for (let i = 1; i <= NUM_PHOTOS; i++) {
                    const mapKey = `${color}_${type}_${i}`;
                    let photoUrl = req.body[`photo_url_${mapKey}`] || null;
                    if (!photoUrl) {
                        const fileField = photoMap[mapKey];
                        const file = req.files && req.files.find(f => f.fieldname === fileField || f.fieldname === `photo_${mapKey}`);
                        if (file) photoUrl = await uploadToSupabase(file.buffer, file.originalname, 'products');
                    }
                    if (!photoUrl && i === 1) {
                        const oldKey = `${color}_${type}`;
                        photoUrl = req.body[`photo_url_${oldKey}`] || null;
                    }

                    if (photoUrl) {
                        if (i === 1) mainPhotoUrl = photoUrl;
                        await dbRun(
                            `INSERT INTO product_variants (product_id, color, variant_type, photo_url, slot) VALUES ($1,$2,$3,$4,$5)`,
                            [productId, color, type, photoUrl, i]
                        );
                    }
                }
                if (!mainPhotoUrl) {
                    await dbRun(
                        `INSERT INTO product_variants (product_id, color, variant_type, photo_url, slot) VALUES ($1,$2,$3,$4,1)
                         ON CONFLICT (product_id, color, variant_type, slot) DO NOTHING`,
                        [productId, color, type, null]
                    );
                }

                for (const size of selSizes) {
                    // GANTI: ? → $1,$2,$3,$4,$5
                    await dbRun(
                        `INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES ($1,$2,$3,$4,$5)`,
                        [productId, size, color, type, 0]
                    );
                }
            }
        }

        res.json({ id: productId, message: 'Produk berhasil dibuat' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/products/:id
app.put('/api/products/:id', requireAuth(['admin','manager']), upload.any(), async (req, res) => {
    try {
        const { name, category, price, short_description, long_description,
            short_description_en, long_description_en,
            sizes, colors, types, is_popular, status, sku, price_by_type } = req.body;

        const priceByTypeObj = price_by_type ? safeJSON(price_by_type, null) : null;
        const priceValues = priceByTypeObj
            ? Object.values(priceByTypeObj).map(Number).filter(v => v > 0)
            : [];
        const basePrice = priceValues.length > 0
            ? Math.min(...priceValues)
            : parseInt(price || 0);

        await dbRun(
            `UPDATE products SET name=$1, category=$2, price=$3, price_by_type=$4,
             short_description=$5, long_description=$6,
             short_description_en=$7, long_description_en=$8,
             sizes=$9, colors=$10, types=$11,
             is_popular=$12, status=$13, sku=$14
             WHERE id = $15`,
            [name, category, basePrice,
                priceByTypeObj ? JSON.stringify(priceByTypeObj) : null,
                short_description || '', long_description || '',
                short_description_en || '', long_description_en || '',
                typeof sizes === 'string' ? sizes : JSON.stringify(sizes),
                typeof colors === 'string' ? colors : JSON.stringify(colors),
                typeof types === 'string' ? types : JSON.stringify(types),
                is_popular === '1' || is_popular === true ? 1 : 0,
                status || 'active', sku,
                req.params.id]
        );

        const photoMap = safeJSON(req.body.photo_map, {});
        const selColors = safeJSON(colors, []);
        const selTypes  = safeJSON(types,  []);
        const selSizes  = safeJSON(sizes,  []); // ← FIX: was missing, caused "selSizes is not defined"

        // ── Photo upload: handle up to 3 photos per color-type slot (matching POST logic) ──
        const NUM_PHOTOS = 3;
        for (const color of selColors) {
            for (const type of selTypes) {
                for (let i = 1; i <= NUM_PHOTOS; i++) {
                    const mapKey = `${color}_${type}_${i}`;

                    // Handle explicit delete (X button): remove this slot row entirely
                    if (req.body[`photo_clear_${mapKey}`] === '1') {
                        await dbRun(
                            `DELETE FROM product_variants WHERE product_id=$1 AND color=$2 AND variant_type=$3 AND slot=$4`,
                            [req.params.id, color, type, i]
                        );
                        continue;
                    }

                    let photoUrl = req.body[`photo_url_${mapKey}`] || null;
                    if (!photoUrl) {
                        const fileField = photoMap[mapKey];
                        const file = req.files && req.files.find(
                            f => f.fieldname === fileField || f.fieldname === `photo_${mapKey}`
                        );
                        if (file) photoUrl = await uploadToSupabase(file.buffer, file.originalname, 'products');
                    }
                    // Fallback: legacy key format (color_type without slot index)
                    if (!photoUrl && i === 1) {
                        const legacyKey = `${color}_${type}`;
                        photoUrl = req.body[`photo_url_${legacyKey}`] || null;
                        if (!photoUrl) {
                            const legacyFile = req.files && req.files.find(
                                f => f.fieldname === `photo_${legacyKey}`
                            );
                            if (legacyFile) photoUrl = await uploadToSupabase(legacyFile.buffer, legacyFile.originalname, 'products');
                        }
                    }
                    if (photoUrl) {
                        await dbRun(
                            `INSERT INTO product_variants (product_id, color, variant_type, photo_url, slot)
                             VALUES ($1,$2,$3,$4,$5)
                             ON CONFLICT(product_id, color, variant_type, slot) DO UPDATE SET photo_url = EXCLUDED.photo_url`,
                            [req.params.id, color, type, photoUrl, i]
                        );
                    }
                }
            }
        }

        // ── Ensure variant + inventory rows exist for every new color/type/size combo ──
        const effectiveTypes = selTypes.length > 0 ? selTypes : ['null'];

        for (const color of selColors) {
            for (const type of effectiveTypes) {
                const dbType = type === 'null' ? null : type;

                // Insert product_variant row if missing
                const existingVariant = await dbGet(
                    `SELECT id FROM product_variants
                     WHERE product_id = $1 AND color = $2 AND variant_type IS NOT DISTINCT FROM $3 LIMIT 1`,
                    [req.params.id, color, dbType]
                );
                if (!existingVariant) {
                    await dbRun(
                        `INSERT INTO product_variants (product_id, color, variant_type, photo_url, slot)
                         VALUES ($1, $2, $3, $4, 1)
                         ON CONFLICT (product_id, color, variant_type, slot) DO NOTHING`,
                        [req.params.id, color, dbType, null]
                    );
                }

                // Insert inventory rows for each size (DO NOTHING = preserve existing stock)
                for (const size of selSizes) {
                    await dbRun(
                        `INSERT INTO inventory (product_id, size, color, variant_type, stock)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (product_id, size, color, variant_type) DO NOTHING`,
                        [req.params.id, size, color, type, 0]
                    );
                }
            }
        }

        invalidateCache('products', 'inventory');
        res.json({ message: 'Produk berhasil diperbarui' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// DELETE /api/products/:id (soft delete — preserves order history)
app.delete('/api/products/:id', requireAuth(['admin','manager']), async (req, res) => {
    try {
        await dbRun('UPDATE products SET is_active = FALSE WHERE id = $1', [req.params.id]);
        invalidateCache('products');
        res.json({ message: 'Produk dihapus' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── INVENTORY ─────────────────────────────────────────────────────────────────

app.get('/api/inventory', async (req, res) => {
    try {
        const { category } = req.query;
        let rows;
        if (category) {
            // GANTI: ? → $1
            rows = await dbAll(
                `SELECT i.* FROM inventory i
                 JOIN products p ON i.product_id = p.id
                 WHERE p.category = $1 ORDER BY i.product_id, i.color, i.variant_type, i.size`,
                [category]
            );
        } else {
            rows = await dbAll('SELECT * FROM inventory ORDER BY product_id, color, variant_type, size');
        }
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/inventory/all — semua inventory join product (satu query, untuk dashboard)
app.get('/api/inventory/all', requireAuth(), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT i.*, p.name AS product_name, p.sku, p.category
             FROM inventory i
             JOIN products p ON p.id = i.product_id
             ORDER BY p.name, i.color, i.variant_type,
               CASE i.size WHEN 'S' THEN 1 WHEN 'M' THEN 2 WHEN 'L' THEN 3 WHEN 'XL' THEN 4 WHEN 'XXL' THEN 5 ELSE 6 END`,
            []
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/inventory/variant/history — riwayat stok + pembeli per varian spesifik
app.get('/api/inventory/variant/history', requireAuth(), async (req, res) => {
    try {
        const { product_id, color, size, variant_type } = req.query;
        if (!product_id || !color || !size || !variant_type)
            return res.status(400).json({ error: 'Query tidak lengkap: butuh product_id, color, size, variant_type' });

        const movements = await dbAll(
            `SELECT * FROM stock_movements
             WHERE product_id=$1 AND color=$2 AND size=$3 AND variant_type=$4
             ORDER BY created_at DESC LIMIT 50`,
            [product_id, color, size, variant_type]
        );

        const buyers = await dbAll(
            `SELECT o.customer_name, o.customer_phone, o.order_code, o.order_source,
                    o.payment_status, o.order_status, o.created_at, o.payment_method,
                    oi.quantity, oi.price
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             WHERE oi.product_id=$1 AND oi.color=$2 AND oi.size=$3 AND oi.variant_type=$4
               AND o.order_status != 'cancelled'
               AND o.payment_status = 'paid'
             ORDER BY o.created_at DESC LIMIT 50`,
            [product_id, color, size, variant_type]
        );

        res.json({ movements, buyers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/inventory/:product_id', async (req, res) => {
    try {
        // GANTI: ? → $1
        const rows = await dbAll(
            'SELECT * FROM inventory WHERE product_id = $1 ORDER BY color, variant_type, size',
            [req.params.product_id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/inventory/:product_id/check', async (req, res) => {
    try {
        const { size, color, type } = req.query;
        // GANTI: ? → $1,$2,$3,$4
        const row = await dbGet(
            'SELECT stock FROM inventory WHERE product_id = $1 AND size = $2 AND color = $3 AND variant_type = $4',
            [req.params.product_id, size, color, type]
        );
        res.json({ available: row ? row.stock : 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/inventory/receive — terima stok dari penjahit, support normal & reject
app.post('/api/inventory/receive', requireAuth(['admin','manager']), async (req, res) => {
    try {
        const { product_id, size, color, variant_type, quantity, note, stock_type } = req.body;
        if (!product_id || !size || !color || !variant_type)
            return res.status(400).json({ error: 'Data tidak lengkap' });
        const qty = parseInt(quantity);
        if (!qty || qty <= 0)
            return res.status(400).json({ error: 'Jumlah harus lebih dari 0' });

        const isReject = stock_type === 'reject';
        const cur = await dbGet(
            'SELECT stock, stock_reject FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4',
            [product_id, size, color, variant_type]
        );
        const normalBefore = cur ? parseInt(cur.stock || 0) : 0;
        const rejectBefore = cur ? parseInt(cur.stock_reject || 0) : 0;
        const before = isReject ? rejectBefore : normalBefore;
        const after  = before + qty;

        if (isReject) {
            await dbRun(
                `INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES ($1,$2,$3,$4,0,$5)
                 ON CONFLICT(product_id, size, color, variant_type) DO UPDATE SET stock_reject = $6`,
                [product_id, size, color, variant_type, after, after]
            );
        } else {
            await dbRun(
                `INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES ($1,$2,$3,$4,$5,0)
                 ON CONFLICT(product_id, size, color, variant_type) DO UPDATE SET stock = $6`,
                [product_id, size, color, variant_type, after, after]
            );
        }
        await dbRun(
            `INSERT INTO stock_movements
             (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, admin_user, is_reject)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [product_id, size, color, variant_type, isReject ? 'receive_reject' : 'receive',
             qty, before, after, note || (isReject ? 'Terima stok reject' : 'Terima stok baru'),
             req.user.username, isReject]
        );
        invalidateCache('inventory');
        res.json({ message: isReject ? 'Stok reject ditambahkan' : 'Stok berhasil ditambahkan', before, after, added: qty, stock_type: isReject ? 'reject' : 'normal' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/inventory/reject-to-normal — ubah stok reject menjadi stok normal
app.put('/api/inventory/reject-to-normal', requireAuth(['admin','manager']), async (req, res) => {
    try {
        const { product_id, size, color, variant_type, quantity } = req.body;
        if (!product_id || !size || !color || !variant_type)
            return res.status(400).json({ error: 'Data tidak lengkap' });
        const qty = parseInt(quantity);
        if (!qty || qty <= 0) return res.status(400).json({ error: 'Jumlah harus lebih dari 0' });

        const cur = await dbGet(
            'SELECT stock, stock_reject FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4',
            [product_id, size, color, variant_type]
        );
        if (!cur) return res.status(404).json({ error: 'Varian tidak ditemukan' });

        const rejectBefore = parseInt(cur.stock_reject || 0);
        if (qty > rejectBefore) return res.status(400).json({ error: `Stok reject hanya ${rejectBefore}` });

        const normalBefore = parseInt(cur.stock || 0);
        const rejectAfter  = rejectBefore - qty;
        const normalAfter  = normalBefore + qty;

        await dbRun(
            'UPDATE inventory SET stock=$1, stock_reject=$2 WHERE product_id=$3 AND size=$4 AND color=$5 AND variant_type=$6',
            [normalAfter, rejectAfter, product_id, size, color, variant_type]
        );
        await dbRun(
            `INSERT INTO stock_movements
             (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, admin_user, is_reject)
             VALUES ($1,$2,$3,$4,'reject_to_normal',$5,$6,$7,$8,$9,$10)`,
            [product_id, size, color, variant_type, qty, rejectBefore, rejectAfter,
             `Diubah reject→normal: ${qty} unit`, req.user.username, false]
        );
        invalidateCache('inventory');
        res.json({ message: `${qty} stok diubah dari reject ke normal`, normal_after: normalAfter, reject_after: rejectAfter });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/inventory/single — update stok manual, log ke stock_movements
app.put('/api/inventory/single', requireAuth(['admin','manager']), async (req, res) => {
    try {
        const { product_id, size, color, variant_type, stock } = req.body;
        const cur = await dbGet(
            'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4',
            [product_id, size, color, variant_type]
        );
        const before = cur ? parseInt(cur.stock) : 0;
        const after = parseInt(stock);

        await dbRun(
            `INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT(product_id, size, color, variant_type) DO UPDATE SET stock = $6`,
            [product_id, size, color, variant_type, after, after]
        );
        if (before !== after) {
            await dbRun(
                `INSERT INTO stock_movements
                 (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, admin_user)
                 VALUES ($1,$2,$3,$4,'manual_set',$5,$6,$7,'Update manual stok',$8)`,
                [product_id, size, color, variant_type, after - before, before, after, req.user.username]
            );
        }
        invalidateCache('inventory');
        res.json({ message: 'Stok diperbarui', before, after });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/inventory (bulk)
app.put('/api/inventory', requireAuth(['admin','manager']), async (req, res) => {
    try {
        const { updates } = req.body;
        for (const u of updates) {
            // GANTI: ? → $1-$6
            await dbRun(
                `INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT(product_id, size, color, variant_type) DO UPDATE SET stock = $6`,
                [u.product_id, u.size, u.color, u.variant_type || u.type, parseInt(u.stock), parseInt(u.stock)]
            );
        }
        res.json({ message: 'Stok berhasil diperbarui' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STATS ─────────────────────────────────────────────────────────────────────

app.get('/api/stats/overview', requireAuth(), async (req, res) => {
    try {
        const totalProducts = await dbGet("SELECT COUNT(*) as count FROM products WHERE status != 'draft' AND is_active = TRUE");
        const totalOrders = await dbGet("SELECT COUNT(*) as count FROM orders WHERE order_status != 'cancelled'");
        const cancelledOrders = await dbGet("SELECT COUNT(*) as count FROM orders WHERE order_status = 'cancelled'");
        const pendingOrders = await dbGet("SELECT COUNT(*) as count FROM orders WHERE payment_status = 'pending' AND order_status != 'cancelled'");
        const paidOrders = await dbGet("SELECT COUNT(*) as count FROM orders WHERE payment_status = 'paid' AND order_status != 'cancelled'");
        const doneOrders = await dbGet("SELECT COUNT(*) as count FROM orders WHERE order_status = 'done'");
        // Revenue: hanya order PAID yang TIDAK dibatalkan
        const totalRevenue = await dbGet("SELECT COALESCE(SUM(total_amount),0) as total FROM orders WHERE payment_status = 'paid' AND order_status != 'cancelled'");
        const lowStock = await dbGet("SELECT COUNT(*) as count FROM inventory WHERE stock < 5 AND stock >= 0");
        const byCategory = await dbAll("SELECT category, COUNT(*) as count FROM products WHERE is_active = TRUE GROUP BY category");

        const monthlyOrders = await dbAll(`
            SELECT TO_CHAR(created_at, 'YYYY-MM') as month, 
                   COUNT(*) FILTER (WHERE order_status != 'cancelled') as orders,
                   COALESCE(SUM(CASE WHEN payment_status='paid' AND order_status != 'cancelled' THEN total_amount ELSE 0 END), 0) as revenue
            FROM orders
            GROUP BY TO_CHAR(created_at, 'YYYY-MM')
            ORDER BY month DESC LIMIT 6`);

        res.json({
            total_products: totalProducts.count,
            total_orders: totalOrders.count,
            cancelled_orders: cancelledOrders.count,
            pending_orders: pendingOrders.count,
            paid_orders: paidOrders.count,
            done_orders: doneOrders.count,
            total_revenue: totalRevenue.total,
            low_stock_items: lowStock.count,
            by_category: byCategory,
            monthly: monthlyOrders.reverse()
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/stats', requireAuth(), async (req, res) => {
    try {
        const pendingOrders = await dbGet("SELECT COUNT(*) as count FROM orders WHERE payment_status = 'pending' AND order_status != 'cancelled'");
        const paidOrders = await dbGet("SELECT COUNT(*) as count FROM orders WHERE payment_status = 'paid' AND order_status != 'cancelled'");
        const totalRevenue = await dbGet("SELECT COALESCE(SUM(total_amount),0) as total FROM orders WHERE payment_status = 'paid' AND order_status != 'cancelled'");
        res.json({
            pending_orders: pendingOrders.count,
            paid_orders: paidOrders.count,
            total_revenue: totalRevenue.total || 0
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CITIES & SHIPPING ──────────────────────────────────────────────────────────

// GET /api/cities — Daftar kota Indonesia
app.get('/api/cities', (req, res) => {
    const { q } = req.query;
    let list = CITIES;
    if (q) {
        const lq = q.toLowerCase();
        list = CITIES.filter(c => c.name.toLowerCase().includes(lq));
    }
    res.json(list);
});

// GET /api/shipping-cost?city=Jakarta%20Selatan&qty=5
// Rules:
//  - DKI: JNE / J&T Reguler, Rp10.000/kg
//  - Luar DKI ≤10kg: J&T Reguler / Lion Parcel, Rp20.000/kg
//  - Luar DKI >10kg: Lion Cargo, ongkir dikonfirmasi admin per kota (cost=0, needs_confirmation=true)
app.get('/api/shipping-cost', (req, res) => {
    const { city, qty } = req.query;
    const quantity = parseInt(qty || 1);
    const weightKg = Math.ceil(quantity / 3);
    const cityInfo = CITIES.find(c => c.name === city);
    if (!cityInfo) return res.status(404).json({ error: 'Kota tidak ditemukan' });

    let courier, ratePerKg, cost, needsConfirmation = false;
    if (!cityInfo.is_dki && weightKg > 10) {
        courier = 'Lion Cargo (ongkir dikonfirmasi admin via WhatsApp)';
        ratePerKg = 0;
        cost = 0;
        needsConfirmation = true;
    } else if (cityInfo.is_dki) {
        courier = 'JNE / J&T Reguler';
        ratePerKg = 10000;
        cost = weightKg * ratePerKg;
    } else {
        courier = 'J&T Reguler / Lion Parcel';
        ratePerKg = 20000;
        cost = weightKg * ratePerKg;
    }

    res.json({
        city: cityInfo.name,
        is_dki: cityInfo.is_dki,
        courier,
        qty: quantity,
        weight_kg: weightKg,
        rate_per_kg: ratePerKg,
        shipping_cost: cost,
        shipping_cost_formatted: needsConfirmation ? 'Dikonfirmasi admin' : `Rp ${cost.toLocaleString('id-ID')}`,
        needs_confirmation: needsConfirmation
    });
});

// ── ORDERS ────────────────────────────────────────────────────────────────────

app.get('/api/orders', requireAuth(), async (req, res) => {
    try {
        const { status, payment_status } = req.query;
        let sql = 'SELECT * FROM orders WHERE 1=1';
        const params = [];
        let idx = 1; // GANTI: track nomor $N

        if (status) { sql += ` AND order_status = $${idx++}`; params.push(status); }
        if (payment_status) { sql += ` AND payment_status = $${idx++}`; params.push(payment_status); }
        sql += ' ORDER BY created_at DESC';

        const orders = await dbAll(sql, params);
        for (const order of orders) {
            // GANTI: ? → $1
            order.items = await dbAll(
                `SELECT oi.*, p.name as product_name FROM order_items oi
                 JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
                [order.id]
            );
        }
        res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/:id', requireAuth(), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        // Join product name + fetch first photo for each item
        order.items = await dbAll(
            `SELECT oi.*, p.name as product_name,
                    (SELECT pv.photo_url FROM product_variants pv
                     WHERE pv.product_id = oi.product_id AND pv.color = oi.color
                     LIMIT 1) as photo
             FROM order_items oi
             JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
            [order.id]
        );
        res.json(order);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders', async (req, res) => {
    try {
        const {
            customer_name, customer_phone, customer_address, items, notes,
            shipping_city, shipping_cost, embroidery_details,
            shipping_courier: req_shipping_courier,
            shipping_weight_kg,
            order_source,    // 'website' atau 'whatsapp', default 'website'
            payment_method,  // 'BCA', 'BRI', 'Mandiri', 'BNI', 'QRIS', dll
            discount_percent // 0, 5, atau 30 — hanya untuk WA order
        } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ error: 'Keranjang kosong' });

        let productTotal = 0;
        const itemDetails = [];
        for (const item of items) {
            const product = await dbGet('SELECT * FROM products WHERE id = $1', [item.product_id]);
            if (!product) return res.status(400).json({ error: `Produk ID ${item.product_id} tidak ditemukan` });

            const inv = await dbGet(
                'SELECT stock FROM inventory WHERE product_id = $1 AND size = $2 AND color = $3 AND variant_type = $4',
                [item.product_id, item.size, item.color, item.variant_type || 'null']
            );
            if (!inv || inv.stock < item.quantity) {
                return res.status(400).json({
                    error: `Stok ${product.name} (${item.color}, ${item.variant_type}, ${item.size}) tidak cukup`
                });
            }
            // Per-item price includes base product price + per-item embroidery cost
            const itemEmbroidery = (item.bordir_nama ? 20000 : 0) + (item.bordir_logo ? 30000 : 0);
            const unitPrice = product.price + itemEmbroidery;
            itemDetails.push({ ...item, price: unitPrice, product_name: product.name, base_price: product.price, embroidery_cost: itemEmbroidery });
            productTotal += unitPrice * item.quantity;
        }

        const shippingCost = parseInt(shipping_cost || 0);

        // Kalkulasi diskon (hanya product total, ongkir tidak kena diskon)
        const validDiscounts = [0, 5, 30];
        const safeDiscountPct = validDiscounts.includes(parseInt(discount_percent)) ? parseInt(discount_percent) : 0;
        const discountAmount = Math.round(productTotal * safeDiscountPct / 100);
        const discountLabel = safeDiscountPct === 5 ? 'Diskon 5%' : safeDiscountPct === 30 ? 'Consignment 30%' : null;
        const total = productTotal - discountAmount + shippingCost;

        // Courier dipilih manual dari form, fallback ke logika kota jika tidak diisi
        const cityInfo = CITIES.find(c => c.name === shipping_city);
        const weightKg = parseInt(shipping_weight_kg || 0);
        let autoCourier = 'JNE / J&T Reguler';
        if (cityInfo) {
            if (!cityInfo.is_dki && weightKg > 10) autoCourier = 'Lion Cargo (ongkir dikonfirmasi admin)';
            else if (cityInfo.is_dki) autoCourier = 'JNE / J&T Reguler';
            else autoCourier = 'J&T Reguler / Lion Parcel';
        }
        const courier = (req_shipping_courier && req_shipping_courier.trim()) ? req_shipping_courier.trim() : autoCourier;

        // Detect bordir flags from items for order-level tracking
        const hasBordirLogo = itemDetails.some(i => i.bordir_logo);
        const hasBordirNama = itemDetails.some(i => i.bordir_nama);

        // Auto-mark logo as provided if customer already uploaded via checkout (stored as base64 in emb.value)
        const logoAlreadyProvided = hasBordirLogo && Array.isArray(embroidery_details) &&
            embroidery_details.some(e => e.type === 'logo' && typeof e.value === 'string' && e.value.startsWith('data:image/'));

        const orderCode = generateOrderCode(order_source || 'website');
        const orderResult = await dbRun(
            `INSERT INTO orders (order_code, customer_name, customer_phone, customer_address,
              shipping_city, shipping_courier, shipping_weight_kg, shipping_cost, total_amount,
              embroidery_details, has_bordir_logo, has_bordir_nama, bordir_status, notes, order_source,
              payment_method, discount_percent, discount_amount, discount_label, bordir_logo_requested)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
            [orderCode, customer_name, customer_phone, customer_address,
             shipping_city || '', courier, weightKg, shippingCost, total,
             embroidery_details ? JSON.stringify(embroidery_details) : null,
             hasBordirLogo, hasBordirNama,
             (hasBordirLogo || hasBordirNama) ? 'pending' : null,
             notes || '',
             order_source || 'website',
             payment_method || '',
             safeDiscountPct,
             discountAmount,
             discountLabel,
             logoAlreadyProvided]
        );
        const orderId = orderResult.rows[0].id;

        for (const item of itemDetails) {
            await dbRun(
                `INSERT INTO order_items (order_id, product_id, size, color, variant_type, quantity, price, bordir_nama, bordir_logo)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [orderId, item.product_id, item.size, item.color,
                    item.variant_type || 'null', item.quantity, item.price,
                    item.bordir_nama || false, item.bordir_logo || false]
            );
        }

        // Rich WA notification for admin
        const itemSummary = itemDetails.map(i => {
            let line = `• ${i.product_name} (${i.color}${i.variant_type && i.variant_type !== 'null' ? ', ' + i.variant_type : ''}, ${i.size}) x${i.quantity}`;
            if (i.bordir_nama) line += ` [Bordir Nama]`;
            if (i.bordir_logo) line += ` [Bordir Logo]`;
            line += ` = Rp ${(i.price * i.quantity).toLocaleString('id-ID')}`;
            return line;
        }).join('\n');

        // Helper: strip base64 image values before including in WA messages (prevents multi-MB payloads)
        const safeEmbVal = (e) => {
            if (e.type === 'logo') {
                const isBase64 = typeof e.value === 'string' && e.value.startsWith('data:image/');
                return isBase64 ? '(Logo sudah diupload via website)' : (e.value || 'kirim via WA');
            }
            return e.value || '';
        };
        const embroiderySection = embroidery_details && embroidery_details.length > 0
            ? `\n\n🧵 *Detail Bordir:*\n` + embroidery_details.map(e =>
                `• ${e.item_label}: ${e.type === 'nama' ? 'Nama: ' + safeEmbVal(e) : 'Logo: ' + safeEmbVal(e)}`
              ).join('\n')
            : '';

        const discountLine = discountAmount > 0
            ? `🏷️ ${discountLabel}: -Rp ${discountAmount.toLocaleString('id-ID')}\n`
            : '';

        const waMsg =
            `🛍️ *PESANAN BARU! #${orderCode}*\n\n` +
            `👤 ${customer_name}\n` +
            `📱 ${customer_phone}\n` +
            `📍 ${customer_address}\n` +
            `🏙️ Kota: ${shipping_city || '-'} (${courier})\n\n` +
            `🧾 *Detail Produk:*\n${itemSummary}${embroiderySection}\n\n` +
            `📦 Ongkir: Rp ${shippingCost.toLocaleString('id-ID')}\n` +
            discountLine +
            `💰 *TOTAL: Rp ${total.toLocaleString('id-ID')}*\n\n` +
            `⏳ Menunggu Pembayaran`;
        // Skip WA notification to admin for manually-input WA orders (admin already knows)
        if ((order_source || 'website') !== 'whatsapp') {
            await sendWANotification(waMsg);
        }

        // ⚠️ Immediate reminder if bordir logo ordered
        if (hasBordirLogo) {
            const logoItems = embroidery_details
                ? embroidery_details.filter(e => e.type === 'logo').map(e => `• ${e.item_label}: ${safeEmbVal(e)}`).join('\n')
                : '(lihat detail pesanan)';
            await sendWANotification(
                `🔔 *REMINDER: BORDIR LOGO - #${orderCode}*\n\n` +
                `Customer ${customer_name} memesan bordir logo!\n\n` +
                `🎨 Detail logo:\n${logoItems}\n\n` +
                `❗ Segera hubungi customer untuk meminta file logo bordir.\n` +
                `📱 WA Customer: ${customer_phone}`
            );
        }

        res.json({
            message: 'Pesanan berhasil dibuat',
            id: orderId,
            order_id: orderId,
            order_code: orderCode,
            total_amount: total,
            shipping_cost: shippingCost,
            courier,
            discount_percent: safeDiscountPct,
            discount_amount: discountAmount,
            discount_label: discountLabel
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/confirm-payment  (multipart: payment_proof photo)
app.put('/api/orders/:id/confirm-payment', requireAuth(['admin','manager']), upload.single('payment_proof'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Foto bukti pembayaran wajib diupload' });
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.payment_status === 'paid') return res.status(400).json({ error: 'Sudah dikonfirmasi' });

        const photoUrl = await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders');

        // Save photo proof
        await dbRun(`INSERT INTO order_photos (order_id, step, photo_url, note) VALUES ($1,$2,$3,$4)`,
            [order.id, 'payment', photoUrl, req.body.note || '']);

        // Deduct inventory + log order_out
        const items = await dbAll('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
        for (const item of items) {
            const invBefore = await dbGet(
                'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4',
                [item.product_id, item.size, item.color, item.variant_type]
            );
            const stockBefore = invBefore ? parseInt(invBefore.stock) : 0;
            await dbRun(
                `UPDATE inventory SET stock = GREATEST(0, stock - $1) WHERE product_id = $2 AND size = $3 AND color = $4 AND variant_type = $5`,
                [item.quantity, item.product_id, item.size, item.color, item.variant_type]
            );
            const stockAfter = Math.max(0, stockBefore - item.quantity);
            await dbRun(
                `INSERT INTO stock_movements
                 (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                 VALUES ($1,$2,$3,$4,'order_out',$5,$6,$7,$8,$9,$10)`,
                [item.product_id, item.size, item.color, item.variant_type,
                 -item.quantity, stockBefore, stockAfter,
                 `Order ${order.order_code}`, order.id, req.user.username]
            );
        }

        // Determine next status based on whether order has bordir
        const nextStatus = order.has_bordir_logo || order.has_bordir_nama ? 'bordir' : 'confirmed';
        await dbRun(
            `UPDATE orders SET payment_status = 'paid', order_status = $1, updated_at = NOW() WHERE id = $2`,
            [nextStatus, order.id]
        );

        // WA notification to admin if bordir logo not yet requested
        if ((order.has_bordir_logo || order.has_bordir_nama) && !order.bordir_logo_requested) {
            await dbRun(`UPDATE orders SET bordir_logo_requested = TRUE WHERE id = $1`, [order.id]);
            const embDetails = order.embroidery_details ? JSON.parse(order.embroidery_details) : [];
            const logoItems = embDetails.filter(e => e.type === 'logo').map(e => `• ${e.item_label}: ${e.value}`).join('\n');
            const namaItems = embDetails.filter(e => e.type === 'nama').map(e => `• ${e.item_label}: ${e.value}`).join('\n');
            await sendWANotification(
                `✅ *BAYAR DIKONFIRMASI - #${order.order_code}*\n\n` +
                `💰 Pembayaran ${order.customer_name} sudah dikonfirmasi.\n` +
                `🧵 *Status: Masuk Proses Bordir (estimasi 1 minggu)*\n\n` +
                (logoItems ? `🎨 Logo bordir:\n${logoItems}\n` : '') +
                (namaItems ? `✏️ Nama bordir:\n${namaItems}\n` : '') +
                (order.has_bordir_logo ? `\n❗ Segera request file logo ke customer: ${order.customer_phone}` : '')
            );
        }

        res.json({ message: 'Pembayaran dikonfirmasi', next_status: nextStatus, photo_url: photoUrl });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/bordir-done  (multipart: bordir_proof photo)
app.put('/api/orders/:id/bordir-done', requireAuth(['admin','manager']), upload.single('bordir_proof'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Foto bukti bordir selesai wajib diupload' });
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.order_status !== 'bordir') return res.status(400).json({ error: 'Pesanan tidak dalam status bordir' });

        const photoUrl = await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders');
        await dbRun(`INSERT INTO order_photos (order_id, step, photo_url, note) VALUES ($1,$2,$3,$4)`,
            [order.id, 'bordir', photoUrl, req.body.note || '']);
        await dbRun(`UPDATE orders SET order_status = 'confirmed', updated_at = NOW() WHERE id = $1`, [order.id]);

        await sendWANotification(
            `🧵 *BORDIR SELESAI - #${order.order_code}*\n\n` +
            `Bordir untuk pesanan ${order.customer_name} sudah selesai.\n` +
            `📸 Foto bordir sudah diupload di dashboard.\n` +
            `➡️ Status: Siap dikemas`
        );

        res.json({ message: 'Bordir selesai, siap dikemas', photo_url: photoUrl });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/pack  (multipart: pack_proof photo)
app.put('/api/orders/:id/pack', requireAuth(['admin','manager']), upload.single('pack_proof'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Foto bukti pengemasan wajib diupload' });
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.order_status !== 'confirmed') return res.status(400).json({ error: 'Pesanan belum berstatus confirmed/siap kemas' });

        const photoUrl = await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders');
        await dbRun(`INSERT INTO order_photos (order_id, step, photo_url, note) VALUES ($1,$2,$3,$4)`,
            [order.id, 'pack', photoUrl, req.body.note || '']);
        await dbRun(`UPDATE orders SET order_status = 'packed', updated_at = NOW() WHERE id = $1`, [order.id]);

        await sendWANotification(
            `📦 *DIKEMAS - #${order.order_code}*\n\n` +
            `Pesanan ${order.customer_name} sudah dikemas.\n` +
            `📸 Foto kemasan sudah diupload.\n` +
            `➡️ Siap dikirim via ${order.shipping_courier}`
        );

        res.json({ message: 'Pesanan dikemas', photo_url: photoUrl });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/cancel  (admin only, multipart: refund_proof photo)
app.put('/api/orders/:id/cancel', requireAuth(['admin']), upload.single('refund_proof'), async (req, res) => {
    try {
        const user = req.user;
        if (user.role !== 'admin') return res.status(403).json({ error: 'Hanya admin yang bisa membatalkan pesanan' });
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.order_status === 'cancelled') return res.status(400).json({ error: 'Sudah dibatalkan' });
        if (order.order_status === 'done') return res.status(400).json({ error: 'Pesanan sudah selesai, tidak bisa dibatalkan' });

        const { cancel_reason } = req.body;
        const refundProofUrl = req.file
            ? await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders')
            : null;

        // If payment was already confirmed, return stock + log restore.
        // Refund proof is NOT required here — refund flow handled separately (status pending → transferred).
        if (order.payment_status === 'paid') {
            const items = await dbAll('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
            for (const item of items) {
                const invBefore = await dbGet(
                    'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4',
                    [item.product_id, item.size, item.color, item.variant_type]
                );
                const stockBefore = invBefore ? parseInt(invBefore.stock) : 0;
                await dbRun(
                    `UPDATE inventory SET stock = stock + $1 WHERE product_id = $2 AND size = $3 AND color = $4 AND variant_type = $5`,
                    [item.quantity, item.product_id, item.size, item.color, item.variant_type]
                );
                const stockAfter = stockBefore + item.quantity;
                await dbRun(
                    `INSERT INTO stock_movements
                     (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                     VALUES ($1,$2,$3,$4,'order_cancel_restore',$5,$6,$7,$8,$9,$10)`,
                    [item.product_id, item.size, item.color, item.variant_type,
                     item.quantity, stockBefore, stockAfter,
                     `Pembatalan ${order.order_code}`, order.id, user.username]
                );
            }
        }

        if (refundProofUrl) {
            await dbRun(`INSERT INTO order_photos (order_id, step, photo_url, note) VALUES ($1,$2,$3,$4)`,
                [order.id, 'refund', refundProofUrl, cancel_reason || '']);
        }

        await dbRun(
            `UPDATE orders SET order_status = 'cancelled', cancel_reason = $1, cancelled_by = $2, updated_at = NOW() WHERE id = $3`,
            [cancel_reason || '', user.username, order.id]
        );

        // Auto-create refund record (status='pending') for paid orders.
        // Dedup: skip if a non-cancelled refund of same type already exists for this order.
        let refundCreated = null;
        if (order.payment_status === 'paid') {
            const existing = await dbGet(
                `SELECT id FROM refunds WHERE order_id = $1 AND refund_type = 'order_cancel' AND status != 'cancelled'`,
                [order.id]
            );
            if (!existing) {
                refundCreated = await dbGet(
                    `INSERT INTO refunds (order_id, refund_type, amount, reason, status, created_by)
                     VALUES ($1, 'order_cancel', $2, $3, 'pending', $4) RETURNING id, amount, status`,
                    [order.id, order.total_amount || 0, cancel_reason || '', user.username]
                );
            }
        }

        await sendWANotification(
            `❌ *PESANAN DIBATALKAN - #${order.order_code}*\n\n` +
            `Pesanan ${order.customer_name} dibatalkan oleh admin ${user.username}.\n` +
            `📝 Alasan: ${cancel_reason || '-'}\n` +
            (order.payment_status === 'paid' ? `💰 Refund Rp${(order.total_amount || 0).toLocaleString('id-ID')} akan diproses ke ${order.customer_phone}` : '')
        );

        res.json({ message: 'Pesanan dibatalkan', refund_proof: refundProofUrl, refund: refundCreated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// REFUND ENDPOINTS — state machine: pending → transferred → completed
// Lock rule: after status='transferred', only internal_notes is editable.
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/refunds — list all refunds (admin/manager). Optional ?status= filter.
app.get('/api/refunds', requireAuth(['admin','manager']), async (req, res) => {
    try {
        const { status } = req.query;
        const where = status ? `WHERE r.status = $1` : '';
        const params = status ? [status] : [];
        const rows = await dbAll(
            `SELECT r.*, o.order_code, o.customer_name, o.customer_phone, o.total_amount AS order_total
             FROM refunds r
             LEFT JOIN orders o ON o.id = r.order_id
             ${where}
             ORDER BY r.created_at DESC`,
            params
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orders/:id/refunds — list refunds for a specific order
app.get('/api/orders/:id/refunds', requireAuth(['admin','manager']), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT * FROM refunds WHERE order_id = $1 ORDER BY created_at DESC`,
            [req.params.id]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orders/:id/refunds — manually create a refund (e.g. bordir reject)
// Dedup: prevents Rp0 / duplicate refund creation for same type.
app.post('/api/orders/:id/refunds', requireAuth(['admin']), upload.none(), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.payment_status !== 'paid') {
            return res.status(400).json({ error: 'Refund hanya berlaku untuk pesanan yang sudah dibayar' });
        }

        const { refund_type = 'bordir_reject', amount, reason, bank_name, bank_account_number, bank_account_holder } = req.body;
        if (!['order_cancel','bordir_reject','partial'].includes(refund_type)) {
            return res.status(400).json({ error: 'refund_type tidak valid' });
        }
        const amt = parseInt(amount, 10);
        if (!Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ error: 'Nominal refund harus lebih dari 0' });
        }

        // Dedup: cek apakah sudah ada refund aktif (bukan cancelled) untuk type yg sama
        const existing = await dbGet(
            `SELECT id, status, amount FROM refunds WHERE order_id = $1 AND refund_type = $2 AND status != 'cancelled'`,
            [order.id, refund_type]
        );
        if (existing) {
            return res.status(409).json({
                error: `Refund untuk ${refund_type === 'bordir_reject' ? 'bordir' : 'pesanan'} ini sudah pernah dibuat`,
                existing_refund: existing
            });
        }

        const created = await dbGet(
            `INSERT INTO refunds (order_id, refund_type, amount, reason, status,
                                  bank_name, bank_account_number, bank_account_holder, created_by)
             VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8) RETURNING *`,
            [order.id, refund_type, amt, reason || '',
             bank_name || '', bank_account_number || '', bank_account_holder || '',
             req.user.username]
        );
        res.json({ message: 'Refund dibuat', refund: created });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/refunds/:id — edit refund. Locked fields rejected if status=transferred|completed.
app.put('/api/refunds/:id', requireAuth(['admin']), upload.none(), async (req, res) => {
    try {
        const refund = await dbGet('SELECT * FROM refunds WHERE id = $1', [req.params.id]);
        if (!refund) return res.status(404).json({ error: 'Refund tidak ditemukan' });

        const locked = refund.status === 'transferred' || refund.status === 'completed';
        const { amount, reason, bank_name, bank_account_number, bank_account_holder, internal_notes } = req.body;

        if (locked) {
            // Only internal_notes editable
            const lockedAttempt = [amount, reason, bank_name, bank_account_number, bank_account_holder].some(v => v !== undefined);
            if (lockedAttempt) {
                return res.status(423).json({
                    error: `Refund sudah ${refund.status} — hanya internal_notes yang boleh diedit`
                });
            }
            await dbRun(
                `UPDATE refunds SET internal_notes = COALESCE($1, internal_notes), updated_at = NOW() WHERE id = $2`,
                [internal_notes ?? null, refund.id]
            );
        } else {
            // All fields editable when pending
            const amt = amount !== undefined ? parseInt(amount, 10) : refund.amount;
            if (amount !== undefined && (!Number.isFinite(amt) || amt <= 0)) {
                return res.status(400).json({ error: 'Nominal refund harus lebih dari 0' });
            }
            await dbRun(
                `UPDATE refunds SET
                    amount = $1,
                    reason = COALESCE($2, reason),
                    bank_name = COALESCE($3, bank_name),
                    bank_account_number = COALESCE($4, bank_account_number),
                    bank_account_holder = COALESCE($5, bank_account_holder),
                    internal_notes = COALESCE($6, internal_notes),
                    updated_at = NOW()
                 WHERE id = $7`,
                [amt, reason ?? null, bank_name ?? null, bank_account_number ?? null,
                 bank_account_holder ?? null, internal_notes ?? null, refund.id]
            );
        }
        const updated = await dbGet('SELECT * FROM refunds WHERE id = $1', [refund.id]);
        res.json({ message: 'Refund diperbarui', refund: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/refunds/:id/mark-transferred — upload proof, set status=transferred.
// Dedup: rejects if already transferred/completed (cegah re-upload & WA dobel).
app.put('/api/refunds/:id/mark-transferred', requireAuth(['admin']), upload.single('proof'), async (req, res) => {
    try {
        const refund = await dbGet('SELECT * FROM refunds WHERE id = $1', [req.params.id]);
        if (!refund) return res.status(404).json({ error: 'Refund tidak ditemukan' });
        if (refund.status === 'transferred' || refund.status === 'completed') {
            return res.status(409).json({
                error: `Refund sudah berstatus ${refund.status} — bukti transfer tidak bisa diubah`
            });
        }
        if (refund.status === 'cancelled') {
            return res.status(400).json({ error: 'Refund sudah dibatalkan' });
        }
        if (!req.file) return res.status(400).json({ error: 'Foto bukti transfer wajib diupload' });

        const proofUrl = await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders');
        const { note } = req.body;
        const updated = await dbGet(
            `UPDATE refunds SET
                proof_url = $1,
                status = 'transferred',
                transferred_by = $2,
                transferred_at = NOW(),
                internal_notes = CASE WHEN $3::text IS NOT NULL AND $3 != '' THEN $3 ELSE internal_notes END,
                updated_at = NOW()
             WHERE id = $4 RETURNING *`,
            [proofUrl, req.user.username, note || null, refund.id]
        );

        // Save proof to order_photos for backwards compat with existing UI
        await dbRun(
            `INSERT INTO order_photos (order_id, step, photo_url, note) VALUES ($1, 'refund', $2, $3)`,
            [refund.order_id, proofUrl, note || `Refund #${refund.id} transferred`]
        );

        const order = await dbGet('SELECT order_code, customer_name, customer_phone FROM orders WHERE id = $1', [refund.order_id]);
        await sendWANotification(
            `💸 *REFUND TERKIRIM - #${order?.order_code || refund.order_id}*\n\n` +
            `Refund Rp${(refund.amount || 0).toLocaleString('id-ID')} ke ${order?.customer_name || '-'} telah ditransfer.\n` +
            `Mohon customer konfirmasi penerimaan.`
        );

        res.json({ message: 'Refund ditandai transferred', refund: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/refunds/:id/confirm — set status=completed (customer confirmed receipt).
app.put('/api/refunds/:id/confirm', requireAuth(['admin','manager']), async (req, res) => {
    try {
        const refund = await dbGet('SELECT * FROM refunds WHERE id = $1', [req.params.id]);
        if (!refund) return res.status(404).json({ error: 'Refund tidak ditemukan' });
        if (refund.status !== 'transferred') {
            return res.status(400).json({ error: `Hanya refund 'transferred' yang bisa di-confirm (sekarang: ${refund.status})` });
        }
        const updated = await dbGet(
            `UPDATE refunds SET status = 'completed', completed_at = NOW(), updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [refund.id]
        );
        res.json({ message: 'Refund completed', refund: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/refunds/:id/cancel-refund — soft cancel a pending refund (admin only).
app.put('/api/refunds/:id/cancel-refund', requireAuth(['admin']), upload.none(), async (req, res) => {
    try {
        const refund = await dbGet('SELECT * FROM refunds WHERE id = $1', [req.params.id]);
        if (!refund) return res.status(404).json({ error: 'Refund tidak ditemukan' });
        if (refund.status !== 'pending') {
            return res.status(400).json({ error: `Hanya refund 'pending' yang bisa dibatalkan (sekarang: ${refund.status})` });
        }
        const { reason } = req.body;
        const updated = await dbGet(
            `UPDATE refunds SET status = 'cancelled',
                                internal_notes = COALESCE(internal_notes, '') || E'\n[CANCELLED] ' || $1,
                                updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [reason || 'No reason given', refund.id]
        );
        res.json({ message: 'Refund dibatalkan', refund: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orders/:id/photos — get all proof photos for an order
app.get('/api/orders/:id/photos', async (req, res) => {
    try {
        const photos = await dbAll(
            `SELECT * FROM order_photos WHERE order_id = $1 ORDER BY created_at ASC`,
            [req.params.id]
        );
        res.json(photos);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/status', requireAuth(['admin','manager']), async (req, res) => {
    try {
        const { order_status } = req.body;
        const valid = ['waiting_payment', 'confirmed', 'packed', 'shipped', 'done', 'bordir'];
        // 'cancelled' deliberately excluded — must use PUT /api/orders/:id/cancel
        // (that endpoint restores stock, logs audit trail, creates refund record).
        if (order_status === 'cancelled') {
            return res.status(400).json({ error: 'Gunakan endpoint /cancel untuk membatalkan pesanan' });
        }
        if (!valid.includes(order_status)) return res.status(400).json({ error: 'Status tidak valid' });
        await dbRun(
            `UPDATE orders SET order_status = $1, updated_at = NOW() WHERE id = $2`,
            [order_status, req.params.id]
        );
        res.json({ message: `Status: ${order_status}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/bordir-review — admin approve / reject bordir
// Body: { action: 'approve' | 'reject', reason?: string }
app.put('/api/orders/:id/bordir-review', requireAuth(['admin','manager']), upload.none(), async (req, res) => {
    try {
        const { action, reason } = req.body;
        if (!['approve','reject'].includes(action))
            return res.status(400).json({ error: 'Action harus approve atau reject' });

        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (!order.has_bordir_logo && !order.has_bordir_nama)
            return res.status(400).json({ error: 'Pesanan ini tidak memiliki bordir' });

        if (action === 'approve') {
            await dbRun(
                `UPDATE orders SET bordir_status = 'approved', bordir_reject_reason = NULL, updated_at = NOW() WHERE id = $1`,
                [order.id]
            );
            return res.json({ message: 'Bordir disetujui, order siap diproses' });
        }

        // Reject: simpan alasan + generate WA link untuk admin kirim ke customer
        const rejectReason = (reason || '').trim() || 'Bordir terlalu rumit atau nama terlalu panjang untuk diproses';
        await dbRun(
            `UPDATE orders SET bordir_status = 'rejected', bordir_reject_reason = $1, updated_at = NOW() WHERE id = $2`,
            [rejectReason, order.id]
        );

        const phone = (order.customer_phone || '').replace(/[^0-9]/g, '').replace(/^0/, '62');
        const msg = encodeURIComponent(
            `Halo ${order.customer_name},\n\n` +
            `Mohon maaf, untuk pesanan *${order.order_code}* bordir yang Anda minta tidak dapat kami proses karena:\n` +
            `${rejectReason}\n\n` +
            `Silakan pilih salah satu opsi berikut:\n` +
            `1. Revisi bordir (kirim ulang detail/file)\n` +
            `2. Lanjut tanpa bordir (kami refund biaya bordir)\n` +
            `3. Batal pesanan (full refund)\n\n` +
            `Mohon konfirmasi via balasan WA ini. Terima kasih.`
        );
        const waUrl = phone ? `https://wa.me/${phone}?text=${msg}` : null;

        res.json({ message: 'Bordir ditolak. Kirim WA ke customer.', wa_url: waUrl, reason: rejectReason });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/request-logo — mark logo requested + send WA to customer
app.put('/api/orders/:id/request-logo', requireAuth(['admin','manager']), upload.none(), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (!order.has_bordir_logo) return res.status(400).json({ error: 'Pesanan ini tidak memiliki bordir logo' });

        await dbRun(`UPDATE orders SET bordir_logo_requested = TRUE, updated_at = NOW() WHERE id = $1`, [order.id]);

        // Parse embroidery details to get logo items
        let embDetails = [];
        try { embDetails = order.embroidery_details ? JSON.parse(order.embroidery_details) : []; } catch(e) {}
        const logoItems = embDetails.filter(e => e.type === 'logo');

        await sendWANotification(
            `🎨 *PERMINTAAN FILE LOGO BORDIR - #${order.order_code}*\n\n` +
            `Halo team! Mohon segera hubungi customer:\n` +
            `👤 ${order.customer_name}\n` +
            `📱 ${order.customer_phone}\n\n` +
            `Untuk meminta file logo bordir mereka.\n` +
            (logoItems.length ? `📋 Detail logo: ${logoItems.map(e => e.item_label + ': ' + e.value).join(', ')}\n\n` : '') +
            `⏰ Proses bordir estimasi 1 minggu setelah file logo diterima.`
        );

        res.json({ message: 'Logo bordir sudah diminta ke customer', order_code: order.order_code });
    } catch (err) { res.status(500).json({ error: err.message }); }
});



// ─── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 WearScrubs Backend berjalan di http://localhost:${PORT}`);
    console.log(`   API: http://localhost:${PORT}/api/products`);
    console.log(`   WA Token: ${process.env.FONNTE_TOKEN ? 'Terkonfigurasi ✅' : 'Belum ⚠️'}\n`);
});
