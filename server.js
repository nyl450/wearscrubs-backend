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
const { CITIES, rateForZone } = require('./cities');

const app = express();
const PORT = process.env.PORT || 3000;
// JWT secret is mandatory in production — never ship a hardcoded fallback.
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev_only_insecure_secret');
if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET environment variable is required in production. Set it before starting.');
    process.exit(1);
}
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

// ─── Per-menu permissions (admin = full; staff = map {menu: 'view'|'edit'}) ─────
// Canonical menu keys. EDITABLE = menus that have write actions (can be 'edit').
const MENU_KEYS = ['overview','products','inventory','popular','orders','manual-order','preorder','refund','exchange','report'];
const EDITABLE_MENUS = ['products','inventory','popular','orders','manual-order','refund','exchange'];

// Normalize a user's stored permission into a map {menu:'view'|'edit'}.
// Returns null for admin (full access sentinel). Legacy formats degrade to least
// privilege (view) so an old token can never silently gain edit, and a legacy
// "null = all" token still navigates (view) instead of being locked out.
function permMap(user) {
    if (!user || user.role === 'admin') return null;          // admin → full
    const am = user.allowed_menus;
    if (am == null) return Object.fromEntries(MENU_KEYS.map(m => [m, 'view'])); // legacy null → all view
    if (Array.isArray(am)) return Object.fromEntries(am.map(m => [m, 'view']));  // legacy array → view
    if (typeof am === 'object') return am;                    // new map
    return {};
}
function hasMenu(user, menu, level = 'view') {
    const pm = permMap(user);
    if (pm === null) return true;                             // admin
    const lv = pm[menu];
    if (!lv) return false;
    return level === 'view' ? true : lv === 'edit';
}
// Validate/clean a permission map coming from the client (admin user mgmt form).
// Keeps only known menus + valid levels; non-editable menus clamped to 'view'.
function sanitizePermsInput(allowed_menus) {
    const out = {};
    if (allowed_menus && typeof allowed_menus === 'object' && !Array.isArray(allowed_menus)) {
        for (const [k, v] of Object.entries(allowed_menus)) {
            if (!MENU_KEYS.includes(k)) continue;
            let lv = v === 'edit' ? 'edit' : v === 'view' ? 'view' : null;
            if (!lv) continue;
            if (lv === 'edit' && !EDITABLE_MENUS.includes(k)) lv = 'view';
            out[k] = lv;
        }
    }
    return out;
}
// Middleware: gate endpoint behind a menu + level (verifies token like requireAuth).
function requireMenu(menu, level = 'view') {
    return (req, res, next) => {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Autentikasi diperlukan.' });
        try {
            const user = jwt.verify(token, JWT_SECRET);
            req.user = user;
            if (!hasMenu(user, menu, level)) {
                return res.status(403).json({ error: level === 'edit'
                    ? 'Akses ditolak. Anda hanya punya akses lihat (view-only) untuk menu ini.'
                    : 'Akses ditolak. Anda tidak punya akses ke menu ini.' });
            }
            next();
        } catch {
            res.status(401).json({ error: 'Token tidak valid atau sudah kadaluarsa.' });
        }
    };
}

// Optional auth — decode user if a valid token is present, else null.
// Used by public endpoints that grant extra capability to logged-in admins.
function getOptionalUser(req) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return null;
    try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
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
// Bukti order/refund (bukti bayar, packing, refund) → bucket PRIVAT, diakses via signed URL.
const SUPABASE_PRIVATE_BUCKET = process.env.SUPABASE_PRIVATE_BUCKET || 'wearscrubs-orders';
// Folder yang isinya sensitif → wajib private bucket. Produk & logo bordir tetap public.
const PRIVATE_FOLDERS = ['orders', 'refunds'];

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
    const isPrivate = PRIVATE_FOLDERS.includes(folder);
    const bucket = isPrivate ? SUPABASE_PRIVATE_BUCKET : SUPABASE_BUCKET;

    if (supabaseClient) {
        // Upload ke Supabase Storage
        const { error } = await supabaseClient
            .storage
            .from(bucket)
            .upload(filename, buffer, {
                contentType: ext === '.jpg' || ext === '.jpeg'
                    ? 'image/jpeg'
                    : ext === '.png' ? 'image/png'
                    : ext === '.webp' ? 'image/webp'
                    : 'image/jpeg',
                upsert: false
            });
        if (error) throw new Error(`Supabase upload error: ${error.message}`);
        // Private (bukti order/refund): simpan PATH saja → di-sign saat dibaca (lihat signedMediaUrl).
        // Public (produk/logo): kembalikan URL publik permanen.
        if (isPrivate) return filename;
        const { data: urlData } = supabaseClient
            .storage
            .from(bucket)
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

// Konversi nilai tersimpan jadi URL yang bisa dirender oleh admin.
// - Path privat (mis. "orders/ws_123.jpg") → signed URL ber-expiry dari private bucket.
// - URL publik lama (http…) atau file lokal (/uploads/…) → dikembalikan apa adanya.
async function signedMediaUrl(value, expirySeconds = 3600) {
    if (!value || typeof value !== 'string') return value;
    if (value.startsWith('http') || value.startsWith('/uploads/')) return value;
    if (!supabaseClient) return value;
    const { data, error } = await supabaseClient
        .storage
        .from(SUPABASE_PRIVATE_BUCKET)
        .createSignedUrl(value, expirySeconds);
    if (error || !data) return value; // fail-safe: jangan crash render kalau sign gagal
    return data.signedUrl;
}

// Parse a base64 data URL (data:image/png;base64,XXXX) into { buffer, ext }.
// Returns null if the string is not a base64 image data URL.
function dataUrlToBuffer(dataUrl) {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
    if (!m) return null;
    const mime = m[1];
    const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
    try { return { buffer: Buffer.from(m[2], 'base64'), ext }; }
    catch { return null; }
}

// Upload any base64 logo values inside embroidery_details to Storage, replacing
// them with permanent URLs. Keeps base64 as fallback if upload fails (never blocks
// the order). Prevents multi-MB base64 from bloating the orders table.
async function externalizeEmbroideryLogos(embDetails) {
    if (!Array.isArray(embDetails)) return embDetails;
    const out = [];
    for (const e of embDetails) {
        if (e && e.type === 'logo' && typeof e.value === 'string' && e.value.startsWith('data:image/')) {
            const parsed = dataUrlToBuffer(e.value);
            if (parsed) {
                try {
                    const url = await uploadToSupabase(parsed.buffer, `logo${parsed.ext}`, 'logos');
                    out.push({ ...e, value: url });
                    continue;
                } catch (err) {
                    console.error('Logo externalize failed, keeping base64:', err?.message || err);
                }
            }
        }
        out.push(e);
    }
    return out;
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

// Wrap a sequence of queries in a transaction. Pass the `client` to all queries
// inside the callback — using dbRun/dbGet/dbAll there would grab a DIFFERENT pool
// connection and bypass the transaction. On throw, rolls back; otherwise commits.
// External side effects (file uploads, WA notifications) MUST be done OUTSIDE so
// they don't extend lock duration or block on network latency.
async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try { await client.query('ROLLBACK'); }
        catch (rbErr) { console.error('Transaction rollback failed:', rbErr); }
        throw err;
    } finally {
        client.release();
    }
}

// Fire-and-log WA notification — Fonnte downtime should never cause an order
// endpoint to return 500 after the DB state is already committed.
async function safeWA(message, context = '', targetOverride = null) {
    try { await sendWANotification(message, targetOverride); }
    catch (e) { console.error(`WA notify failed${context ? ' ('+context+')' : ''}:`, e?.message || e); }
}

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
    // Migrate weight to NUMERIC so decimal kg (e.g. 1.5) isn't truncated to int.
    await dbRun(`ALTER TABLE orders ALTER COLUMN shipping_weight_kg TYPE NUMERIC USING shipping_weight_kg::numeric`).catch(() => {});
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
    // Bonus item — gift, charged Rp 0 (product + bordir all free). Stock still deducted.
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_bonus BOOLEAN DEFAULT FALSE`);
    // WA-Order enhancement (per-item): admin-overridable bordir prices, custom size
    // (off-catalog, skips stock), and PO (qty > stock, fulfilled later). Live DB already
    // has these via earlier migration — kept here so server.js is authoritative on fresh DBs.
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS bordir_nama_price INTEGER DEFAULT NULL`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS bordir_logo_price INTEGER DEFAULT NULL`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_custom_size BOOLEAN DEFAULT FALSE`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_po BOOLEAN DEFAULT FALSE`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS po_fulfilled BOOLEAN DEFAULT FALSE`);
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

    // ── Migrate: expand order_source (add offline channels for POS-ready reports) ──
    // website = toko online, whatsapp = order manual via WA, event_offline = bazar/
    // pameran (jualan langsung), offline = walk-in toko, collaboration_event =
    // kerjasama pihak ke-2 (pembeli bayar ke partner, invoice ditagih ke partner
    // dengan consignment 30%). Drop inline CHECK, recreate wider.
    await dbRun(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_source_check`).catch(() => {});
    await dbRun(`ALTER TABLE orders ADD CONSTRAINT orders_order_source_check CHECK(order_source IN ('website','whatsapp','event_offline','offline','collaboration_event'))`).catch(() => {});
    // billing_to = nama pihak yang ditagih (partner) untuk order collaboration_event.
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_to TEXT DEFAULT NULL`);

    // ── Migrate: paid_at timestamp (basis tanggal untuk laporan sales) ────────────
    // Diisi NOW() saat confirm-payment. Backfill order paid LAMA dari updated_at
    // (aproksimasi — updated_at di-set saat pembayaran dikonfirmasi).
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ DEFAULT NULL`);
    await dbRun(`UPDATE orders SET paid_at = updated_at WHERE payment_status = 'paid' AND paid_at IS NULL`).catch(() => {});

    // ── Migrate: per-menu permission model (role manager/viewer → staff + map) ─────
    // Permission lama = role global (manager edit / viewer view) + allowed_menus (list
    // visibility). Baru = admin (full) atau staff dengan peta {menu:'view'|'edit'}.
    // Konversi otomatis biar akses efektif TIDAK berubah (anti-lockout):
    //   manager → semua menu / menu yang diizinkan jadi 'edit'; viewer → 'view'.
    await dbRun(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`).catch(() => {});
    await dbRun(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('admin','staff','manager','viewer'))`).catch(() => {});
    try {
        const legacyUsers = await dbAll("SELECT id, role, allowed_menus FROM users WHERE role IN ('manager','viewer')");
        for (const u of legacyUsers) {
            const level = u.role === 'viewer' ? 'view' : 'edit';
            let parsed = null;
            try { parsed = u.allowed_menus ? JSON.parse(u.allowed_menus) : null; } catch { parsed = null; }
            let map;
            if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
                map = parsed; // already a map (idempotent safety)
            } else {
                const menus = Array.isArray(parsed) ? parsed : MENU_KEYS; // null (all) → all menus
                map = Object.fromEntries(menus.map(m => [m, level]));
            }
            // Non-editable menus can never be 'edit' → clamp to 'view'.
            for (const k of Object.keys(map)) {
                if (!EDITABLE_MENUS.includes(k) && map[k] === 'edit') map[k] = 'view';
            }
            await dbRun("UPDATE users SET role = 'staff', allowed_menus = $1 WHERE id = $2", [JSON.stringify(map), u.id]);
        }
        if (legacyUsers.length) console.log(`[migrate] converted ${legacyUsers.length} user(s) manager/viewer → staff (per-menu permissions)`);
    } catch (e) { console.error('[migrate] permission conversion failed:', e?.message || e); }

    // ── Migrate: tracking_number for shipment ─────────────────────────────────
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT`).catch(() => {});
    // ── Migrate: track which admin performed each order photo step ─────────────
    await dbRun(`ALTER TABLE order_photos ADD COLUMN IF NOT EXISTS performed_by TEXT`);
    // Photo optional for some steps (bordir-done, pack): step record saved w/o image → allow NULL.
    await dbRun(`ALTER TABLE order_photos ALTER COLUMN photo_url DROP NOT NULL`).catch(() => {});
    // Covering index for FK order_photos.order_id (dipakai saat fetch foto per order + FK CASCADE).
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_order_photos_order ON order_photos(order_id)`).catch(() => {});

    // ── Refunds (cancelled-paid orders + rejected bordir) ─────────────────────
    await dbRun(`CREATE TABLE IF NOT EXISTS refunds (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        refund_type TEXT NOT NULL CHECK(refund_type IN ('cancellation','bordir_nama','bordir_logo','partial_item','manual')),
        amount INTEGER NOT NULL,
        reason TEXT DEFAULT '',
        items_summary TEXT DEFAULT '',
        customer_name TEXT,
        customer_phone TEXT,
        customer_bank_name TEXT DEFAULT '',
        customer_bank_account TEXT DEFAULT '',
        customer_bank_holder TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','transferred','completed','cancelled')),
        proof_url TEXT,
        note TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        transferred_at TIMESTAMP,
        completed_at TIMESTAMP,
        admin_user TEXT DEFAULT ''
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_refunds_status   ON refunds(status)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_refunds_order    ON refunds(order_id)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_refunds_created  ON refunds(created_at DESC)`).catch(() => {});

    // ── Exchanges (size exchange — barang TIDAK direfund, hanya tukar size) ────
    // State machine: pending → approved (reserve stok pengganti) → completed.
    // Reason-driven return: size_mismatch → balik ke stok jual; defect → ke stock_reject.
    // Reserve-at-approve: stok size pengganti dikurangi saat approve (cegah kebeli orang lain).
    await dbRun(`CREATE TABLE IF NOT EXISTS exchanges (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        order_item_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        color TEXT NOT NULL,
        variant_type TEXT NOT NULL DEFAULT 'null',
        from_size TEXT NOT NULL,
        to_size TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        reason TEXT NOT NULL DEFAULT 'size_mismatch' CHECK(reason IN ('size_mismatch','defect')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','completed','cancelled')),
        return_received BOOLEAN DEFAULT FALSE,
        return_received_at TIMESTAMP,
        replacement_shipped_at TIMESTAMP,
        shipping_fee INTEGER DEFAULT 0,
        note TEXT DEFAULT '',
        customer_name TEXT,
        customer_phone TEXT,
        admin_user TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_exchanges_status  ON exchanges(status)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_exchanges_order   ON exchanges(order_id)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_exchanges_item    ON exchanges(order_item_id)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_exchanges_created ON exchanges(created_at DESC)`).catch(() => {});

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
    await createIdx('CREATE INDEX IF NOT EXISTS idx_orders_paid_at     ON orders(paid_at)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_order_items_order  ON order_items(order_id)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_order_items_prod   ON order_items(product_id)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_sm_product         ON stock_movements(product_id)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_sm_lookup          ON stock_movements(product_id, color, size, variant_type)');
    await createIdx('CREATE INDEX IF NOT EXISTS idx_sm_created         ON stock_movements(created_at DESC)');

    // ── Migrate: reject stock support ─────────────────────────────────────────
    await dbRun(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS stock_reject INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS is_reject BOOLEAN DEFAULT FALSE`);
    // Extend movement_type CHECK to allow reject + exchange movement types
    await dbRun(`ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check`);
    await dbRun(`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
        CHECK(movement_type IN ('receive','manual_set','order_out','order_cancel_restore','receive_reject','reject_to_normal','exchange_replacement_out','exchange_return_in','order_edit_adjust'))`);

    // ── Seed default admin ────────────────────────────────────────────────────
    // Production: REQUIRE ADMIN_INITIAL_PASSWORD env var (min 12 chars).
    // Dev: fall back to 'admin123' only when explicitly not in production.
    // This runs once — if an admin already exists, nothing happens.
    const existingAdmin = await dbGet('SELECT id FROM users WHERE username = $1', ['admin']);
    if (!existingAdmin) {
        const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
        const initialPassword = process.env.ADMIN_INITIAL_PASSWORD;

        if (initialPassword) {
            if (initialPassword.length < 12) {
                console.error('[Auth] CRITICAL: ADMIN_INITIAL_PASSWORD must be at least 12 characters. Refusing to seed admin. Set a stronger password and restart.');
                return;
            }
            const hash = await bcrypt.hash(initialPassword, 10);
            await dbRun(
                'INSERT INTO users (username, password_hash, role, allowed_menus) VALUES ($1, $2, $3, $4)',
                ['admin', hash, 'admin', null]
            );
            console.log('[Auth] Admin seeded from ADMIN_INITIAL_PASSWORD env var. Login as "admin" with that password, then change it via /api/auth/change-password.');
        } else if (isProduction) {
            console.error('[Auth] CRITICAL: No admin exists and ADMIN_INITIAL_PASSWORD is not set in production. Refusing to seed weak default credentials. Set ADMIN_INITIAL_PASSWORD env var (min 12 chars) on Railway and restart.');
            return;
        } else {
            // Dev only — convenience fallback
            const hash = await bcrypt.hash('admin123', 10);
            await dbRun(
                'INSERT INTO users (username, password_hash, role, allowed_menus) VALUES ($1, $2, $3, $4)',
                ['admin', hash, 'admin', null]
            );
            console.warn('[Auth] DEV ONLY: created admin/admin123. For production, set ADMIN_INITIAL_PASSWORD env var.');
        }
    }
}
initDB()
    .then(() => backfillCancelledRefunds())
    .catch(err => console.error('[DB Init Error]', err));

// Idempotent backfill — creates a 'pending' refund record for any cancelled-paid
// order that doesn't already have one. Runs once at startup. Safe to re-run.
async function backfillCancelledRefunds() {
    try {
        const orphans = await dbAll(
            `SELECT o.id, o.order_code, o.total_amount, o.cancel_reason,
                    o.customer_name, o.customer_phone, o.cancelled_by
             FROM orders o
             WHERE o.order_status = 'cancelled' AND o.payment_status = 'paid'
               AND NOT EXISTS (SELECT 1 FROM refunds r
                               WHERE r.order_id = o.id AND r.refund_type = 'cancellation')`,
            []
        );
        if (orphans.length === 0) {
            console.log('[Refund Backfill] No orphan cancelled-paid orders.');
            return;
        }
        for (const o of orphans) {
            const items = await dbAll(
                `SELECT oi.quantity, oi.size, oi.color, oi.variant_type, p.name AS product_name
                 FROM order_items oi JOIN products p ON p.id = oi.product_id
                 WHERE oi.order_id = $1`,
                [o.id]
            );
            const itemsSummary = items
                .map(i => `${i.product_name} (${i.color}${i.variant_type && i.variant_type !== 'null' ? ', ' + i.variant_type : ''}, ${i.size}) ×${i.quantity}`)
                .join('; ');
            await dbRun(
                `INSERT INTO refunds (order_id, refund_type, amount, reason, items_summary,
                                      customer_name, customer_phone, status, admin_user, note)
                 VALUES ($1, 'cancellation', $2, $3, $4, $5, $6, 'pending', $7, $8)`,
                [o.id, parseInt(o.total_amount) || 0,
                 o.cancel_reason || '(refund record auto-dibuat dari backfill)',
                 itemsSummary, o.customer_name, o.customer_phone,
                 o.cancelled_by || 'system-backfill',
                 'Refund record auto-dibuat untuk pesanan yang sudah dibatalkan sebelum modul Refund aktif.']
            );
        }
        console.log(`[Refund Backfill] Created ${orphans.length} refund record(s) for previously cancelled-paid orders.`);
    } catch (err) {
        console.error('[Refund Backfill] Error:', err.message);
    }
}


// ─── WhatsApp Notification (Fonnte) ──────────────────────────────────────────
// Sends to ADMIN_WA_NUMBER by default; pass `targetOverride` (e.g. customer phone)
// to send to a different recipient.
async function sendWANotification(message, targetOverride = null) {
    const token = process.env.FONNTE_TOKEN;
    const target = targetOverride || process.env.ADMIN_WA_NUMBER;
    if (!token || token === 'GANTI_DENGAN_TOKEN_FONNTE_ANDA') {
        console.log('[WA] Token belum dikonfigurasi. Notifikasi dilewati.');
        return;
    }
    if (!target) {
        console.log('[WA] Target kosong, notifikasi dilewati.');
        return;
    }
    try {
        const res = await fetch('https://api.fonnte.com/send', {
            method: 'POST',
            headers: { 'Authorization': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ target, message, countryCode: '62' })
        });
        const data = await res.json();
        console.log('[WA] Notifikasi terkirim ke', target, ':', data?.status || data);
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
    // Scrub colors
    'black': '#000000',
    'beige': '#d7c5a9',
    'olive': '#696250',
    'charcoal-grey': '#5f5051',
    'light-grey': '#898391',
    'maroon': '#6c1b22',
    'purple': '#a4b4e8',
    'blush': '#f0c6bb',
    'turquoise': '#40e0d0',
    'white': '#f0f0f0',
    // Gown/Avery colors (purple di Avery di-override ke plum via PRODUCT_COLOR_HEX_OVERRIDES)
    'navy': '#242738',
    'tosca': '#02869d',
    'orange': '#d7a353',
    'blue': '#7a97b5',
    'off-white': '#dee0df',
    'grey': '#bbb5b5',
    'new-pink': '#f472b6',
    'green-mint': '#6ee7b7',
    'baby-blue': '#b9d1db',
    'baby-pink': '#c0a9ad',
    'old-pink': '#d6b6bb'
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
    'white': 'White',
    'navy': 'Navy',
    'tosca': 'Tosca',
    'orange': 'Orange',
    'blue': 'Blue',
    'off-white': 'Off White',
    'grey': 'Grey',
    'new-pink': 'New Pink',
    'green-mint': 'Green Mint',
    'baby-blue': 'Baby Blue',
    'baby-pink': 'Baby Pink',
    'old-pink': 'Pink'
};
// Override hex per produk untuk warna yang artinya beda antar lini (mis. "purple" di
// Avery = plum gelap, beda dari purple scrub periwinkle). Key = SKU produk.
const PRODUCT_COLOR_HEX_OVERRIDES = {
    'WS-GWN-AVERY': { 'purple': '#362136' }
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
        color_hex_map: { ...COLOR_HEX, ...(PRODUCT_COLOR_HEX_OVERRIDES[p.sku] || {}) },
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
        if (!['admin', 'staff'].includes(role)) return res.status(400).json({ error: 'Role tidak valid (admin / staff).' });
        if (password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter.' });

        const hash = await bcrypt.hash(password, 10);
        // admin = full (allowed_menus null). staff = explicit per-menu map.
        const allowedMenusStr = role === 'admin' ? null : JSON.stringify(sanitizePermsInput(allowed_menus));

        const result = await dbRun(
            'INSERT INTO users (username, password_hash, role, allowed_menus) VALUES ($1, $2, $3, $4) RETURNING id',
            [username.trim(), hash, role, allowedMenusStr]
        );
        const newId = result.rows[0].id;
        res.json({ id: newId, username, role, allowed_menus: allowedMenusStr ? JSON.parse(allowedMenusStr) : null });
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

        // Anti-lockout: jangan sampai sistem kehilangan admin aktif terakhir.
        const target = await dbGet('SELECT role FROM users WHERE id = $1', [id]);
        if (!target) return res.status(404).json({ error: 'User tidak ditemukan.' });
        const adminCount = (await dbGet("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND is_active = 1")).n;
        const demotingLastAdmin = target.role === 'admin' && role && role !== 'admin' && adminCount <= 1;
        const deactivatingLastAdmin = target.role === 'admin' && (is_active === false || is_active === 0) && adminCount <= 1;
        if (demotingLastAdmin || deactivatingLastAdmin)
            return res.status(400).json({ error: 'Tidak bisa menurunkan/menonaktifkan admin terakhir.' });

        if (role) {
            if (!['admin', 'staff'].includes(role)) return res.status(400).json({ error: 'Role tidak valid (admin / staff).' });
            await dbRun('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
            if (role === 'admin') await dbRun('UPDATE users SET allowed_menus = NULL WHERE id = $1', [id]); // admin = full
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
            const effRole = role || target.role;
            const str = effRole === 'admin' ? null : JSON.stringify(sanitizePermsInput(allowed_menus));
            await dbRun('UPDATE users SET allowed_menus = $1 WHERE id = $2', [str, id]);
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
        // Anti-lockout: jangan hapus admin aktif terakhir.
        const target = await dbGet('SELECT role FROM users WHERE id = $1', [id]);
        if (target && target.role === 'admin') {
            const adminCount = (await dbGet("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND is_active = 1")).n;
            if (adminCount <= 1) return res.status(400).json({ error: 'Tidak bisa menghapus admin terakhir.' });
        }
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
app.put('/api/products/popular', requireMenu('popular','edit'), async (req, res) => {
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
app.post('/api/products', requireMenu('products','edit'), upload.any(), async (req, res) => {
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

        const photoMap = safeJSON(req.body.photo_map, {});
        const selColors = safeJSON(colors, []);
        const selTypes = safeJSON(types, []);
        const selSizes = safeJSON(sizes, []);
        const NUM_PHOTOS = 3;

        // Phase 1 (DI LUAR transaksi): upload semua foto → map "color|type" → [{slot,url}].
        // Upload eksternal bisa lambat; dilakukan dulu agar transaksi DB di Phase 2 singkat & atomik.
        const photosByVariant = new Map();
        for (const color of selColors) {
            for (const type of selTypes) {
                const slots = [];
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
                    if (photoUrl) slots.push({ slot: i, url: photoUrl });
                }
                photosByVariant.set(`${color}|${type}`, slots);
            }
        }

        // Phase 2 (ATOMIK): product + variants + inventory dalam satu transaksi.
        // Kalau ada yang gagal, semua di-rollback → tidak ada produk parsial.
        const productId = await withTransaction(async (client) => {
            const result = await client.query(
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
            const pid = result.rows[0].id;

            for (const color of selColors) {
                for (const type of selTypes) {
                    const slots = photosByVariant.get(`${color}|${type}`) || [];
                    for (const { slot, url } of slots) {
                        await client.query(
                            `INSERT INTO product_variants (product_id, color, variant_type, photo_url, slot) VALUES ($1,$2,$3,$4,$5)`,
                            [pid, color, type, url, slot]
                        );
                    }
                    // Pastikan ada baris slot-1 (main) meski tanpa foto.
                    if (!slots.some(s => s.slot === 1)) {
                        await client.query(
                            `INSERT INTO product_variants (product_id, color, variant_type, photo_url, slot) VALUES ($1,$2,$3,$4,1)
                             ON CONFLICT (product_id, color, variant_type, slot) DO NOTHING`,
                            [pid, color, type, null]
                        );
                    }
                    for (const size of selSizes) {
                        await client.query(
                            `INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES ($1,$2,$3,$4,$5)`,
                            [pid, size, color, type, 0]
                        );
                    }
                }
            }
            return pid;
        });

        invalidateCache('products', 'inventory');
        res.json({ id: productId, message: 'Produk berhasil dibuat' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/products/:id
app.put('/api/products/:id', requireMenu('products','edit'), upload.any(), async (req, res) => {
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

        const photoMap = safeJSON(req.body.photo_map, {});
        const selColors = safeJSON(colors, []);
        const selTypes  = safeJSON(types,  []);
        const selSizes  = safeJSON(sizes,  []);
        const NUM_PHOTOS = 3;

        // Phase 1 (DI LUAR transaksi): resolve operasi foto — upload eksternal di sini.
        // action 'clear' = hapus slot (tombol X), 'set' = insert/update foto.
        const photoOps = [];
        for (const color of selColors) {
            for (const type of selTypes) {
                for (let i = 1; i <= NUM_PHOTOS; i++) {
                    const mapKey = `${color}_${type}_${i}`;
                    if (req.body[`photo_clear_${mapKey}`] === '1') {
                        photoOps.push({ color, type, slot: i, action: 'clear' });
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
                    if (photoUrl) photoOps.push({ color, type, slot: i, action: 'set', url: photoUrl });
                }
            }
        }

        const effectiveTypes = selTypes.length > 0 ? selTypes : ['null'];

        // Phase 2 (ATOMIK): update product + operasi foto + pastikan baris variant/inventory.
        await withTransaction(async (client) => {
            await client.query(
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

            for (const op of photoOps) {
                if (op.action === 'clear') {
                    await client.query(
                        `DELETE FROM product_variants WHERE product_id=$1 AND color=$2 AND variant_type=$3 AND slot=$4`,
                        [req.params.id, op.color, op.type, op.slot]
                    );
                } else {
                    await client.query(
                        `INSERT INTO product_variants (product_id, color, variant_type, photo_url, slot)
                         VALUES ($1,$2,$3,$4,$5)
                         ON CONFLICT(product_id, color, variant_type, slot) DO UPDATE SET photo_url = EXCLUDED.photo_url`,
                        [req.params.id, op.color, op.type, op.url, op.slot]
                    );
                }
            }

            // Pastikan baris variant + inventory ada untuk setiap kombinasi color/type/size baru
            for (const color of selColors) {
                for (const type of effectiveTypes) {
                    const dbType = type === 'null' ? null : type;
                    const existing = await client.query(
                        `SELECT id FROM product_variants
                         WHERE product_id = $1 AND color = $2 AND variant_type IS NOT DISTINCT FROM $3 LIMIT 1`,
                        [req.params.id, color, dbType]
                    );
                    if (existing.rows.length === 0) {
                        await client.query(
                            `INSERT INTO product_variants (product_id, color, variant_type, photo_url, slot)
                             VALUES ($1, $2, $3, $4, 1)
                             ON CONFLICT (product_id, color, variant_type, slot) DO NOTHING`,
                            [req.params.id, color, dbType, null]
                        );
                    }
                    // Insert inventory rows for each size (DO NOTHING = preserve existing stock)
                    for (const size of selSizes) {
                        await client.query(
                            `INSERT INTO inventory (product_id, size, color, variant_type, stock)
                             VALUES ($1, $2, $3, $4, $5)
                             ON CONFLICT (product_id, size, color, variant_type) DO NOTHING`,
                            [req.params.id, size, color, type, 0]
                        );
                    }
                }
            }
        });

        invalidateCache('products', 'inventory');
        res.json({ message: 'Produk berhasil diperbarui' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// DELETE /api/products/:id (soft delete — preserves order history)
app.delete('/api/products/:id', requireMenu('products','edit'), async (req, res) => {
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

// GET /api/inventory/reservations — pending orders per varian (for Grid View "reserved" badge)
// "Reserved" = orders that are NOT yet shipped/done/cancelled — i.e. still occupy stock conceptually.
// Returns map keyed by `${product_id}__${size}__${color}__${variant_type}` so frontend can lookup O(1).
app.get('/api/inventory/reservations', requireAuth(), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT oi.product_id, oi.size, oi.color, oi.variant_type,
                    SUM(oi.quantity)::int AS reserved_qty,
                    COUNT(DISTINCT o.id)::int AS order_count,
                    COALESCE(SUM(oi.quantity) FILTER (WHERE oi.is_po = TRUE AND oi.po_fulfilled = FALSE), 0)::int AS po_qty,
                    json_agg(json_build_object(
                        'order_id', o.id,
                        'order_code', o.order_code,
                        'customer_name', o.customer_name,
                        'qty', oi.quantity,
                        'order_status', o.order_status,
                        'is_po', oi.is_po,
                        'po_fulfilled', oi.po_fulfilled,
                        'created_at', o.created_at
                    ) ORDER BY o.created_at DESC) AS buyers
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             WHERE o.order_status IN ('waiting_payment','confirmed','bordir','packed')
             GROUP BY oi.product_id, oi.size, oi.color, oi.variant_type`,
            []
        );
        const map = {};
        for (const r of rows) {
            const key = `${r.product_id}__${r.size}__${r.color}__${r.variant_type}`;
            map[key] = {
                reserved_qty: r.reserved_qty,
                order_count: r.order_count,
                po_qty: r.po_qty,
                buyers: r.buyers
            };
        }
        res.json(map);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pre-orders — semua line yang masih MENUNGGU dipenuhi (PO katalog + Custom),
// untuk menu Pre-Order. Diurutkan FIFO (tertua dulu). Frontend menghitung umur dari created_at.
app.get('/api/pre-orders', requireAuth(), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT oi.id AS item_id, oi.order_id, oi.product_id, oi.size, oi.color, oi.variant_type,
                    oi.quantity, oi.is_po, oi.is_custom_size, oi.po_fulfilled, oi.price,
                    o.order_code, o.customer_name, o.customer_phone, o.order_source,
                    o.payment_status, o.order_status, o.created_at,
                    p.name AS product_name,
                    inv.stock AS variant_stock,
                    CASE WHEN oi.is_custom_size THEN 'custom' ELSE 'catalog' END AS po_type
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             JOIN products p ON p.id = oi.product_id
             LEFT JOIN inventory inv ON inv.product_id = oi.product_id AND inv.size = oi.size
                  AND inv.color = oi.color AND inv.variant_type = oi.variant_type
             WHERE (oi.is_po = TRUE OR oi.is_custom_size = TRUE)
               AND oi.po_fulfilled = FALSE
               AND o.order_status <> 'cancelled'
             ORDER BY o.created_at ASC, oi.id ASC`,
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
app.post('/api/inventory/receive', requireMenu('inventory','edit'), async (req, res) => {
    try {
        const { product_id, size, color, variant_type, quantity, note, stock_type } = req.body;
        if (!product_id || !size || !color || !variant_type)
            return res.status(400).json({ error: 'Data tidak lengkap' });
        const qty = parseInt(quantity);
        if (!qty || qty <= 0)
            return res.status(400).json({ error: 'Jumlah harus lebih dari 0' });

        const isReject = stock_type === 'reject';
        // Atomic: lock row → read current → update → log movement → allocate POs (FIFO)
        const result = await withTransaction(async (client) => {
            const curRes = await client.query(
                'SELECT stock, stock_reject FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                [product_id, size, color, variant_type]
            );
            const cur = curRes.rows[0];
            const normalBefore = cur ? parseInt(cur.stock || 0) : 0;
            const rejectBefore = cur ? parseInt(cur.stock_reject || 0) : 0;
            const before = isReject ? rejectBefore : normalBefore;
            const after  = before + qty;

            if (isReject) {
                await client.query(
                    `INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES ($1,$2,$3,$4,0,$5)
                     ON CONFLICT(product_id, size, color, variant_type) DO UPDATE SET stock_reject = $6`,
                    [product_id, size, color, variant_type, after, after]
                );
            } else {
                await client.query(
                    `INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject) VALUES ($1,$2,$3,$4,$5,0)
                     ON CONFLICT(product_id, size, color, variant_type) DO UPDATE SET stock = $6`,
                    [product_id, size, color, variant_type, after, after]
                );
            }
            await client.query(
                `INSERT INTO stock_movements
                 (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, admin_user, is_reject)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [product_id, size, color, variant_type, isReject ? 'receive_reject' : 'receive',
                 qty, before, after, note || (isReject ? 'Terima stok reject' : 'Terima stok baru'),
                 req.user.username, isReject]
            );

            // ── Pre-Order FIFO allocation ────────────────────────────────────────────
            // When NORMAL stock arrives, auto-allocate it to waiting Pre-Orders for this
            // exact variant. Rules (locked with James):
            //   • Only PAID, non-cancelled PO lines are eligible (don't lock stock for
            //     orders that may never pay).
            //   • Strict FIFO by order date — oldest first.
            //   • Whole-item: a PO is fulfilled only if the full qty fits; otherwise we
            //     STOP (don't skip ahead to a smaller PO — preserves fairness/order).
            // Fulfilling = deduct stock now ("blok") + mark po_fulfilled; admin ships
            // manually afterward (the pack guard releases once po_fulfilled = TRUE).
            // Reject stock never fulfills POs.
            const fulfilledPOs = [];
            let stockFinal = after;
            if (!isReject) {
                const poRes = await client.query(
                    `SELECT oi.id, oi.quantity, oi.order_id, o.order_code
                       FROM order_items oi JOIN orders o ON o.id = oi.order_id
                      WHERE oi.product_id=$1 AND oi.size=$2 AND oi.color=$3 AND oi.variant_type=$4
                        AND oi.is_po = TRUE AND oi.po_fulfilled = FALSE
                        AND o.payment_status = 'paid' AND o.order_status <> 'cancelled'
                      ORDER BY o.created_at ASC, oi.id ASC
                      FOR UPDATE OF oi`,
                    [product_id, size, color, variant_type]
                );
                for (const po of poRes.rows) {
                    const need = parseInt(po.quantity);
                    if (stockFinal < need) break;            // whole-item, strict FIFO
                    const sb = stockFinal;
                    stockFinal -= need;
                    await client.query(
                        `UPDATE inventory SET stock = stock - $1 WHERE product_id=$2 AND size=$3 AND color=$4 AND variant_type=$5`,
                        [need, product_id, size, color, variant_type]
                    );
                    await client.query(`UPDATE order_items SET po_fulfilled = TRUE WHERE id = $1`, [po.id]);
                    await client.query(
                        `INSERT INTO stock_movements
                         (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                         VALUES ($1,$2,$3,$4,'order_out',$5,$6,$7,$8,$9,$10)`,
                        [product_id, size, color, variant_type, -need, sb, stockFinal,
                         `PO terpenuhi ${po.order_code}`, po.order_id, req.user.username]
                    );
                    fulfilledPOs.push(po.order_code);
                }
            }
            return { before, after, fulfilledPOs, stockFinal };
        });

        invalidateCache('inventory');
        const fulfilled = result.fulfilledPOs || [];
        let msg = isReject ? 'Stok reject ditambahkan' : 'Stok berhasil ditambahkan';
        if (fulfilled.length) msg += ` · ${fulfilled.length} Pre-Order terpenuhi (siap dikirim): ${fulfilled.join(', ')}`;
        res.json({ message: msg, before: result.before, after: result.after, stock_final: result.stockFinal,
                   fulfilled_pos: fulfilled, added: qty, stock_type: isReject ? 'reject' : 'normal' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/inventory/reject-to-normal — ubah stok reject menjadi stok normal
app.put('/api/inventory/reject-to-normal', requireMenu('inventory','edit'), async (req, res) => {
    try {
        const { product_id, size, color, variant_type, quantity } = req.body;
        if (!product_id || !size || !color || !variant_type)
            return res.status(400).json({ error: 'Data tidak lengkap' });
        const qty = parseInt(quantity);
        if (!qty || qty <= 0) return res.status(400).json({ error: 'Jumlah harus lebih dari 0' });

        // Atomic: lock row → validate → swap reject↔normal → log movement
        const result = await withTransaction(async (client) => {
            const curRes = await client.query(
                'SELECT stock, stock_reject FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                [product_id, size, color, variant_type]
            );
            const cur = curRes.rows[0];
            if (!cur) { const e = new Error('Varian tidak ditemukan'); e.status = 404; throw e; }

            const rejectBefore = parseInt(cur.stock_reject || 0);
            if (qty > rejectBefore) { const e = new Error(`Stok reject hanya ${rejectBefore}`); e.status = 400; throw e; }

            const normalBefore = parseInt(cur.stock || 0);
            const rejectAfter  = rejectBefore - qty;
            const normalAfter  = normalBefore + qty;

            await client.query(
                'UPDATE inventory SET stock=$1, stock_reject=$2 WHERE product_id=$3 AND size=$4 AND color=$5 AND variant_type=$6',
                [normalAfter, rejectAfter, product_id, size, color, variant_type]
            );
            await client.query(
                `INSERT INTO stock_movements
                 (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, admin_user, is_reject)
                 VALUES ($1,$2,$3,$4,'reject_to_normal',$5,$6,$7,$8,$9,$10)`,
                [product_id, size, color, variant_type, qty, normalBefore, normalAfter,
                 `Diubah reject→normal: ${qty} unit (reject ${rejectBefore}→${rejectAfter})`, req.user.username, false]
            );
            return { normalAfter, rejectAfter };
        });

        invalidateCache('inventory');
        res.json({ message: `${qty} stok diubah dari reject ke normal`, normal_after: result.normalAfter, reject_after: result.rejectAfter });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Whitelist alasan perubahan manual stok. Disertakan ke note (format "[Reason]" /
// "[Reason] free-text") supaya history audit jelas, bukan generik "Update manual stok".
const STOCK_REASONS = [
    'Stock Opname Awal',
    'Koreksi Salah Input',
    'Penyesuaian Stok Fisik',
    'Barang Hilang/Rusak',
    'Lainnya'
];
function buildStockNote(reason, freeText, fallback = 'Koreksi Salah Input') {
    const r = STOCK_REASONS.includes(reason) ? reason : fallback;
    const ft = (typeof freeText === 'string' ? freeText.trim() : '').slice(0, 200);
    return ft ? `[${r}] ${ft}` : `[${r}]`;
}

// PUT /api/inventory/single — update stok manual, log ke stock_movements
app.put('/api/inventory/single', requireMenu('inventory','edit'), async (req, res) => {
    try {
        const { product_id, size, color, variant_type, stock, reason, note } = req.body;
        const after = parseInt(stock);
        if (isNaN(after) || after < 0) return res.status(400).json({ error: 'Nilai stok tidak valid' });
        const finalNote = buildStockNote(reason, note);

        // Atomic: lock row → read current → upsert → log movement (only if changed)
        const before = await withTransaction(async (client) => {
            const curRes = await client.query(
                'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                [product_id, size, color, variant_type]
            );
            const cur = curRes.rows[0];
            const beforeVal = cur ? parseInt(cur.stock) : 0;

            await client.query(
                `INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT(product_id, size, color, variant_type) DO UPDATE SET stock = $6`,
                [product_id, size, color, variant_type, after, after]
            );
            if (beforeVal !== after) {
                await client.query(
                    `INSERT INTO stock_movements
                     (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, admin_user)
                     VALUES ($1,$2,$3,$4,'manual_set',$5,$6,$7,$8,$9)`,
                    [product_id, size, color, variant_type, after - beforeVal, beforeVal, after, finalNote, req.user.username]
                );
            }
            return beforeVal;
        });

        invalidateCache('inventory');
        res.json({ message: 'Stok diperbarui', before, after });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/inventory/bulk — apply same operation (set/add/subtract) to multiple
// variants at once. All in one transaction, all-or-nothing. Logs one movement
// per changed cell. Cell list capped at 200 for safety.
app.post('/api/inventory/bulk', requireMenu('inventory','edit'), async (req, res) => {
    try {
        const { operation, value, cells, reason, note } = req.body;
        if (!['set', 'add', 'subtract'].includes(operation))
            return res.status(400).json({ error: 'Operation harus set/add/subtract' });
        const num = parseInt(value);
        if (isNaN(num) || num < 0) return res.status(400).json({ error: 'Nilai tidak valid' });
        if (!Array.isArray(cells) || cells.length === 0) return res.status(400).json({ error: 'Pilih minimal 1 cell' });
        if (cells.length > 200) return res.status(400).json({ error: 'Maksimal 200 cell sekaligus' });
        // Bulk WAJIB ada reason yg valid (sengaja strict — bulk = perubahan masif → audit penting)
        if (!STOCK_REASONS.includes(reason)) return res.status(400).json({ error: 'Alasan perubahan stok wajib dipilih' });

        const opLabel = operation === 'set' ? `→ ${num}` : operation === 'add' ? `+${num}` : `−${num}`;
        const noteFinal = `[${reason}] Bulk ${operation}: ${opLabel}${note ? ' · ' + note : ''}`;

        const results = await withTransaction(async (client) => {
            const out = [];
            for (const cell of cells) {
                const { product_id, size, color, variant_type } = cell;
                if (!product_id || !size || !color || !variant_type) continue;

                const curRes = await client.query(
                    'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                    [product_id, size, color, variant_type]
                );
                const cur = curRes.rows[0];
                const before = cur ? parseInt(cur.stock) : 0;
                let after;
                if (operation === 'set')      after = num;
                else if (operation === 'add') after = before + num;
                else                          after = Math.max(0, before - num);

                await client.query(
                    `INSERT INTO inventory (product_id, size, color, variant_type, stock) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT(product_id, size, color, variant_type) DO UPDATE SET stock = $6`,
                    [product_id, size, color, variant_type, after, after]
                );
                if (before !== after) {
                    await client.query(
                        `INSERT INTO stock_movements
                         (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, admin_user)
                         VALUES ($1,$2,$3,$4,'manual_set',$5,$6,$7,$8,$9)`,
                        [product_id, size, color, variant_type, after - before, before, after, noteFinal, req.user.username]
                    );
                }
                out.push({ product_id, size, color, variant_type, before, after, changed: before !== after });
            }
            return out;
        });

        invalidateCache('inventory');
        const changed = results.filter(r => r.changed).length;
        res.json({ message: `${changed} dari ${results.length} stok diperbarui`, results });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// NOTE: legacy `PUT /api/inventory` dihapus (22 Mei) — dead code, tidak dipakai
// dashboard, dan berbahaya: tanpa transaksi/FOR UPDATE, tanpa log stock_movements,
// tanpa validasi (stok negatif bisa masuk). Pakai /api/inventory/single atau /bulk.

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

// ── REPORTS ──────────────────────────────────────────────────────────────────
// Semua laporan: hanya order PAID & non-cancelled, basis tanggal = paid_at.
// gross = nilai barang (qty x harga, sudah termasuk bordir) SEBELUM diskon, TANPA
// ongkir = total_amount - shipping_cost + discount_amount. net = gross - discount
// - refunds. Refund dihitung by created_at (tanggal refund terjadi), non-cancelled.
function reportRange(req) {
    const { from, to } = req.query;
    const ok = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!ok(from) || !ok(to)) return null;
    return { from, to };
}

// GET /api/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/reports/sales', requireMenu('report','view'), async (req, res) => {
    try {
        const r = reportRange(req);
        if (!r) return res.status(400).json({ error: 'Parameter from & to wajib (format YYYY-MM-DD)' });
        const sales = await dbGet(
            `SELECT COALESCE(SUM(total_amount - shipping_cost + discount_amount),0)::bigint AS gross,
                    COALESCE(SUM(discount_amount),0)::bigint AS discount,
                    COUNT(*)::int AS orders
               FROM orders
              WHERE payment_status='paid' AND order_status<>'cancelled'
                AND paid_at >= $1::date AND paid_at < ($2::date + 1)`,
            [r.from, r.to]
        );
        const ref = await dbGet(
            `SELECT COALESCE(SUM(amount),0)::bigint AS refunds
               FROM refunds
              WHERE status<>'cancelled'
                AND created_at >= $1::date AND created_at < ($2::date + 1)`,
            [r.from, r.to]
        );
        const gross = Number(sales.gross), discount = Number(sales.discount), refunds = Number(ref.refunds);
        res.json({ from: r.from, to: r.to, gross, discount, refunds, net: gross - discount - refunds, orders: sales.orders });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/sales-type — breakdown per channel (website/whatsapp/event_offline/offline)
app.get('/api/reports/sales-type', requireMenu('report','view'), async (req, res) => {
    try {
        const r = reportRange(req);
        if (!r) return res.status(400).json({ error: 'Parameter from & to wajib (format YYYY-MM-DD)' });
        const rows = await dbAll(
            `SELECT order_source AS source,
                    COUNT(*)::int AS orders,
                    COALESCE(SUM(total_amount - shipping_cost + discount_amount),0)::bigint AS gross,
                    COALESCE(SUM(discount_amount),0)::bigint AS discount
               FROM orders
              WHERE payment_status='paid' AND order_status<>'cancelled'
                AND paid_at >= $1::date AND paid_at < ($2::date + 1)
              GROUP BY order_source`,
            [r.from, r.to]
        );
        // Refunds per channel (join ke order untuk dapat source), by refund date.
        const refRows = await dbAll(
            `SELECT o.order_source AS source, COALESCE(SUM(r.amount),0)::bigint AS refunds
               FROM refunds r JOIN orders o ON o.id = r.order_id
              WHERE r.status<>'cancelled'
                AND r.created_at >= $1::date AND r.created_at < ($2::date + 1)
              GROUP BY o.order_source`,
            [r.from, r.to]
        );
        const refMap = Object.fromEntries(refRows.map(x => [x.source, Number(x.refunds)]));
        const all = ['website', 'whatsapp', 'event_offline', 'offline', 'collaboration_event'];
        const byKey = Object.fromEntries(rows.map(x => [x.source, x]));
        const out = all.map(src => {
            const row = byKey[src] || { orders: 0, gross: 0, discount: 0 };
            const gross = Number(row.gross), discount = Number(row.discount), refunds = refMap[src] || 0;
            return { source: src, orders: row.orders || 0, gross, discount, refunds, net: gross - discount - refunds };
        });
        res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/items — barang terjual (exclude bonus/gift) dalam periode
app.get('/api/reports/items', requireMenu('report','view'), async (req, res) => {
    try {
        const r = reportRange(req);
        if (!r) return res.status(400).json({ error: 'Parameter from & to wajib (format YYYY-MM-DD)' });
        const rows = await dbAll(
            `SELECT p.name, p.sku, p.category,
                    SUM(oi.quantity)::int AS qty,
                    p.price::bigint AS unit_price,
                    COALESCE(SUM(oi.price * oi.quantity),0)::bigint AS total_sales
               FROM order_items oi
               JOIN orders o ON o.id = oi.order_id
               JOIN products p ON p.id = oi.product_id
              WHERE o.payment_status='paid' AND o.order_status<>'cancelled'
                AND oi.is_bonus = FALSE
                AND o.paid_at >= $1::date AND o.paid_at < ($2::date + 1)
              GROUP BY p.id, p.name, p.sku, p.category, p.price
              ORDER BY total_sales DESC`,
            [r.from, r.to]
        );
        res.json(rows);
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
// Tarif INTERIM berbasis ZONA (sebelum integrasi KiriminAja). Lihat cities.js:
//   Zona 1 Jabodetabek 10rb · 2 Banten/Jabar 12rb · 3 Jateng/DIY/Jatim/Bali 20rb
//   Zona 4 Sumatra/Kalimantan/NTB/NTT 28rb · 5 Sulawesi/Maluku/Papua 31rb (per kg)
//   >10kg di luar Zona 1: Lion Cargo, ongkir dikonfirmasi admin (cost=0, needs_confirmation=true)
app.get('/api/shipping-cost', (req, res) => {
    const { city, qty } = req.query;
    const quantity = parseInt(qty || 1);
    const weightKg = Math.ceil(quantity / 3);
    const cityInfo = CITIES.find(c => c.name === city);
    if (!cityInfo) return res.status(404).json({ error: 'Kota tidak ditemukan' });

    const zone = cityInfo.zone || 3;
    let courier, ratePerKg, cost, needsConfirmation = false;
    if (zone !== 1 && weightKg > 10) {
        courier = 'Lion Cargo (ongkir dikonfirmasi admin via WhatsApp)';
        ratePerKg = 0;
        cost = 0;
        needsConfirmation = true;
    } else {
        ratePerKg = rateForZone(zone);
        cost = weightKg * ratePerKg;
        courier = zone === 1 ? 'JNE / J&T Reguler' : 'J&T Reguler / Lion Parcel';
    }

    res.json({
        city: cityInfo.name,
        is_dki: cityInfo.is_dki,
        zone,
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
                    COALESCE(
                        -- Exact match on variant_type (e.g. lengan pendek vs panjang), prefer slot 1.
                        -- NULLIF maps the string 'null' (no-variant sentinel) to real NULL;
                        -- IS NOT DISTINCT FROM treats NULL=NULL as a match.
                        (SELECT pv.photo_url FROM product_variants pv
                         WHERE pv.product_id = oi.product_id AND pv.color = oi.color
                           AND pv.variant_type IS NOT DISTINCT FROM NULLIF(oi.variant_type, 'null')
                         ORDER BY pv.slot ASC NULLS LAST LIMIT 1),
                        -- Fallback: color-only (so photo is never null if a variant row exists)
                        (SELECT pv.photo_url FROM product_variants pv
                         WHERE pv.product_id = oi.product_id AND pv.color = oi.color
                         ORDER BY pv.slot ASC NULLS LAST LIMIT 1)
                    ) as photo
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
            discount_percent,// 0, 5, atau 30 — hanya untuk WA order
            billing_to       // nama partner yang ditagih (collaboration_event), admin-only
        } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ error: 'Keranjang kosong' });

        // SECURITY: distinguish admin (authenticated WA orders) from public website orders.
        // Computed up-front because it gates is_bonus (free items) and discount below —
        // a public caller must never be able to zero out prices.
        const authUser = getOptionalUser(req);
        // "Admin powers" (custom price, bonus, discount, non-website source) require the
        // manual-order EDIT permission (or a full admin). A logged-in staff without it is
        // treated as a public caller — cannot tamper prices or fake offline sales.
        const isAdmin = !!authUser && (authUser.role === 'admin' || hasMenu(authUser, 'manual-order', 'edit'));

        // Validate every line qty is a positive integer BEFORE any stock/price math.
        // Without this, a negative/zero/non-integer qty would pass the stock check
        // (available < negative === false), corrupt the total, and inflate stock at confirm.
        for (const item of items) {
            const q = Number(item.quantity);
            if (!Number.isInteger(q) || q < 1)
                return res.status(400).json({ error: 'Quantity setiap item harus bilangan bulat minimal 1' });
        }

        // Validate customer identity — client enforces required, tapi panggilan API
        // langsung bisa kirim kosong/sampah. HP harus nomor Indonesia yang masuk akal.
        const custNameTrim = (customer_name || '').trim();
        const custAddrTrim = (customer_address || '').trim();
        const custPhoneDigits = (customer_phone || '').replace(/\D/g, '');
        if (!custNameTrim) return res.status(400).json({ error: 'Nama pelanggan wajib diisi' });
        if (!custAddrTrim) return res.status(400).json({ error: 'Alamat pelanggan wajib diisi' });
        if (custPhoneDigits.length < 9 || custPhoneDigits.length > 15 || !/^(0|62|8)/.test(custPhoneDigits))
            return res.status(400).json({ error: 'Nomor WhatsApp tidak valid (gunakan format 08xxx / 62xxx)' });

        // Aggregate qty per physical variant before stock check — bordir splits share
        // the same inventory row, so checking per-item allows over-allocation when
        // the same shirt appears as multiple lines (plain + with name + with logo).
        const variantTotals = new Map();
        for (const item of items) {
            // Custom-size (off-catalog, no inventory row) and Pre-Order (qty > stock,
            // fulfilled later at receive) both skip the stock check. ADMIN-ONLY: a public
            // caller sending these flags must NOT bypass stock (same anti-tamper posture
            // as is_bonus), so the skip is gated behind isAdmin.
            if (isAdmin && (item.is_custom_size === true || item.is_po === true)) continue;
            const k = `${item.product_id}|${item.size}|${item.color}|${item.variant_type || 'null'}`;
            variantTotals.set(k, (variantTotals.get(k) || 0) + Number(item.quantity || 0));
        }
        for (const [k, totalQty] of variantTotals) {
            const [pid, size, color, vtype] = k.split('|');
            const product = await dbGet('SELECT * FROM products WHERE id = $1', [pid]);
            if (!product) return res.status(400).json({ error: `Produk ID ${pid} tidak ditemukan` });
            const inv = await dbGet(
                'SELECT stock FROM inventory WHERE product_id = $1 AND size = $2 AND color = $3 AND variant_type = $4',
                [pid, size, color, vtype]
            );
            const available = inv ? Number(inv.stock) : 0;
            if (available < totalQty) {
                return res.status(400).json({
                    error: `Stok ${product.name} (${color}, ${vtype}, ${size}) tidak cukup. Tersisa ${available}, diminta ${totalQty}`
                });
            }
        }

        let productTotal = 0;
        const itemDetails = [];
        for (const item of items) {
            const product = await dbGet('SELECT * FROM products WHERE id = $1', [item.product_id]);
            // Per-item price = base product price + per-item embroidery cost.
            // Bonus item (gift): entire line is free (product + bordir = Rp 0). Stock
            // is still deducted later — only the price is zeroed.
            // SECURITY: bonus is ADMIN-ONLY. A public caller sending is_bonus:true must
            // not get free products — gate it behind isAdmin.
            const isBonus = isAdmin && item.is_bonus === true;
            // Custom size (e.g. 4XL): off-catalog garment with an admin-set base price.
            // ADMIN-ONLY (anti-tamper). When custom, the base price comes from custom_price
            // instead of the catalog product.price; falls back to product.price if missing.
            const isCustomSize = isAdmin && item.is_custom_size === true;
            // Catalog base price: tops/gown bisa punya harga berbeda per variant
            // (mis. Lengan Pendek vs Panjang di price_by_type). product.price hanya
            // menyimpan harga TERMURAH (min), jadi resolve per variant_type dulu;
            // fallback ke product.price untuk produk harga-tunggal / variant tak dikenal.
            const priceByType = safeJSON(product.price_by_type, null);
            const catalogPrice = (priceByType && item.variant_type && priceByType[item.variant_type] != null)
                ? Number(priceByType[item.variant_type])
                : Number(product.price);
            const customBase = (isCustomSize && Number.isInteger(item.custom_price) && item.custom_price >= 0) ? item.custom_price : catalogPrice;
            // Pre-Order (qty > stock): whole line is deferred, stock allocated later at
            // receive (FIFO, paid-only). ADMIN-ONLY. Custom size takes precedence — a
            // custom (off-catalog) line is never a PO since it has no inventory to wait for.
            const isPO = isAdmin && item.is_po === true && !isCustomSize;
            // Bordir price: admin may override per-order (e.g. logo lebih susah → 40rb);
            // public callers ALWAYS use the fixed 20rb/30rb (gate behind isAdmin, anti-tamper).
            const namaPrice = (isAdmin && Number.isInteger(item.bordir_nama_price) && item.bordir_nama_price >= 0) ? item.bordir_nama_price : 20000;
            const logoPrice = (isAdmin && Number.isInteger(item.bordir_logo_price) && item.bordir_logo_price >= 0) ? item.bordir_logo_price : 30000;
            const itemEmbroidery = isBonus ? 0 : ((item.bordir_nama ? namaPrice : 0) + (item.bordir_logo ? logoPrice : 0));
            const basePrice = isBonus ? 0 : customBase;
            const unitPrice = basePrice + itemEmbroidery;
            itemDetails.push({ ...item, is_bonus: isBonus, is_custom_size: isCustomSize, is_po: isPO, price: unitPrice, product_name: product.name, base_price: basePrice, embroidery_cost: itemEmbroidery,
                bordir_nama_price: item.bordir_nama ? namaPrice : null, bordir_logo_price: item.bordir_logo ? logoPrice : null });
            productTotal += unitPrice * item.quantity;
        }

        // order_source: only admin may set a non-website channel. Public is always
        // 'website' — prevents a public caller from suppressing the admin "new order"
        // WA notification or faking an offline/event sale.
        const ADMIN_SOURCES = ['whatsapp', 'event_offline', 'offline', 'collaboration_event'];
        const safeOrderSource = isAdmin
            ? (order_source === 'website' ? 'website'
               : ADMIN_SOURCES.includes(order_source) ? order_source : 'whatsapp')
            : 'website';

        // payment_method: restrict to a known set (or empty) — block arbitrary injected text.
        // Public checkout kirim semantic value ('bank_transfer'/'qris'); admin form
        // dashboard pakai value lama (BCA/Mandiri/QRIS/Bonus-Free) — keduanya diterima.
        const ALLOWED_PAYMENT = ['Transfer BCA / Mandiri','BCA','BRI','Mandiri','BNI','QRIS','Cash','Bonus/Free','bank_transfer','qris'];
        const safePaymentMethod = ALLOWED_PAYMENT.includes(payment_method) ? payment_method : '';

        // billing_to: nama partner yang ditagih. Admin-only & hanya relevan untuk
        // collaboration_event; selain itu dipaksa null. Batasi panjang (anti-abuse).
        const safeBillingTo = (isAdmin && safeOrderSource === 'collaboration_event'
            && typeof billing_to === 'string' && billing_to.trim())
            ? billing_to.trim().slice(0, 120)
            : null;

        // shipping_cost: admin sets it manually (trusted). Public orders are RECOMPUTED
        // server-side from city + qty (same rule as /api/shipping-cost) so the client
        // can't tamper the amount (e.g. send 0).
        let shippingCost;
        if (isAdmin) {
            shippingCost = parseInt(shipping_cost || 0);
        } else {
            const ci = CITIES.find(c => c.name === shipping_city);
            const totalQty = items.reduce((s, i) => s + Number(i.quantity || 0), 0);
            const wKg = Math.ceil(totalQty / 3);
            if (!ci) shippingCost = 0;
            else if (ci.zone !== 1 && wKg > 10) shippingCost = 0;   // Lion Cargo — admin konfirmasi nanti
            else shippingCost = wKg * rateForZone(ci.zone || 3);
        }

        // Diskon (hanya product total, ongkir tidak kena diskon).
        // SECURITY: hanya admin/manager. Order publik dipaksa 0.
        const validDiscounts = [0, 5, 30];
        const requestedPct = isAdmin ? parseInt(discount_percent) : 0;
        const safeDiscountPct = validDiscounts.includes(requestedPct) ? requestedPct : 0;
        const discountAmount = Math.round(productTotal * safeDiscountPct / 100);
        const discountLabel = safeDiscountPct === 5 ? 'Diskon 5%' : safeDiscountPct === 30 ? 'Consignment 30%' : null;
        const total = productTotal - discountAmount + shippingCost;

        // Courier dipilih manual dari form, fallback ke logika kota jika tidak diisi
        const cityInfo = CITIES.find(c => c.name === shipping_city);
        const weightKg = parseFloat(shipping_weight_kg || 0);
        let autoCourier = 'JNE / J&T Reguler';
        if (cityInfo) {
            if (cityInfo.zone !== 1 && weightKg > 10) autoCourier = 'Lion Cargo (ongkir dikonfirmasi admin)';
            else autoCourier = cityInfo.zone === 1 ? 'JNE / J&T Reguler' : 'J&T Reguler / Lion Parcel';
        }
        const courier = (req_shipping_courier && req_shipping_courier.trim()) ? req_shipping_courier.trim() : autoCourier;

        // Detect bordir flags from items for order-level tracking
        const hasBordirLogo = itemDetails.some(i => i.bordir_logo);
        const hasBordirNama = itemDetails.some(i => i.bordir_nama);

        // Externalize base64 logos → Storage URLs (fallback to base64 if upload fails)
        // so the orders table doesn't store multi-MB images inline.
        const embDetailsStored = await externalizeEmbroideryLogos(embroidery_details);

        // Logo is "provided" when an actual image exists (URL or remaining base64),
        // as opposed to the "kirim via WA" placeholder text.
        const logoAlreadyProvided = hasBordirLogo && Array.isArray(embDetailsStored) &&
            embDetailsStored.some(e => e.type === 'logo' && typeof e.value === 'string' &&
                (e.value.startsWith('http') || e.value.startsWith('data:image/')));

        const orderCode = generateOrderCode(safeOrderSource);

        // Atomic: insert order + all items in one transaction. Either all rows land
        // or none — no orphan orders with missing items.
        const orderId = await withTransaction(async (client) => {
            const orderResult = await client.query(
                `INSERT INTO orders (order_code, customer_name, customer_phone, customer_address,
                  shipping_city, shipping_courier, shipping_weight_kg, shipping_cost, total_amount,
                  embroidery_details, has_bordir_logo, has_bordir_nama, bordir_status, notes, order_source,
                  payment_method, discount_percent, discount_amount, discount_label, bordir_logo_requested, billing_to)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
                [orderCode, customer_name, customer_phone, customer_address,
                 shipping_city || '', courier, weightKg, shippingCost, total,
                 embDetailsStored ? JSON.stringify(embDetailsStored) : null,
                 hasBordirLogo, hasBordirNama,
                 (hasBordirLogo || hasBordirNama) ? 'pending' : null,
                 notes || '',
                 safeOrderSource,
                 safePaymentMethod,
                 safeDiscountPct,
                 discountAmount,
                 discountLabel,
                 logoAlreadyProvided,
                 safeBillingTo]
            );
            const newOrderId = orderResult.rows[0].id;

            for (const item of itemDetails) {
                await client.query(
                    `INSERT INTO order_items (order_id, product_id, size, color, variant_type, quantity, price, bordir_nama, bordir_logo, is_bonus, bordir_nama_price, bordir_logo_price, is_custom_size, is_po)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                    [newOrderId, item.product_id, item.size, item.color,
                        item.variant_type || 'null', item.quantity, item.price,
                        item.bordir_nama || false, item.bordir_logo || false, item.is_bonus || false,
                        item.bordir_nama_price ?? null, item.bordir_logo_price ?? null, item.is_custom_size || false, item.is_po || false]
                );
            }
            return newOrderId;
        });

        // Rich WA notification for admin (sent AFTER commit — failure here doesn't
        // invalidate the order; just logs and the customer still gets success)
        const itemSummary = itemDetails.map(i => {
            let line = `• ${i.product_name} (${i.color}${i.variant_type && i.variant_type !== 'null' ? ', ' + i.variant_type : ''}, ${i.size}) x${i.quantity}`;
            if (i.is_custom_size) line += ` [Custom]`;
            if (i.is_po) line += ` [PRE-ORDER]`;
            if (i.bordir_nama) line += ` [Bordir Nama]`;
            if (i.bordir_logo) line += ` [Bordir Logo]`;
            if (i.is_bonus) line += ` [BONUS]`;
            line += ` = ${i.is_bonus ? 'GRATIS' : 'Rp ' + (i.price * i.quantity).toLocaleString('id-ID')}`;
            return line;
        }).join('\n');

        // Helper: keep WA messages light. base64 → label; Storage URL → show the link
        // (admin can open it); otherwise the placeholder text.
        const safeEmbVal = (e) => {
            if (e.type === 'logo') {
                const v = typeof e.value === 'string' ? e.value : '';
                if (v.startsWith('data:image/')) return '(Logo sudah diupload)';
                if (v.startsWith('http')) return v;
                return v || 'kirim via WA';
            }
            return e.value || '';
        };
        const embroiderySection = embDetailsStored && embDetailsStored.length > 0
            ? `\n\n🧵 *Detail Bordir:*\n` + embDetailsStored.map(e =>
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
        // Wrap in try/catch — Fonnte API failure must NOT fail the order response,
        // since the order is already committed at this point.
        if (safeOrderSource === 'website') {
            try { await sendWANotification(waMsg); }
            catch (waErr) { console.error('WA notify (new order) failed:', waErr?.message || waErr); }
        }

        // ⚠️ Immediate reminder if bordir logo ordered
        if (hasBordirLogo) {
            const logoItems = embDetailsStored
                ? embDetailsStored.filter(e => e.type === 'logo').map(e => `• ${e.item_label}: ${safeEmbVal(e)}`).join('\n')
                : '(lihat detail pesanan)';
            try { await sendWANotification(
                `🔔 *REMINDER: BORDIR LOGO - #${orderCode}*\n\n` +
                `Customer ${customer_name} memesan bordir logo!\n\n` +
                `🎨 Detail logo:\n${logoItems}\n\n` +
                `❗ Segera hubungi customer untuk meminta file logo bordir.\n` +
                `📱 WA Customer: ${customer_phone}`
            ); }
            catch (waErr) { console.error('WA notify (bordir reminder) failed:', waErr?.message || waErr); }
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
app.put('/api/orders/:id/confirm-payment', requireMenu('orders','edit'), upload.single('payment_proof'), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.payment_status === 'paid') return res.status(400).json({ error: 'Sudah dikonfirmasi' });

        // Order Bonus/Free tidak ada pembayaran nyata → bukti transfer opsional.
        const isFreeOrder = order.payment_method === 'Bonus/Free';
        if (!req.file && !isFreeOrder) return res.status(400).json({ error: 'Foto bukti pembayaran wajib diupload' });

        // Upload to Supabase BEFORE the transaction — external call, can be slow.
        // If TX later fails, the photo becomes orphan (harmless, tiny size).
        const photoUrl = req.file
            ? await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders')
            : null;

        const items = await dbAll('SELECT * FROM order_items WHERE order_id = $1', [order.id]);

        // Atomic: photo record + inventory deduct (with FOR UPDATE lock) + movement log
        // + order status update. Either all land or all roll back.
        const { nextStatus, sendBordirWA } = await withTransaction(async (client) => {
            // Lock the order row + recheck inside the TX. Two admins / double-clicks
            // could both pass the pre-TX check above; the row lock serializes them so
            // the second one sees 'paid' and aborts (no double stock deduction).
            const lockRes = await client.query('SELECT payment_status FROM orders WHERE id = $1 FOR UPDATE', [order.id]);
            if (!lockRes.rows[0]) { const e = new Error('Pesanan tidak ditemukan'); e.statusCode = 404; throw e; }
            if (lockRes.rows[0].payment_status === 'paid') {
                const e = new Error('Pembayaran sudah dikonfirmasi (oleh proses lain)'); e.statusCode = 409; throw e;
            }
            // Save photo proof (skip untuk order Bonus/Free tanpa bukti upload)
            if (photoUrl) {
                await client.query(
                    `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,$2,$3,$4,$5)`,
                    [order.id, 'payment', photoUrl, req.body.note || '', req.user.username]
                );
            }

            // Aggregate per physical variant first — bordir splits (plain + nama + logo)
            // share one inventory row, so summing avoids missing the true total demand.
            const variantTotals = new Map();
            for (const it of items) {
                // Custom-size lines have no inventory row → never deduct (and skip the
                // hard stock check below, which would otherwise throw a false 409).
                // Pre-Order lines are deferred: stock is allocated/deducted later at
                // receive (FIFO), not here — so skip them at confirm too.
                if (it.is_custom_size || it.is_po) continue;
                const k = `${it.product_id}|${it.size}|${it.color}|${it.variant_type}`;
                if (!variantTotals.has(k)) variantTotals.set(k, { product_id: it.product_id, size: it.size, color: it.color, variant_type: it.variant_type, quantity: 0 });
                variantTotals.get(k).quantity += it.quantity;
            }

            // Deduct inventory + log order_out. FOR UPDATE locks the row until COMMIT.
            // HARD check: reject confirmation if stock insufficient (prevents silent
            // overselling — stock isn't held at order creation, only deducted here).
            for (const v of variantTotals.values()) {
                const invRes = await client.query(
                    'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                    [v.product_id, v.size, v.color, v.variant_type]
                );
                const stockBefore = invRes.rows[0] ? parseInt(invRes.rows[0].stock) : 0;
                if (stockBefore < v.quantity) {
                    const e = new Error(`Stok tidak cukup untuk konfirmasi: ${v.color}/${v.variant_type}/${v.size} tersisa ${stockBefore}, dibutuhkan ${v.quantity}. Sesuaikan stok atau batalkan pesanan.`);
                    e.statusCode = 409;
                    throw e;
                }
                const stockAfter = stockBefore - v.quantity;
                await client.query(
                    `UPDATE inventory SET stock = stock - $1 WHERE product_id = $2 AND size = $3 AND color = $4 AND variant_type = $5`,
                    [v.quantity, v.product_id, v.size, v.color, v.variant_type]
                );
                await client.query(
                    `INSERT INTO stock_movements
                     (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                     VALUES ($1,$2,$3,$4,'order_out',$5,$6,$7,$8,$9,$10)`,
                    [v.product_id, v.size, v.color, v.variant_type,
                     -v.quantity, stockBefore, stockAfter,
                     `Order ${order.order_code}`, order.id, req.user.username]
                );
            }

            // Determine next status based on whether order has bordir
            const ns = order.has_bordir_logo || order.has_bordir_nama ? 'bordir' : 'confirmed';
            await client.query(
                `UPDATE orders SET payment_status = 'paid', order_status = $1, paid_at = NOW(), updated_at = NOW() WHERE id = $2`,
                [ns, order.id]
            );

            // Mark bordir_logo_requested if applicable (inside TX so it's consistent
            // with the status change)
            const shouldSendBordirWA = (order.has_bordir_logo || order.has_bordir_nama) && !order.bordir_logo_requested;
            if (shouldSendBordirWA) {
                await client.query(`UPDATE orders SET bordir_logo_requested = TRUE WHERE id = $1`, [order.id]);
            }
            return { nextStatus: ns, sendBordirWA: shouldSendBordirWA };
        });

        // WA notification AFTER commit — failure here doesn't roll back the payment
        // confirmation, which is already durably persisted.
        if (sendBordirWA) {
            try {
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
            } catch (waErr) { console.error('WA notify (payment confirmed) failed:', waErr?.message || waErr); }
        }

        res.json({ message: 'Pembayaran dikonfirmasi', next_status: nextStatus, photo_url: await signedMediaUrl(photoUrl) });
    } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// PUT /api/orders/:id/bordir-done  (multipart: bordir_proof photo)
app.put('/api/orders/:id/bordir-done', requireMenu('orders','edit'), upload.single('bordir_proof'), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.order_status !== 'bordir') return res.status(400).json({ error: 'Pesanan tidak dalam status bordir' });

        // Photo OPTIONAL (storage saving): admin confirms via checklist. The step record
        // (who + when + note) is still logged for audit — only the image is skipped.
        const photoUrl = req.file ? await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders') : null;

        // Atomic: photo record + status transition
        await withTransaction(async (client) => {
            await client.query(
                `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,$2,$3,$4,$5)`,
                [order.id, 'bordir', photoUrl, req.body.note || '', req.user.username]
            );
            await client.query(
                `UPDATE orders SET order_status = 'confirmed', updated_at = NOW() WHERE id = $1`,
                [order.id]
            );
        });

        // After commit — WA failure must not fail the response
        await safeWA(
            `🧵 *BORDIR SELESAI - #${order.order_code}*\n\n` +
            `Bordir untuk pesanan ${order.customer_name} sudah selesai.\n` +
            (photoUrl ? `📸 Foto bordir sudah diupload.\n` : '') +
            `➡️ Status: Siap dikemas`,
            'bordir-done'
        );

        res.json({ message: 'Bordir selesai, siap dikemas', photo_url: await signedMediaUrl(photoUrl) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/pack  (multipart: pack_proof photo)
app.put('/api/orders/:id/pack', requireMenu('orders','edit'), upload.single('pack_proof'), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.order_status !== 'confirmed') return res.status(400).json({ error: 'Pesanan belum berstatus confirmed/siap kemas' });

        // Pre-Order / Custom guard: an order stays at 'confirmed' until every made-to-order
        // line is ready (po_fulfilled). Catalog PO is fulfilled automatically at receive;
        // custom size is marked ready manually. Block packing/shipping while any line is
        // still waiting — otherwise we'd ship goods we don't have yet.
        const pendingPO = await dbGet(
            'SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1 AND (is_po = TRUE OR is_custom_size = TRUE) AND po_fulfilled = FALSE',
            [order.id]
        );
        if (pendingPO && pendingPO.n > 0)
            return res.status(409).json({ error: 'Ada item Pre-Order / Custom yang belum siap. Tidak bisa dikemas dulu. PO katalog dipenuhi otomatis saat terima stok; item custom tandai "Siap" dulu di detail pesanan.' });

        // Photo OPTIONAL (storage saving): admin confirms via checklist. Step record still logged.
        const photoUrl = req.file ? await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders') : null;

        await withTransaction(async (client) => {
            await client.query(
                `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,$2,$3,$4,$5)`,
                [order.id, 'pack', photoUrl, req.body.note || '', req.user.username]
            );
            await client.query(
                `UPDATE orders SET order_status = 'packed', updated_at = NOW() WHERE id = $1`,
                [order.id]
            );
        });

        await safeWA(
            `📦 *DIKEMAS - #${order.order_code}*\n\n` +
            `Pesanan ${order.customer_name} sudah dikemas.\n` +
            (photoUrl ? `📸 Foto kemasan sudah diupload.\n` : '') +
            `➡️ Siap dikirim via ${order.shipping_courier}`,
            'pack'
        );

        res.json({ message: 'Pesanan dikemas', photo_url: await signedMediaUrl(photoUrl) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/ship  (multipart: tracking_number wajib + ship_proof opsional)
// Status transition: packed → shipped. Records tracking number and (optionally)
// a delivery photo. Sends WA notification to the customer with the resi.
app.put('/api/orders/:id/ship', requireMenu('orders','edit'), upload.single('ship_proof'), async (req, res) => {
    try {
        const tracking = (req.body.tracking_number || '').trim();
        const courierOverride = (req.body.shipping_courier_final || '').trim();

        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.order_status !== 'packed') return res.status(400).json({ error: 'Pesanan belum siap dikirim (harus berstatus dikemas dulu)' });

        const finalCourier = courierOverride || order.shipping_courier || 'Kurir';
        // "Kirim sendiri" (antar langsung) tidak punya nomor resi kurir → resi opsional.
        const isSelfDelivery = finalCourier === 'Kirim sendiri';
        if (!tracking && !isSelfDelivery) return res.status(400).json({ error: 'Nomor resi wajib diisi' });

        // Upload before TX (slow external)
        const photoUrl = req.file
            ? await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders')
            : null;

        await withTransaction(async (client) => {
            if (photoUrl) {
                await client.query(
                    `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,$2,$3,$4,$5)`,
                    [order.id, 'ship', photoUrl, `Resi: ${tracking}${req.body.note ? ' · ' + req.body.note : ''}`, req.user.username]
                );
            }
            if (courierOverride) {
                await client.query(
                    `UPDATE orders SET order_status = 'shipped', tracking_number = $1, shipping_courier = $2, updated_at = NOW() WHERE id = $3`,
                    [tracking, courierOverride, order.id]
                );
            } else {
                await client.query(
                    `UPDATE orders SET order_status = 'shipped', tracking_number = $1, updated_at = NOW() WHERE id = $2`,
                    [tracking, order.id]
                );
            }
        });

        // Notify customer with tracking number via WA (uses Fonnte target override per-message)
        const customerPhoneDigits = (order.customer_phone || '').replace(/[^0-9]/g, '');
        const customerPhone = customerPhoneDigits.startsWith('62')
            ? customerPhoneDigits
            : customerPhoneDigits.startsWith('0')
                ? '62' + customerPhoneDigits.slice(1)
                : customerPhoneDigits;

        if (customerPhone) {
            const shipBody = isSelfDelivery
                ? `Pesanan Anda sedang dalam proses pengantaran langsung oleh tim Wearscrubs.\n` +
                  `Tim kami akan menghubungi Anda terkait waktu pengantaran.\n\n`
                : `Pesanan Anda sudah dikirim via *${finalCourier}*.\n\n` +
                  `📦 Nomor Resi: *${tracking}*\n\n` +
                  `Silakan lacak melalui website kurir atau aplikasi pengiriman dengan nomor resi di atas.\n\n`;
            await safeWA(
                `🚚 *PESANAN DIKIRIM - #${order.order_code}*\n\n` +
                `Halo ${order.customer_name},\n\n` +
                shipBody +
                `Terima kasih sudah berbelanja di Wearscrubs! 🙏`,
                'ship-customer',
                customerPhone   // send to customer, not admin
            );
        }

        // Notify admin team
        await safeWA(
            `🚚 *DIKIRIM - #${order.order_code}*\n\n` +
            `Pesanan ${order.customer_name} sudah dikirim.\n` +
            `📦 Resi: ${tracking || '(kirim sendiri)'}\n` +
            `📮 Kurir: ${finalCourier}`,
            'ship-admin'
        );

        res.json({ message: 'Pesanan dikirim, resi tercatat', tracking_number: tracking, shipping_courier: finalCourier, photo_url: await signedMediaUrl(photoUrl) });
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
        // Barang yang sudah dikirim tidak bisa dibatalkan: stok sudah keluar fisik ke
        // kurir/customer, restore +qty akan menciptakan stok hantu. Cancel hanya sampai 'packed'.
        if (order.order_status === 'shipped')
            return res.status(400).json({ error: 'Pesanan sudah dikirim — tidak bisa dibatalkan. Jika barang kembali (retur), tangani via stok manual / Tukar Size.' });

        const { cancel_reason } = req.body;
        // Optional context attachment (mis. screenshot percakapan dengan customer).
        // NOT a "refund proof" — refund flow is separate via the Refund module.
        // For paid orders, a refund record is auto-created with status='pending' so
        // admin follows up the actual money transfer through that flow.
        const cancelContextUrl = req.file
            ? await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders')
            : null;

        // Atomic: stock restore (if paid) + photo + cancel update — all-or-nothing
        await withTransaction(async (client) => {
            if (order.payment_status === 'paid') {
                const itemsRes = await client.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
                for (const item of itemsRes.rows) {
                    // Custom-size lines were never deducted at confirm → nothing to restore
                    // (and they have no inventory row; restoring would just log a bogus ledger entry).
                    if (item.is_custom_size) continue;
                    // Pre-Order lines: only fulfilled ones had stock deducted (at receive).
                    // An unfulfilled PO was never deducted → skip (restoring would inflate stock).
                    if (item.is_po && !item.po_fulfilled) continue;
                    const invRes = await client.query(
                        'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                        [item.product_id, item.size, item.color, item.variant_type]
                    );
                    const stockBefore = invRes.rows[0] ? parseInt(invRes.rows[0].stock) : 0;
                    await client.query(
                        `UPDATE inventory SET stock = stock + $1 WHERE product_id = $2 AND size = $3 AND color = $4 AND variant_type = $5`,
                        [item.quantity, item.product_id, item.size, item.color, item.variant_type]
                    );
                    const stockAfter = stockBefore + item.quantity;
                    await client.query(
                        `INSERT INTO stock_movements
                         (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                         VALUES ($1,$2,$3,$4,'order_cancel_restore',$5,$6,$7,$8,$9,$10)`,
                        [item.product_id, item.size, item.color, item.variant_type,
                         item.quantity, stockBefore, stockAfter,
                         `Pembatalan ${order.order_code}`, order.id, user.username]
                    );
                }
            }

            if (cancelContextUrl) {
                // Stored as 'refund' step for backward-compat with existing photo timeline UI.
                // Semantic-wise this is "cancellation context", not the actual transfer proof
                // (that one lives on refunds.proof_url after mark-transferred).
                await client.query(
                    `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,$2,$3,$4,$5)`,
                    [order.id, 'refund', cancelContextUrl, cancel_reason || '', req.user.username]
                );
            }

            await client.query(
                `UPDATE orders SET order_status = 'cancelled', cancel_reason = $1, cancelled_by = $2, updated_at = NOW() WHERE id = $3`,
                [cancel_reason || '', user.username, order.id]
            );

            // Auto-create refund entry if order was paid — only if not already exists
            // (defensive: re-cancellation shouldn't duplicate). Refund proof from cancel
            // is the initial proof; admin can mark transferred later with another proof.
            if (order.payment_status === 'paid') {
                const existing = await client.query(
                    'SELECT id FROM refunds WHERE order_id = $1 AND refund_type = $2',
                    [order.id, 'cancellation']
                );
                if (existing.rows.length === 0) {
                    // Build items summary string for at-a-glance reference
                    const itemsRes = await client.query(
                        `SELECT oi.quantity, oi.size, oi.color, oi.variant_type, p.name AS product_name
                         FROM order_items oi JOIN products p ON p.id = oi.product_id
                         WHERE oi.order_id = $1`,
                        [order.id]
                    );
                    const itemsSummary = itemsRes.rows
                        .map(i => `${i.product_name} (${i.color}${i.variant_type && i.variant_type !== 'null' ? ', ' + i.variant_type : ''}, ${i.size}) ×${i.quantity}`)
                        .join('; ');

                    // Refund record ALWAYS starts at 'pending'. Admin transfers via the
                    // Refund module → uploads transfer proof at mark-transferred → confirmed.
                    // The cancelContextUrl (if any) is just for the order photo timeline,
                    // NOT the refund's transfer proof.
                    await client.query(
                        `INSERT INTO refunds (order_id, refund_type, amount, reason, items_summary,
                                              customer_name, customer_phone, status, admin_user)
                         VALUES ($1, 'cancellation', $2, $3, $4, $5, $6, 'pending', $7)`,
                        [order.id, parseInt(order.total_amount) || 0, cancel_reason || '', itemsSummary,
                         order.customer_name, order.customer_phone, user.username]
                    );
                }
            }
        });

        await safeWA(
            `❌ *PESANAN DIBATALKAN - #${order.order_code}*\n\n` +
            `Pesanan ${order.customer_name} dibatalkan oleh admin ${user.username}.\n` +
            `📝 Alasan: ${cancel_reason || '-'}\n` +
            (order.payment_status === 'paid' ? `💰 Refund record pending — proses transfer via menu Refund.` : ''),
            'cancel'
        );

        res.json({
            message: order.payment_status === 'paid'
                ? 'Pesanan dibatalkan. Refund pending di menu Refund — segera follow-up transfer.'
                : 'Pesanan dibatalkan.',
            cancel_context_url: cancelContextUrl,
            refund_created: order.payment_status === 'paid'
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orders/:id/photos — get all proof photos for an order
app.get('/api/orders/:id/photos', requireAuth(), async (req, res) => {
    try {
        const photos = await dbAll(
            `SELECT * FROM order_photos WHERE order_id = $1 ORDER BY created_at ASC`,
            [req.params.id]
        );
        for (const p of photos) p.photo_url = await signedMediaUrl(p.photo_url);
        res.json(photos);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Allowed forward transitions. Admin must use dedicated endpoints for steps that
// require proof (confirm-payment, bordir-done, pack, ship, cancel). This generic
// endpoint is for `shipped → done` (delivery confirmation) and similar low-risk
// progressions. Backward transitions / step-skipping are rejected.
// Cancellation goes through the dedicated /cancel endpoint so stock restore +
// refund record creation are guaranteed. The generic /status endpoint is NOT
// allowed to transition orders into 'cancelled' — would silently bypass those.
// Generic /status endpoint is ONLY for shipped → done (the one transition without a
// dedicated proof endpoint). All other transitions MUST go through their endpoints
// which enforce proof/side-effects:
//   waiting_payment → confirmed/bordir : PUT /confirm-payment (payment proof + stock deduct)
//   bordir          → confirmed        : PUT /bordir-done    (bordir proof)
//   confirmed       → packed           : PUT /pack           (pack proof)
//   packed          → shipped          : PUT /ship           (tracking number)
//   any             → cancelled        : PUT /cancel         (stock restore + refund)
const STATUS_FORWARD = {
    waiting_payment: [],
    confirmed:       [],
    bordir:          [],
    packed:          [],
    shipped:         ['done'],
    done:            [],
    cancelled:       [],
};

app.put('/api/orders/:id/status', requireMenu('orders','edit'), async (req, res) => {
    try {
        const { order_status } = req.body;
        const valid = ['waiting_payment', 'confirmed', 'packed', 'shipped', 'done', 'cancelled', 'bordir'];
        if (!valid.includes(order_status)) return res.status(400).json({ error: 'Status tidak valid' });

        const order = await dbGet('SELECT order_status FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });

        const allowed = STATUS_FORWARD[order.order_status] || [];
        if (!allowed.includes(order_status)) {
            return res.status(400).json({
                error: `Transisi tidak diizinkan: ${order.order_status} → ${order_status}. Allowed: ${allowed.join(', ') || '(terminal state)'}`
            });
        }

        // Atomic: update status + (for 'done') log an audit record so the process timeline
        // can show WHO marked it done. photo_url is null (no image) — record is for audit only.
        await withTransaction(async (client) => {
            await client.query(
                `UPDATE orders SET order_status = $1, updated_at = NOW() WHERE id = $2`,
                [order_status, req.params.id]
            );
            if (order_status === 'done') {
                await client.query(
                    `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,'done',NULL,$2,$3)`,
                    [req.params.id, 'Pesanan ditandai selesai', req.user.username]
                );
            }
        });
        res.json({ message: `Status: ${order_status}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/bordir-review — admin approve / reject bordir
// Body: { action: 'approve' | 'reject', reason?: string,
//         reject_types?: ['nama'] | ['logo'] | ['nama','logo'] (default: both available types) }
// Per-type rejection lets admin reject only the logo while approving the name
// (or vice versa). Auto-creates refund records for each rejected type with the
// matching per-item embroidery cost.
app.put('/api/orders/:id/bordir-review', requireMenu('orders','edit'), upload.none(), async (req, res) => {
    try {
        const { action, reason, reject_types } = req.body;
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

        // Parse reject_types — accept array or comma-string; default to all available types
        let parsedTypes = reject_types;
        if (typeof parsedTypes === 'string') parsedTypes = parsedTypes.split(',').map(s => s.trim()).filter(Boolean);
        if (!Array.isArray(parsedTypes) || parsedTypes.length === 0) {
            parsedTypes = [];
            if (order.has_bordir_nama) parsedTypes.push('nama');
            if (order.has_bordir_logo) parsedTypes.push('logo');
        }
        parsedTypes = parsedTypes.filter(t => ['nama','logo'].includes(t));
        // Validate types actually exist on order
        if (parsedTypes.includes('nama') && !order.has_bordir_nama)
            return res.status(400).json({ error: 'Order ini tidak punya bordir nama' });
        if (parsedTypes.includes('logo') && !order.has_bordir_logo)
            return res.status(400).json({ error: 'Order ini tidak punya bordir logo' });
        if (parsedTypes.length === 0)
            return res.status(400).json({ error: 'Pilih tipe bordir yang ditolak (nama / logo)' });

        const rejectReason = (reason || '').trim() || 'Bordir terlalu rumit atau detail tidak sesuai untuk diproses';

        // Calculate refund amount per type by summing per-item embroidery cost
        // from order_items where the matching bordir flag is true.
        const items = await dbAll('SELECT quantity, bordir_nama, bordir_logo, bordir_nama_price, bordir_logo_price FROM order_items WHERE order_id = $1', [order.id]);
        // Refund the amount that was actually charged (admin may have overridden the
        // bordir price); fall back to legacy fixed prices for older orders (NULL).
        const refundsByType = {};
        if (parsedTypes.includes('nama')) {
            refundsByType.nama = items.reduce((sum, i) => sum + (i.bordir_nama ? (i.bordir_nama_price ?? 20000) * i.quantity : 0), 0);
        }
        if (parsedTypes.includes('logo')) {
            refundsByType.logo = items.reduce((sum, i) => sum + (i.bordir_logo ? (i.bordir_logo_price ?? 30000) * i.quantity : 0), 0);
        }

        // Determine new bordir_status: full reject if all types rejected, partial otherwise
        const allTypesAvailable = (order.has_bordir_nama ? 1 : 0) + (order.has_bordir_logo ? 1 : 0);
        const newStatus = parsedTypes.length === allTypesAvailable ? 'rejected' : 'partial_rejected';
        const reasonStored = parsedTypes.length === 1
            ? `[${parsedTypes[0].toUpperCase()} ditolak] ${rejectReason}`
            : `[BORDIR ditolak] ${rejectReason}`;

        // Atomic: update order + insert refund per rejected type (only if not already exists)
        const createdRefunds = await withTransaction(async (client) => {
            await client.query(
                `UPDATE orders SET bordir_status = $1, bordir_reject_reason = $2, updated_at = NOW() WHERE id = $3`,
                [newStatus, reasonStored, order.id]
            );
            const out = [];
            for (const t of parsedTypes) {
                const amount = refundsByType[t] || 0;
                if (amount <= 0) continue;
                const refundType = t === 'nama' ? 'bordir_nama' : 'bordir_logo';
                // Skip if duplicate (admin re-trigger)
                const exist = await client.query(
                    'SELECT id FROM refunds WHERE order_id = $1 AND refund_type = $2',
                    [order.id, refundType]
                );
                if (exist.rows.length > 0) continue;
                const itemsSummary = `Bordir ${t === 'nama' ? 'nama' : 'logo'} pada order ${order.order_code}`;
                await client.query(
                    `INSERT INTO refunds (order_id, refund_type, amount, reason, items_summary,
                                          customer_name, customer_phone, status, admin_user)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
                    [order.id, refundType, amount, rejectReason, itemsSummary,
                     order.customer_name, order.customer_phone, req.user.username]
                );
                out.push({ type: t, amount });
            }
            return out;
        });

        // Build WA template message for admin to send to customer
        const phoneDigits = (order.customer_phone || '').replace(/[^0-9]/g, '');
        const phone = phoneDigits.startsWith('62') ? phoneDigits
            : phoneDigits.startsWith('0') ? '62' + phoneDigits.slice(1)
            : phoneDigits.startsWith('8') ? '62' + phoneDigits : phoneDigits;
        const typeLabel = parsedTypes.length === 2 ? 'nama & logo'
            : parsedTypes[0] === 'nama' ? 'nama' : 'logo';

        // FULL refund amount for the rejected types (NOT just newly-created records).
        // If admin re-rejects, createdRefunds is empty but the customer still needs to
        // see the correct refund amount in the WA template — it equals what was already
        // recorded earlier. Compute from refundsByType which reflects the per-type cost
        // calculation regardless of duplicate-skip status.
        const fullRefundAmount = Object.values(refundsByType).reduce((s, n) => s + n, 0);
        const newCount = createdRefunds.length;
        const totalRequested = parsedTypes.filter(t => (refundsByType[t] || 0) > 0).length;
        const allAlreadyExisted = newCount === 0 && totalRequested > 0;

        const msg = encodeURIComponent(
            `Halo ${order.customer_name},\n\n` +
            `Mohon maaf, untuk pesanan *${order.order_code}*, bordir *${typeLabel}* yang Anda minta tidak dapat kami proses karena:\n` +
            `${rejectReason}\n\n` +
            `Silakan pilih salah satu opsi:\n` +
            `1. Revisi bordir (kirim ulang detail/file)\n` +
            `2. Lanjut tanpa bordir ${typeLabel} — kami refund biaya bordir sebesar *Rp ${fullRefundAmount.toLocaleString('id-ID')}*\n` +
            `3. Batal pesanan (full refund)\n\n` +
            `Mohon konfirmasi via balasan WA. Terima kasih.`
        );
        const waUrl = phone ? `https://wa.me/${phone}?text=${msg}` : null;

        // Admin-facing message clarifies whether new records were actually created
        // (vs duplicate skip) so admin doesn't think a Rp 0 refund was generated.
        const adminMessage = allAlreadyExisted
            ? `Bordir ${typeLabel} sudah pernah ditolak sebelumnya — tidak ada refund record baru (record yang ada tetap pending, Rp ${fullRefundAmount.toLocaleString('id-ID')}).`
            : newCount > 0 && newCount < totalRequested
                ? `Bordir ${typeLabel} ditolak. ${newCount} refund record baru dibuat (sisanya sudah ada sebelumnya). Total nilai refund: Rp ${fullRefundAmount.toLocaleString('id-ID')}.`
                : `Bordir ${typeLabel} ditolak. Refund Rp ${fullRefundAmount.toLocaleString('id-ID')} dibuat (status pending).`;

        res.json({
            message: adminMessage,
            wa_url: waUrl,
            reason: rejectReason,
            rejected_types: parsedTypes,
            refunds_created: createdRefunds
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/request-logo — mark logo requested + send WA to customer
app.put('/api/orders/:id/request-logo', requireMenu('orders','edit'), upload.none(), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (!order.has_bordir_logo) return res.status(400).json({ error: 'Pesanan ini tidak memiliki bordir logo' });

        await dbRun(`UPDATE orders SET bordir_logo_requested = TRUE, updated_at = NOW() WHERE id = $1`, [order.id]);

        // Parse embroidery details to get logo items
        let embDetails = [];
        try { embDetails = order.embroidery_details ? JSON.parse(order.embroidery_details) : []; } catch(e) {}
        const logoItems = embDetails.filter(e => e.type === 'logo');

        await safeWA(
            `🎨 *PERMINTAAN FILE LOGO BORDIR - #${order.order_code}*\n\n` +
            `Halo team! Mohon segera hubungi customer:\n` +
            `👤 ${order.customer_name}\n` +
            `📱 ${order.customer_phone}\n\n` +
            `Untuk meminta file logo bordir mereka.\n` +
            (logoItems.length ? `📋 Detail logo: ${logoItems.map(e => e.item_label + ': ' + e.value).join(', ')}\n\n` : '') +
            `⏰ Proses bordir estimasi 1 minggu setelah file logo diterima.`,
            'request-logo'
        );

        res.json({ message: 'Logo bordir sudah diminta ke customer', order_code: order.order_code });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── REFUNDS ────────────────────────────────────────────────────────────────
// Aggregated view of money to be returned to customers. Auto-populated when an
// order is cancelled after payment confirmation, or when bordir is rejected
// (next commit). Manual entries possible via POST.

app.get('/api/refunds', requireAuth(), async (req, res) => {
    try {
        const { status } = req.query;
        const where = status && ['pending','transferred','completed','cancelled'].includes(status)
            ? `WHERE r.status = '${status}'` : '';
        const rows = await dbAll(
            `SELECT r.*, o.order_code, o.payment_method
             FROM refunds r
             LEFT JOIN orders o ON o.id = r.order_id
             ${where}
             ORDER BY
                CASE r.status WHEN 'pending' THEN 1 WHEN 'transferred' THEN 2 WHEN 'completed' THEN 3 WHEN 'cancelled' THEN 4 END,
                r.created_at DESC`,
            []
        );
        for (const r of rows) r.proof_url = await signedMediaUrl(r.proof_url);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/refunds/:id', requireAuth(), async (req, res) => {
    try {
        const row = await dbGet(
            `SELECT r.*, o.order_code, o.payment_method, o.shipping_courier
             FROM refunds r LEFT JOIN orders o ON o.id = r.order_id
             WHERE r.id = $1`,
            [req.params.id]
        );
        if (!row) return res.status(404).json({ error: 'Refund tidak ditemukan' });
        row.proof_url = await signedMediaUrl(row.proof_url);
        res.json(row);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/refunds/:id — update fields. Permission depends on current status:
//   - pending    → any field editable (amount, bank, reason, note)
//   - transferred → only `note` (locked: amount/bank/reason since transfer proof
//                    & WA already sent to customer with those values)
//   - completed / cancelled → nothing editable
app.put('/api/refunds/:id', requireMenu('refund','edit'), async (req, res) => {
    try {
        const refund = await dbGet('SELECT status FROM refunds WHERE id = $1', [req.params.id]);
        if (!refund) return res.status(404).json({ error: 'Refund tidak ditemukan' });
        if (refund.status === 'completed') return res.status(400).json({ error: 'Refund sudah selesai, tidak bisa diubah' });
        if (refund.status === 'cancelled') return res.status(400).json({ error: 'Refund sudah dibatalkan, tidak bisa diubah' });

        const { customer_bank_name, customer_bank_account, customer_bank_holder, note, reason, amount } = req.body;

        // Lock financial/identity fields once transferred — those were already
        // communicated to the customer via WA at mark-transferred and can't drift.
        if (refund.status === 'transferred') {
            const lockedTouched =
                customer_bank_name !== undefined ||
                customer_bank_account !== undefined ||
                customer_bank_holder !== undefined ||
                reason !== undefined ||
                amount !== undefined;
            if (lockedTouched) {
                return res.status(400).json({
                    error: 'Refund sudah ditransfer — hanya catatan (note) yang boleh diedit. Untuk koreksi nominal/rekening, batalkan refund ini dan buat manual baru.'
                });
            }
        }

        const fields = [];
        const values = [];
        let idx = 1;
        const set = (k, v) => { if (v !== undefined) { fields.push(`${k} = $${idx++}`); values.push(v); } };
        set('customer_bank_name', customer_bank_name);
        set('customer_bank_account', customer_bank_account);
        set('customer_bank_holder', customer_bank_holder);
        set('note', note);
        set('reason', reason);
        if (amount !== undefined) {
            const n = parseInt(amount);
            if (isNaN(n) || n < 0) return res.status(400).json({ error: 'Nominal tidak valid' });
            fields.push(`amount = $${idx++}`); values.push(n);
        }
        if (fields.length === 0) return res.status(400).json({ error: 'Tidak ada perubahan' });
        values.push(req.params.id);
        await dbRun(`UPDATE refunds SET ${fields.join(', ')} WHERE id = $${idx}`, values);
        res.json({ message: 'Refund diperbarui' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/refunds/:id/mark-transferred (multipart: proof — wajib)
// Refund must be in 'pending' state. Re-upload to overwrite a wrong proof is
// blocked — admin must cancel the refund record and create a manual one
// (preserves audit trail of what was originally uploaded + when).
app.put('/api/refunds/:id/mark-transferred', requireMenu('refund','edit'), upload.single('proof'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Foto bukti transfer wajib diupload' });
        const refund = await dbGet('SELECT * FROM refunds WHERE id = $1', [req.params.id]);
        if (!refund) return res.status(404).json({ error: 'Refund tidak ditemukan' });
        if (refund.status === 'transferred') return res.status(400).json({ error: 'Refund sudah ditandai sudah transfer — tidak bisa diupload ulang. Batalkan refund ini lalu buat manual baru kalau ada koreksi.' });
        if (refund.status === 'completed') return res.status(400).json({ error: 'Refund sudah selesai' });
        if (refund.status === 'cancelled') return res.status(400).json({ error: 'Refund sudah dibatalkan' });

        const proofUrl = await uploadToSupabase(req.file.buffer, req.file.originalname, 'refunds');
        await dbRun(
            `UPDATE refunds SET status = 'transferred', proof_url = $1, transferred_at = NOW(), admin_user = $2 WHERE id = $3`,
            [proofUrl, req.user.username, refund.id]
        );

        // Notify customer
        const customerPhoneDigits = (refund.customer_phone || '').replace(/[^0-9]/g, '');
        const customerPhone = customerPhoneDigits.startsWith('62') ? customerPhoneDigits
            : customerPhoneDigits.startsWith('0')  ? '62' + customerPhoneDigits.slice(1)
            : customerPhoneDigits.startsWith('8')  ? '62' + customerPhoneDigits
            : customerPhoneDigits;

        if (customerPhone) {
            await safeWA(
                `💰 *REFUND DITRANSFER*\n\n` +
                `Halo ${refund.customer_name},\n\n` +
                `Refund sebesar *Rp ${(refund.amount || 0).toLocaleString('id-ID')}* sudah kami transfer ke rekening Anda.\n\n` +
                (refund.customer_bank_name ? `🏦 Bank: ${refund.customer_bank_name}\n` : '') +
                (refund.customer_bank_account ? `💳 No. Rek: ${refund.customer_bank_account}\n` : '') +
                `\nMohon cek dan konfirmasi sudah diterima ya 🙏\n\n` +
                `Terima kasih.`,
                'refund-transferred-customer',
                customerPhone
            );
        }

        res.json({ message: 'Refund ditandai sudah ditransfer', proof_url: await signedMediaUrl(proofUrl) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/refunds/:id/mark-completed — customer sudah confirm terima
app.put('/api/refunds/:id/mark-completed', requireMenu('refund','edit'), async (req, res) => {
    try {
        const refund = await dbGet('SELECT status FROM refunds WHERE id = $1', [req.params.id]);
        if (!refund) return res.status(404).json({ error: 'Refund tidak ditemukan' });
        if (refund.status !== 'transferred') {
            return res.status(400).json({ error: 'Refund harus berstatus "transferred" dulu sebelum bisa diselesaikan' });
        }
        await dbRun(
            `UPDATE refunds SET status = 'completed', completed_at = NOW() WHERE id = $1`,
            [req.params.id]
        );
        res.json({ message: 'Refund selesai' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/refunds/:id/cancel — admin batalkan refund record (mis. customer pilih revisi bukan refund)
app.put('/api/refunds/:id/cancel', requireAuth(['admin']), async (req, res) => {
    try {
        const refund = await dbGet('SELECT status FROM refunds WHERE id = $1', [req.params.id]);
        if (!refund) return res.status(404).json({ error: 'Refund tidak ditemukan' });
        if (refund.status === 'completed') return res.status(400).json({ error: 'Refund sudah selesai, tidak bisa dibatalkan' });
        if (refund.status === 'transferred') return res.status(400).json({ error: 'Refund sudah ditransfer, tidak bisa dibatalkan. Buat refund koreksi/manual adjustment jika ada kesalahan.' });
        if (refund.status === 'cancelled') return res.status(400).json({ error: 'Refund sudah dibatalkan' });
        const { reason } = req.body;
        await dbRun(
            `UPDATE refunds SET status = 'cancelled', note = COALESCE(NULLIF(note, ''), '') || E'\n[Cancelled] ' || $1 WHERE id = $2`,
            [reason || '(tanpa alasan)', req.params.id]
        );
        res.json({ message: 'Refund record dibatalkan' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/refunds — manual create (mis. partial item cancel jarang terjadi)
app.post('/api/refunds', requireAuth(['admin']), async (req, res) => {
    try {
        const { order_id, refund_type, amount, reason, items_summary, note } = req.body;
        if (!order_id || !refund_type || !amount)
            return res.status(400).json({ error: 'order_id, refund_type, amount wajib diisi' });
        if (!['cancellation','bordir_nama','bordir_logo','partial_item','manual'].includes(refund_type))
            return res.status(400).json({ error: 'refund_type tidak valid' });
        const n = parseInt(amount);
        if (isNaN(n) || n <= 0) return res.status(400).json({ error: 'Nominal tidak valid' });

        const order = await dbGet('SELECT customer_name, customer_phone FROM orders WHERE id = $1', [order_id]);
        if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });

        const result = await dbRun(
            `INSERT INTO refunds (order_id, refund_type, amount, reason, items_summary,
                                  customer_name, customer_phone, note, admin_user)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [order_id, refund_type, n, reason || '', items_summary || '',
             order.customer_name, order.customer_phone, note || '', req.user.username]
        );
        res.json({ message: 'Refund record dibuat', id: result.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/refunds/stats — header counters for sidebar badge
app.get('/api/refunds/stats', requireAuth(), async (req, res) => {
    try {
        const row = await dbGet(
            `SELECT
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'transferred')::int AS transferred,
                COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)::int AS pending_total,
                COALESCE(SUM(amount) FILTER (WHERE status = 'transferred'), 0)::int AS transferred_total
             FROM refunds`,
            []
        );
        res.json(row);
    } catch (err) { res.status(500).json({ error: err.message }); }
});



// ═══════════════════════════════════════════════════════════════════════════
// EXCHANGE (TUKAR SIZE) — barang TIDAK direfund, hanya tukar ukuran.
// State: pending → approved (reserve stok pengganti) → completed. Atau cancelled.
// Reason-driven return: size_mismatch → stok jual; defect → stock_reject.
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/exchanges — list (optional ?status=)
app.get('/api/exchanges', requireAuth(), async (req, res) => {
    try {
        const { status } = req.query;
        const where = status ? `WHERE e.status = $1` : '';
        const params = status ? [status] : [];
        const rows = await dbAll(
            `SELECT e.*, o.order_code, p.name AS product_name
             FROM exchanges e
             LEFT JOIN orders o ON o.id = e.order_id
             LEFT JOIN products p ON p.id = e.product_id
             ${where}
             ORDER BY e.created_at DESC`,
            params
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/exchanges/stats — sidebar badge counters
app.get('/api/exchanges/stats', requireAuth(), async (req, res) => {
    try {
        const row = await dbGet(
            `SELECT
                COUNT(*) FILTER (WHERE status = 'pending')::int  AS pending,
                COUNT(*) FILTER (WHERE status = 'approved')::int AS approved
             FROM exchanges`, []
        );
        res.json(row);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orders/:id/exchanges — list for one order
app.get('/api/orders/:id/exchanges', requireAuth(), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT * FROM exchanges WHERE order_id = $1 ORDER BY created_at DESC`,
            [req.params.id]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orders/:id/exchanges — create exchange request (status=pending, no stock move yet)
// Body: { order_item_id, to_size, quantity, reason ('size_mismatch'|'defect'), note?, shipping_fee? }
app.post('/api/orders/:id/exchanges', requireMenu('exchange','edit'), upload.none(), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.payment_status !== 'paid')
            return res.status(400).json({ error: 'Tukar size hanya untuk pesanan yang sudah dibayar' });
        // Tukar size hanya setelah barang diterima customer (status 'done').
        // Sebelum dikirim, admin cukup ubah size langsung di pesanan.
        if (order.order_status !== 'done')
            return res.status(400).json({ error: 'Tukar size hanya bisa setelah barang diterima customer. Sebelum dikirim, ubah size langsung di pesanan.' });

        const { order_item_id, to_size, reason = 'size_mismatch', note, shipping_fee } = req.body;
        const qty = parseInt(req.body.quantity, 10) || 1;
        if (!order_item_id || !to_size) return res.status(400).json({ error: 'order_item_id & to_size wajib diisi' });
        if (!['size_mismatch','defect'].includes(reason)) return res.status(400).json({ error: 'reason tidak valid' });
        if (qty < 1) return res.status(400).json({ error: 'Quantity minimal 1' });

        const item = await dbGet('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [order_item_id, order.id]);
        if (!item) return res.status(404).json({ error: 'Item tidak ditemukan di pesanan ini' });
        if (String(to_size).trim() === String(item.size).trim())
            return res.status(400).json({ error: 'Size pengganti harus berbeda dari size asli' });

        // Double-exchange guard: total qty exchanged (non-cancelled) + new qty ≤ purchased qty
        const agg = await dbGet(
            `SELECT COALESCE(SUM(quantity),0)::int AS used FROM exchanges
             WHERE order_item_id = $1 AND status != 'cancelled'`,
            [order_item_id]
        );
        if (agg.used + qty > item.quantity)
            return res.status(400).json({ error: `Melebihi qty pembelian. Sudah ditukar ${agg.used} dari ${item.quantity}, diminta ${qty}.` });

        const created = await dbGet(
            `INSERT INTO exchanges (order_id, order_item_id, product_id, color, variant_type,
                                    from_size, to_size, quantity, reason, note, shipping_fee,
                                    customer_name, customer_phone, admin_user)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [order.id, order_item_id, item.product_id, item.color, item.variant_type,
             item.size, to_size, qty, reason, note || '', parseInt(shipping_fee, 10) || 0,
             order.customer_name, order.customer_phone, req.user.username]
        );
        res.json({ message: 'Permintaan tukar size dibuat', exchange: created });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/exchanges/:id/approve — reserve replacement stock (to_size -1). status=approved.
app.put('/api/exchanges/:id/approve', requireMenu('exchange','edit'), async (req, res) => {
    try {
        const ex = await dbGet('SELECT * FROM exchanges WHERE id = $1', [req.params.id]);
        if (!ex) return res.status(404).json({ error: 'Exchange tidak ditemukan' });
        if (ex.status !== 'pending') return res.status(400).json({ error: `Hanya exchange 'pending' yang bisa di-approve (sekarang: ${ex.status})` });

        const result = await withTransaction(async (client) => {
            const invRes = await client.query(
                'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                [ex.product_id, ex.to_size, ex.color, ex.variant_type]
            );
            const stockBefore = invRes.rows[0] ? parseInt(invRes.rows[0].stock) : 0;
            if (stockBefore < ex.quantity) {
                const err = new Error(`Stok size ${ex.to_size} tidak cukup (tersedia ${stockBefore}, butuh ${ex.quantity})`);
                err.statusCode = 400;
                throw err;
            }
            const stockAfter = stockBefore - ex.quantity;
            await client.query(
                `UPDATE inventory SET stock = stock - $1 WHERE product_id=$2 AND size=$3 AND color=$4 AND variant_type=$5`,
                [ex.quantity, ex.product_id, ex.to_size, ex.color, ex.variant_type]
            );
            await client.query(
                `INSERT INTO stock_movements
                 (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                 VALUES ($1,$2,$3,$4,'exchange_replacement_out',$5,$6,$7,$8,$9,$10)`,
                [ex.product_id, ex.to_size, ex.color, ex.variant_type,
                 -ex.quantity, stockBefore, stockAfter,
                 `Reservasi tukar size #${ex.id}`, ex.order_id, req.user.username]
            );
            await client.query(
                `UPDATE exchanges SET status='approved', updated_at=NOW() WHERE id=$1`, [ex.id]
            );
            return await client.query('SELECT * FROM exchanges WHERE id=$1', [ex.id]);
        });
        res.json({ message: `Tukar size disetujui — stok ${ex.to_size} direservasi`, exchange: result.rows[0] });
    } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// PUT /api/exchanges/:id/receive-return — old item physically returned.
// size_mismatch → stok jual +qty; defect → stock_reject +qty.
app.put('/api/exchanges/:id/receive-return', requireMenu('exchange','edit'), async (req, res) => {
    try {
        const ex = await dbGet('SELECT * FROM exchanges WHERE id = $1', [req.params.id]);
        if (!ex) return res.status(404).json({ error: 'Exchange tidak ditemukan' });
        if (ex.status !== 'approved') return res.status(400).json({ error: `Barang retur hanya bisa diterima saat status 'approved' (sekarang: ${ex.status})` });
        if (ex.return_received) return res.status(400).json({ error: 'Barang retur sudah pernah diterima' });

        const isDefect = ex.reason === 'defect';
        const result = await withTransaction(async (client) => {
            const col = isDefect ? 'stock_reject' : 'stock';
            const invRes = await client.query(
                `SELECT ${col} AS val FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE`,
                [ex.product_id, ex.from_size, ex.color, ex.variant_type]
            );
            const before = invRes.rows[0] ? parseInt(invRes.rows[0].val || 0) : 0;
            const after = before + ex.quantity;
            // Upsert: row may not exist for this size/color combo
            await client.query(
                `INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT(product_id, size, color, variant_type)
                 DO UPDATE SET ${col} = inventory.${col} + $7`,
                [ex.product_id, ex.from_size, ex.color, ex.variant_type,
                 isDefect ? 0 : ex.quantity, isDefect ? ex.quantity : 0, ex.quantity]
            );
            await client.query(
                `INSERT INTO stock_movements
                 (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user, is_reject)
                 VALUES ($1,$2,$3,$4,'exchange_return_in',$5,$6,$7,$8,$9,$10,$11)`,
                [ex.product_id, ex.from_size, ex.color, ex.variant_type,
                 ex.quantity, before, after,
                 `Retur tukar size #${ex.id}${isDefect ? ' (DEFECT → reject)' : ''}`, ex.order_id, req.user.username, isDefect]
            );
            await client.query(
                `UPDATE exchanges SET return_received=TRUE, return_received_at=NOW(), updated_at=NOW() WHERE id=$1`, [ex.id]
            );
            return await client.query('SELECT * FROM exchanges WHERE id=$1', [ex.id]);
        });
        res.json({
            message: isDefect
                ? `Barang retur diterima → masuk stok reject (size ${ex.from_size})`
                : `Barang retur diterima → stok jual ${ex.from_size} +${ex.quantity}`,
            exchange: result.rows[0]
        });
    } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// PUT /api/exchanges/:id/complete — replacement shipped + cycle done. Requires return received.
app.put('/api/exchanges/:id/complete', requireMenu('exchange','edit'), async (req, res) => {
    try {
        const ex = await dbGet('SELECT * FROM exchanges WHERE id = $1', [req.params.id]);
        if (!ex) return res.status(404).json({ error: 'Exchange tidak ditemukan' });
        if (ex.status !== 'approved') return res.status(400).json({ error: `Hanya exchange 'approved' yang bisa diselesaikan (sekarang: ${ex.status})` });
        if (!ex.return_received) return res.status(400).json({ error: 'Barang retur belum diterima. Terima barang retur dulu sebelum menyelesaikan.' });

        const updated = await dbGet(
            `UPDATE exchanges SET status='completed', replacement_shipped_at=NOW(), completed_at=NOW(), updated_at=NOW()
             WHERE id=$1 RETURNING *`, [ex.id]
        );
        await safeWA(
            `🔄 *TUKAR SIZE SELESAI*\n\nPesanan ${ex.customer_name || '-'} — size ${ex.from_size} → ${ex.to_size} (×${ex.quantity}). Barang pengganti sudah dikirim.`,
            'exchange-complete'
        );
        res.json({ message: 'Tukar size selesai', exchange: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/exchanges/:id/cancel — cancel pending/approved. Reverses any stock effects.
app.put('/api/exchanges/:id/cancel', requireAuth(['admin']), upload.none(), async (req, res) => {
    try {
        const ex = await dbGet('SELECT * FROM exchanges WHERE id = $1', [req.params.id]);
        if (!ex) return res.status(404).json({ error: 'Exchange tidak ditemukan' });
        if (ex.status === 'completed') return res.status(400).json({ error: 'Tukar size sudah selesai, tidak bisa dibatalkan' });
        if (ex.status === 'cancelled') return res.status(400).json({ error: 'Tukar size sudah dibatalkan' });
        const { reason } = req.body;

        await withTransaction(async (client) => {
            if (ex.status === 'approved') {
                // Reverse replacement reservation: to_size stock += qty
                const r1 = await client.query(
                    'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                    [ex.product_id, ex.to_size, ex.color, ex.variant_type]
                );
                const b1 = r1.rows[0] ? parseInt(r1.rows[0].stock) : 0;
                await client.query(
                    `UPDATE inventory SET stock = stock + $1 WHERE product_id=$2 AND size=$3 AND color=$4 AND variant_type=$5`,
                    [ex.quantity, ex.product_id, ex.to_size, ex.color, ex.variant_type]
                );
                await client.query(
                    `INSERT INTO stock_movements
                     (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                     VALUES ($1,$2,$3,$4,'exchange_replacement_out',$5,$6,$7,$8,$9,$10)`,
                    [ex.product_id, ex.to_size, ex.color, ex.variant_type,
                     ex.quantity, b1, b1 + ex.quantity,
                     `[BATAL] reservasi tukar size #${ex.id} dikembalikan`, ex.order_id, req.user.username]
                );

                // If return was already received, reverse that too
                if (ex.return_received) {
                    const isDefect = ex.reason === 'defect';
                    const col = isDefect ? 'stock_reject' : 'stock';
                    const r2 = await client.query(
                        `SELECT ${col} AS val FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE`,
                        [ex.product_id, ex.from_size, ex.color, ex.variant_type]
                    );
                    const b2 = r2.rows[0] ? parseInt(r2.rows[0].val || 0) : 0;
                    await client.query(
                        `UPDATE inventory SET ${col} = ${col} - $1 WHERE product_id=$2 AND size=$3 AND color=$4 AND variant_type=$5`,
                        [ex.quantity, ex.product_id, ex.from_size, ex.color, ex.variant_type]
                    );
                    await client.query(
                        `INSERT INTO stock_movements
                         (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user, is_reject)
                         VALUES ($1,$2,$3,$4,'exchange_return_in',$5,$6,$7,$8,$9,$10,$11)`,
                        [ex.product_id, ex.from_size, ex.color, ex.variant_type,
                         -ex.quantity, b2, b2 - ex.quantity,
                         `[BATAL] retur tukar size #${ex.id} ditarik kembali`, ex.order_id, req.user.username, isDefect]
                    );
                }
            }
            await client.query(
                `UPDATE exchanges SET status='cancelled',
                                      note = COALESCE(NULLIF(note,''),'') || E'\n[Cancelled] ' || $1,
                                      updated_at=NOW() WHERE id=$2`,
                [reason || '(tanpa alasan)', ex.id]
            );
        });
        res.json({ message: 'Tukar size dibatalkan' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/items/:itemId/size — edit item size BEFORE shipment.
// Body: { to_size }. Stock-aware: if order already paid, stock was deducted at
// confirm-payment, so we restore old size (+qty) and deduct new size (-qty).
// If still pending, no stock movement (deduction happens later at confirm-payment).
app.put('/api/orders/:id/items/:itemId/size', requireMenu('orders','edit'), upload.none(), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (['shipped','done','cancelled'].includes(order.order_status))
            return res.status(400).json({ error: 'Barang sudah dikirim/selesai — gunakan fitur Tukar Size, bukan edit langsung' });

        const item = await dbGet('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [req.params.itemId, order.id]);
        if (!item) return res.status(404).json({ error: 'Item tidak ditemukan di pesanan ini' });
        // Custom-size items are off-catalog (no inventory row). Editing their size would
        // create a phantom inventory row via the ON CONFLICT restore below — block it.
        if (item.is_custom_size)
            return res.status(400).json({ error: 'Item custom size tidak punya stok di katalog — size tidak bisa diubah lewat edit. Batalkan & buat ulang bila perlu.' });
        // Unfulfilled PO has no stock deducted yet → restoring the old size below would
        // create phantom stock. Block until the PO is fulfilled (then it behaves normally).
        if (item.is_po && !item.po_fulfilled)
            return res.status(400).json({ error: 'Item Pre-Order belum dipenuhi (menunggu stok) — size tidak bisa diubah dulu. Batalkan & buat ulang bila perlu.' });

        const toSize = String(req.body.to_size || '').trim();
        if (!toSize) return res.status(400).json({ error: 'Size baru wajib diisi' });
        if (toSize === String(item.size).trim()) return res.status(400).json({ error: 'Size baru sama dengan size sekarang' });

        const isPaid = order.payment_status === 'paid';
        await withTransaction(async (client) => {
            if (isPaid) {
                // Deduct new size first (with availability check), then restore old size.
                const newRes = await client.query(
                    'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                    [item.product_id, toSize, item.color, item.variant_type]
                );
                const newBefore = newRes.rows[0] ? parseInt(newRes.rows[0].stock) : 0;
                if (newBefore < item.quantity) {
                    const e = new Error(`Stok size ${toSize} tidak cukup (tersedia ${newBefore}, butuh ${item.quantity})`);
                    e.statusCode = 400; throw e;
                }
                await client.query(
                    `UPDATE inventory SET stock = stock - $1 WHERE product_id=$2 AND size=$3 AND color=$4 AND variant_type=$5`,
                    [item.quantity, item.product_id, toSize, item.color, item.variant_type]
                );
                await client.query(
                    `INSERT INTO stock_movements
                     (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                     VALUES ($1,$2,$3,$4,'order_edit_adjust',$5,$6,$7,$8,$9,$10)`,
                    [item.product_id, toSize, item.color, item.variant_type,
                     -item.quantity, newBefore, newBefore - item.quantity,
                     `Edit size ${item.size}→${toSize} (${order.order_code})`, order.id, req.user.username]
                );

                // Restore old size
                const oldRes = await client.query(
                    'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                    [item.product_id, item.size, item.color, item.variant_type]
                );
                const oldBefore = oldRes.rows[0] ? parseInt(oldRes.rows[0].stock) : 0;
                await client.query(
                    `INSERT INTO inventory (product_id, size, color, variant_type, stock, stock_reject)
                     VALUES ($1,$2,$3,$4,$5,0)
                     ON CONFLICT(product_id, size, color, variant_type) DO UPDATE SET stock = inventory.stock + $5`,
                    [item.product_id, item.size, item.color, item.variant_type, item.quantity]
                );
                await client.query(
                    `INSERT INTO stock_movements
                     (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                     VALUES ($1,$2,$3,$4,'order_edit_adjust',$5,$6,$7,$8,$9,$10)`,
                    [item.product_id, item.size, item.color, item.variant_type,
                     item.quantity, oldBefore, oldBefore + item.quantity,
                     `Edit size ${item.size}→${toSize} — dikembalikan (${order.order_code})`, order.id, req.user.username]
                );
            }
            await client.query(
                `UPDATE order_items SET size = $1 WHERE id = $2`, [toSize, item.id]
            );
            await client.query(`UPDATE orders SET updated_at = NOW() WHERE id = $1`, [order.id]);
        });
        res.json({ message: `Size diubah ${item.size} → ${toSize}${isPaid ? ' (stok disesuaikan)' : ''}` });
    } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// PUT /api/orders/:id/items/:itemId/fulfill-po — mark a made-to-order line "ready".
// Used for CUSTOM size only: it's off-catalog (no inventory, no "receive" event), so the
// admin marks it ready manually once the garment is sewn. Catalog PO is NOT handled here —
// it's fulfilled automatically (FIFO) at stock receive; allowing a manual flip would skip
// the stock deduction and desync inventory. No stock mutation here (custom has none).
app.put('/api/orders/:id/items/:itemId/fulfill-po', requireMenu('orders','edit'), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (['shipped','done','cancelled'].includes(order.order_status))
            return res.status(400).json({ error: 'Pesanan sudah dikirim/selesai/batal — tidak bisa diubah' });

        const item = await dbGet('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [req.params.itemId, order.id]);
        if (!item) return res.status(404).json({ error: 'Item tidak ditemukan di pesanan ini' });
        if (!item.is_custom_size)
            return res.status(400).json({ error: 'Hanya item Custom yang ditandai siap manual. PO katalog dipenuhi otomatis saat terima stok.' });
        if (item.po_fulfilled)
            return res.status(400).json({ error: 'Item ini sudah ditandai siap' });

        await dbRun('UPDATE order_items SET po_fulfilled = TRUE WHERE id = $1', [item.id]);
        await dbRun('UPDATE orders SET updated_at = NOW() WHERE id = $1', [order.id]);
        res.json({ message: 'Item custom ditandai siap — pesanan sekarang bisa dikemas' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 Wearscrubs Backend berjalan di http://localhost:${PORT}`);
    console.log(`   API: http://localhost:${PORT}/api/products`);
    console.log(`   WA Token: ${process.env.FONNTE_TOKEN ? 'Terkonfigurasi ✅' : 'Belum ⚠️'}\n`);
});
