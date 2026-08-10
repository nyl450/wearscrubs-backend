const path = require('path');
const dns = require('dns');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
// Sharp utk konversi audit photos (bukti bayar/pack/bordir/refund/cancel) ke WebP.
// Lazy + graceful: kalau sharp gagal load (mis. native binding tidak available di
// platform tertentu), server tetap jalan — audit photo cuma diupload apa adanya.
let sharp = null;
try { sharp = require('sharp'); }
catch (e) { console.warn('[Boot] sharp tidak tersedia — audit photos akan diupload tanpa kompresi:', e?.message || e); }
const fs = require('fs');
const fetch = require('node-fetch');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { CITIES, rateForZone, rateForCity } = require('./cities');

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
            // Token customer BUKAN staff — tolak dari semua endpoint admin (secret JWT sama).
            if (user && user.kind === 'customer') return res.status(403).json({ error: 'Akses ditolak.' });
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
// `customers` (Data Client) sengaja TIDAK ada di EDITABLE_MENUS — read-only.
const MENU_KEYS = ['overview','products','inventory','popular','orders','manual-order','temp-order','preorder','refund','exchange','customers','report'];
const EDITABLE_MENUS = ['products','inventory','popular','orders','manual-order','temp-order','refund','exchange'];

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
            // Token customer BUKAN staff — tolak (permMap default kasih view-all, bahaya).
            if (user && user.kind === 'customer') return res.status(403).json({ error: 'Akses ditolak.' });
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
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        // Token customer (kind='customer') BUKAN sesi staff — jangan pernah
        // ditafsirkan sebagai admin/staff (anti privilege confusion).
        if (payload && payload.kind === 'customer') return null;
        return payload;
    } catch { return null; }
}
// Baca token customer (opsional) — dipakai saat checkout utk tautkan customer_id.
function getOptionalCustomer(req) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return null;
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        return payload && payload.kind === 'customer' ? payload : null;
    } catch { return null; }
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
 * @param {string} folder - subfolder di bucket ('products' | 'orders' | 'refunds' | 'logos')
 * @param {object} [opts]
 * @param {boolean} [opts.optimize=false] - kalau true & sharp tersedia, resize max 1920px +
 *   konversi ke WebP q=85 (untuk audit photos: bukti bayar/pack/bordir/refund/cancel).
 *   Hemat storage 85-92% sambil tetap visually-lossless. Fail-safe: kalau sharp error,
 *   fallback ke original buffer (jangan blok upload karena masalah kompresi).
 * @returns {Promise<string>} URL publik foto
 */
async function uploadToSupabase(buffer, originalname, folder = 'products', opts = {}) {
    const { optimize = false } = opts;
    let ext = path.extname(originalname).toLowerCase();
    let finalBuffer = buffer;

    if (optimize && sharp) {
        try {
            const optimized = await sharp(buffer)
                .rotate()                                          // auto-orient via EXIF dulu sebelum strip
                .resize(1920, null, { withoutEnlargement: true, fit: 'inside' })
                .webp({ quality: 85 })
                .toBuffer();
            finalBuffer = optimized;
            ext = '.webp';
            const savedPct = Math.round((1 - optimized.length / buffer.length) * 100);
            console.log(`[Upload Optimize] ${folder}/${originalname}: ${(buffer.length/1024).toFixed(0)}KB → ${(optimized.length/1024).toFixed(0)}KB (-${savedPct}%)`);
        } catch (e) {
            console.warn(`[Upload Optimize] Gagal compress ${folder}/${originalname}, upload original: ${e?.message || e}`);
            // finalBuffer + ext tetap original
        }
    }

    const filename = `${folder}/ws_${Date.now()}_${Math.round(Math.random() * 9999)}${ext}`;
    const isPrivate = PRIVATE_FOLDERS.includes(folder);
    const bucket = isPrivate ? SUPABASE_PRIVATE_BUCKET : SUPABASE_BUCKET;

    if (supabaseClient) {
        // Upload ke Supabase Storage
        const { error } = await supabaseClient
            .storage
            .from(bucket)
            .upload(filename, finalBuffer, {
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
        fs.writeFileSync(localPath, finalBuffer);
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

    // ── Customers (akun website) — #3 login customer, 3 Agu 2026 ───────────────
    // Terpisah dari `users` (staff/admin). Identitas login = phone (WA) + password.
    // phone disimpan ternormalisasi (08xxxx) = kunci unik + penaut ke order lama.
    await dbRun(`CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS customer_addresses (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        label TEXT DEFAULT NULL,
        recipient_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        address TEXT NOT NULL,
        city TEXT NOT NULL,
        is_default BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_cust_addr_customer ON customer_addresses(customer_id)`);
    // Tautan order → customer. NULLABLE: order tamu/WA/Kasir lama tetap valid.
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER DEFAULT NULL`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)`);

    // ── Products table ────────────────────────────────────────────────────────
    await dbRun(`CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        sku TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('tops','pants','caps','gown','aksesoris')),
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
    // Custom Product (8 Jun): fully off-catalog item (name + category + variant + color
    // + size + price all admin-supplied). product_id is NULL — name/category live on
    // the order_items row itself. Stock is never touched; pack-guard treats it like
    // custom_size (manual "Tandai Siap" fulfill). Bordir gating uses custom_product_category.
    await dbRun(`ALTER TABLE order_items ALTER COLUMN product_id DROP NOT NULL`).catch(() => {});
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_custom_product BOOLEAN DEFAULT FALSE`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS custom_product_name TEXT DEFAULT NULL`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS custom_product_category TEXT DEFAULT NULL`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT DEFAULT NULL`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT DEFAULT NULL`);
    // Migrate: order channel & payment method
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_source TEXT DEFAULT 'website' CHECK(order_source IN ('website', 'whatsapp'))`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT ''`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_percent INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_label TEXT DEFAULT NULL`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dp_amount INTEGER DEFAULT 0`);
    // Pelunasan DP: NULL = masih ada sisa (belum lunas). Order DP tetap jalan produksi +
    // boleh dikemas, tapi TIDAK boleh dikirim sampai kolom ini terisi (lihat /settle-dp
    // + gate di /ship). Ongkir final bisa disesuaikan saat pelunasan (real ongkir sering beda).
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dp_settled_at TIMESTAMPTZ DEFAULT NULL`);

    // ── COGS / HPP (Cost of Goods Sold) ───────────────────────────────────────
    // Granularitas: per produk + per variant (cogs_by_type cermin price_by_type).
    // cost_config (JSON) RESERVED utk kalkulator komponen (Langkah 2). Snapshot di
    // order_items supaya report margin historis tidak berubah saat harga vendor naik.
    await dbRun(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cogs_default INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cogs_by_type TEXT DEFAULT NULL`);
    // Override COGS per warna (mis. charcoal/light grey beda kain). JSON {color:{variant:cost}}.
    // Warna yang tidak ada di sini → pakai cogs_by_type/cogs_default.
    await dbRun(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cogs_by_color TEXT DEFAULT NULL`);
    await dbRun(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_config TEXT DEFAULT NULL`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_cogs INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS bordir_nama_cogs INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS bordir_logo_cogs INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS packaging_cogs INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS total_cogs INTEGER DEFAULT 0`);
    // Key-value settings global (cost bordir nama/logo, dll). Admin-only via endpoint.
    await dbRun(`CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT DEFAULT '',
        updated_at TIMESTAMP DEFAULT NOW()
    )`);

    // ── Migrate: add gown to category constraint ──────────────────────────────
    // Drop + recreate (cara PostgreSQL). Riwayat: + 'gown', lalu + 'aksesoris'.
    // CATATAN: 'set' TIDAK ada di sini — Set hanya kategori custom product di
    // Kasir, bukan produk katalog (keputusan James).
    await dbRun(`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_check`).catch(() => {});
    await dbRun(`ALTER TABLE products ADD CONSTRAINT products_category_check CHECK(category IN ('tops','pants','caps','gown','aksesoris'))`).catch(() => {});

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
    // additional_amount_due = nilai bordir TAMBAHAN yg di-add setelah order paid
    // (customer berubah pikiran post-payment, minta tambah bordir). additional_paid_at
    // di-set saat admin konfirmasi customer sudah bayar selisih (bukti upload). Selama
    // additional_amount_due > 0 AND additional_paid_at IS NULL → outstanding (tampil
    // banner di detail + tombol konfirmasi). total_amount kolom utama di-update ikut
    // jadi nilai final supaya laporan/invoice konsisten.
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS additional_amount_due INTEGER DEFAULT 0`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS additional_paid_at TIMESTAMP DEFAULT NULL`);

    // ── Migrate: invoice_date override ────────────────────────────────────────
    // Admin Kasir kadang perlu set tanggal khusus di invoice (customer request,
    // mis. backdated invoice utk event yg lalu). Kalau NULL, invoice fallback ke
    // created_at — perilaku lama tidak berubah utk order existing.
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_date TIMESTAMPTZ DEFAULT NULL`);

    // ── Migrate: invoice_notes (catatan customer-facing di PDF invoice) ───────
    // Terpisah dari `notes` (internal — dipakai audit trail spt "Tambah bordir
    // post-payment"). invoice_notes muncul di PDF invoice di atas Payment
    // Information; kalau NULL/empty tidak render section (invoice bersih).
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_notes TEXT DEFAULT NULL`);

    // ── Migrate: Temporary Order (loan/trial) feature ─────────────────────────
    // Customer pinjam barang sementara — bisa Size Trial (coba muat), Endorsement
    // (foto/video), atau Other (sponsorship/sample reseller). Stock potong saat kirim
    // via movement_type='test_out'; balik via 'test_return'. Status alur:
    //   test_sent → test_pending_pay → test_pending_return → done/cancelled
    // is_test_returned di order_items mark item yg balik (vs kept).
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS test_sent_at TIMESTAMPTZ DEFAULT NULL`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS test_decision_at TIMESTAMPTZ DEFAULT NULL`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS test_returned_at TIMESTAMPTZ DEFAULT NULL`);
    await dbRun(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS trial_type TEXT DEFAULT NULL`);
    await dbRun(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_test_returned BOOLEAN DEFAULT FALSE`);

    // Order status: add test_sent / test_pending_pay / test_pending_return
    await dbRun(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_status_check`).catch(() => {});
    await dbRun(`ALTER TABLE orders ADD CONSTRAINT orders_order_status_check CHECK(order_status IN ('waiting_payment','confirmed','bordir','packed','shipped','done','cancelled','test_sent','test_pending_pay','test_pending_return'))`).catch(() => {});

    // Order source: add test_size
    await dbRun(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_source_check`).catch(() => {});
    await dbRun(`ALTER TABLE orders ADD CONSTRAINT orders_order_source_check CHECK(order_source IN ('website','whatsapp','event_offline','offline','collaboration_event','test_size'))`).catch(() => {});

    // Stock movement: add test_out / test_return
    await dbRun(`ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check`);
    await dbRun(`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
        CHECK(movement_type IN ('receive','manual_set','order_out','order_cancel_restore','receive_reject','reject_to_normal','exchange_replacement_out','exchange_return_in','order_edit_adjust','test_out','test_return'))`);

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
    // movement_type CHECK constraint diatur DI ATAS (lihat block "Stock movement:
    // add test_out / test_return"). Dulu di sini ada ALTER versi 9-values yang
    // MENIMPA versi 11-values di atas → setiap Railway boot ulang, constraint
    // hilangkan test_out/test_return → POST /api/temp-orders pecah di production.

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
                `SELECT oi.quantity, oi.size, oi.color, oi.variant_type, COALESCE(oi.custom_product_name, p.name) AS product_name
                 FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
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

// Kurir = label pendek (mis. "JNE / J&T Reguler"). Buang karakter yang bisa dipakai
// untuk HTML/attribute injection (stored-XSS di dashboard — CSP off, escaping satu-
// satunya benteng) + batasi panjang. Dipakai di create & edit order, termasuk path
// publik (checkout) yang TIDAK terautentikasi.
function sanitizeCourier(s) {
    return String(s == null ? '' : s).replace(/[<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// ── app_settings (key-value global config) ────────────────────────────────────
async function getAppSetting(key, fallback = '') {
    const row = await dbGet('SELECT value FROM app_settings WHERE key = $1', [key]);
    return row ? row.value : fallback;
}
async function setAppSetting(key, value) {
    await dbRun(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, String(value)]);
}
// Cost add-on global utk snapshot COGS (bordir nama/logo). Default 0 kalau belum diset.
async function getCogsSettings() {
    const [bn, bl] = await Promise.all([
        getAppSetting('cogs_bordir_nama', '0'),
        getAppSetting('cogs_bordir_logo', '0'),
    ]);
    return { bordirNama: parseInt(bn) || 0, bordirLogo: parseInt(bl) || 0 };
}

// Kurir 'ambil langsung' utk event/walk-in. Order dgn courier ini auto-skip
// Kemas+Kirim — di confirm-payment / bordir-done langsung jadi 'done' karena
// barang udah diambil customer di tempat. Single source of truth — selalu
// import dari sini, jangan hardcode string di banyak titik (anti-typo).
const PICKUP_COURIER = 'Diambil di event / walkin';

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
    'pink': '#d6b6bb',
    'old-pink': '#d6b6bb'  // backward-compat alias (lihat catalog.js)
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
    'pink': 'Pink',
    'old-pink': 'Pink'  // backward-compat alias (lihat catalog.js)
};
// Override hex per produk untuk warna yang artinya beda antar lini (mis. "purple" di
// Avery = plum gelap, beda dari purple scrub periwinkle). Key = SKU produk.
const PRODUCT_COLOR_HEX_OVERRIDES = {
    'WS-GWN-AVERY': { 'purple': '#362136' }
};

function formatProduct(p, mainPhoto = null, opts = {}) {
    const priceByType = safeJSON(p.price_by_type, null);
    const out = {
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
    // COGS rahasia → hanya untuk admin (opts.includeCogs). Default: strip dari payload
    // publik (catalog) supaya cost tidak bocor.
    if (opts.includeCogs) {
        out.cogs_default = p.cogs_default || 0;
        out.cogs_by_type = safeJSON(p.cogs_by_type, null);
        out.cogs_by_color = safeJSON(p.cogs_by_color, null);
        out.cost_config = safeJSON(p.cost_config, null);
    } else {
        delete out.cogs_default; delete out.cogs_by_type; delete out.cogs_by_color; delete out.cost_config;
    }
    return out;
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

// ══════════════════════════════════════════════════════════════════════════════
// CUSTOMER AUTH (#3, akun website) — TERPISAH dari admin/staff (`users`).
// Identitas login = phone (WA) + password. Token JWT dgn kind='customer' supaya
// tak bisa dipakai sebagai admin. Mirror pola admin (bcrypt + jwt Bearer).
// ══════════════════════════════════════════════════════════════════════════════

// Normalisasi nomor Indonesia → kanonik '08xxxx' (kunci unik + penaut order lama).
function normPhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('62')) d = '0' + d.slice(2);
    else if (d.startsWith('8')) d = '0' + d;
    return d;
}
function signCustomerToken(c) {
    return jwt.sign(
        { id: c.id, kind: 'customer', phone: c.phone, full_name: c.full_name },
        JWT_SECRET, { expiresIn: JWT_EXPIRES_IN }
    );
}
// Middleware: wajib login customer. Token admin (kind != 'customer') ditolak.
function requireCustomer(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Silakan login dulu.' });
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.kind !== 'customer') return res.status(403).json({ error: 'Token tidak valid untuk akun customer.' });
        req.customer = payload;
        next();
    } catch { return res.status(401).json({ error: 'Sesi berakhir, silakan login ulang.' }); }
}
// Tautkan order lama (tamu) ke akun lewat kecocokan HP (08xxx / 62xxx / 8xxx).
// Hanya order yang belum tertaut (customer_id IS NULL). Idempoten.
async function linkGuestOrdersByPhone(customerId, canonPhone) {
    const nsn = canonPhone.replace(/^0/, '');   // '8xxxxxxxxx'
    await dbRun(
        `UPDATE orders SET customer_id = $1
         WHERE customer_id IS NULL
           AND regexp_replace(customer_phone, '\\D', '', 'g') IN ($2, $3, $4)`,
        [customerId, '0' + nsn, '62' + nsn, nsn]
    );
}

// POST /api/customer/register — { full_name, phone, password, email? }
app.post('/api/customer/register', loginLimiter, async (req, res) => {
    try {
        const full_name = (req.body.full_name || '').trim();
        const email = (req.body.email || '').trim() || null;
        const password = req.body.password || '';
        const canon = normPhone(req.body.phone);
        if (!full_name) return res.status(400).json({ error: 'Nama wajib diisi.' });
        if (canon.length < 9 || canon.length > 15 || !/^0[0-9]+$/.test(canon))
            return res.status(400).json({ error: 'Nomor WhatsApp tidak valid (format 08xxx).' });
        if (password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter.' });
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
            return res.status(400).json({ error: 'Format email tidak valid.' });

        const exists = await dbGet('SELECT id FROM customers WHERE phone = $1', [canon]);
        if (exists) return res.status(409).json({ error: 'Nomor ini sudah terdaftar. Silakan login.' });

        const hash = await bcrypt.hash(password, 10);
        const result = await dbRun(
            'INSERT INTO customers (phone, password_hash, full_name, email) VALUES ($1,$2,$3,$4) RETURNING id',
            [canon, hash, full_name, email]
        );
        const id = result.rows[0].id;
        await linkGuestOrdersByPhone(id, canon);   // tautkan order lama by HP
        const c = { id, phone: canon, full_name, email };
        res.json({ token: signCustomerToken(c), customer: c });
    } catch (err) {
        if (String(err.message).toLowerCase().includes('unique'))
            return res.status(409).json({ error: 'Nomor ini sudah terdaftar. Silakan login.' });
        res.status(500).json({ error: err.message });
    }
});

// POST /api/customer/login — { phone, password }
app.post('/api/customer/login', loginLimiter, async (req, res) => {
    try {
        const canon = normPhone(req.body.phone);
        const password = req.body.password || '';
        if (!canon || !password) return res.status(400).json({ error: 'Nomor & password wajib diisi.' });
        const c = await dbGet('SELECT * FROM customers WHERE phone = $1', [canon]);
        if (!c) return res.status(401).json({ error: 'Nomor atau password salah.' });
        const valid = await bcrypt.compare(password, c.password_hash);
        if (!valid) return res.status(401).json({ error: 'Nomor atau password salah.' });
        await linkGuestOrdersByPhone(c.id, canon);   // defensif: tautkan order baru yg belum ke-link
        const pub = { id: c.id, phone: c.phone, full_name: c.full_name, email: c.email };
        res.json({ token: signCustomerToken(pub), customer: pub });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/customer/me
app.get('/api/customer/me', requireCustomer, async (req, res) => {
    try {
        const c = await dbGet('SELECT id, phone, full_name, email, created_at FROM customers WHERE id = $1', [req.customer.id]);
        if (!c) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
        res.json({ customer: c });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/customer/profile — update nama & email (phone immutable v1).
app.put('/api/customer/profile', requireCustomer, upload.none(), async (req, res) => {
    try {
        const full_name = (req.body.full_name || '').trim();
        const email = (req.body.email || '').trim() || null;
        if (!full_name) return res.status(400).json({ error: 'Nama wajib diisi.' });
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
            return res.status(400).json({ error: 'Format email tidak valid.' });
        await dbRun('UPDATE customers SET full_name=$1, email=$2, updated_at=NOW() WHERE id=$3',
            [full_name, email, req.customer.id]);
        res.json({ success: true, customer: { id: req.customer.id, phone: req.customer.phone, full_name, email } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/customer/addresses
app.get('/api/customer/addresses', requireCustomer, async (req, res) => {
    try {
        const rows = await dbAll(
            'SELECT * FROM customer_addresses WHERE customer_id=$1 ORDER BY is_default DESC, id DESC',
            [req.customer.id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customer/addresses
app.post('/api/customer/addresses', requireCustomer, upload.none(), async (req, res) => {
    try {
        const label = (req.body.label || '').trim() || null;
        const recipient_name = (req.body.recipient_name || '').trim();
        const phone = (req.body.phone || '').trim();
        const address = (req.body.address || '').trim();
        const city = (req.body.city || '').trim();
        const is_default = req.body.is_default === 'true' || req.body.is_default === true;
        if (!recipient_name || !phone || !address || !city)
            return res.status(400).json({ error: 'Nama penerima, HP, alamat, dan kota wajib diisi.' });
        await withTransaction(async (client) => {
            if (is_default)
                await client.query('UPDATE customer_addresses SET is_default=FALSE WHERE customer_id=$1', [req.customer.id]);
            await client.query(
                `INSERT INTO customer_addresses (customer_id,label,recipient_name,phone,address,city,is_default)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [req.customer.id, label, recipient_name, phone, address, city, is_default]);
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/customer/addresses/:id — hanya alamat milik sendiri.
app.put('/api/customer/addresses/:id', requireCustomer, upload.none(), async (req, res) => {
    try {
        const own = await dbGet('SELECT id FROM customer_addresses WHERE id=$1 AND customer_id=$2', [req.params.id, req.customer.id]);
        if (!own) return res.status(404).json({ error: 'Alamat tidak ditemukan.' });
        const label = (req.body.label || '').trim() || null;
        const recipient_name = (req.body.recipient_name || '').trim();
        const phone = (req.body.phone || '').trim();
        const address = (req.body.address || '').trim();
        const city = (req.body.city || '').trim();
        const is_default = req.body.is_default === 'true' || req.body.is_default === true;
        if (!recipient_name || !phone || !address || !city)
            return res.status(400).json({ error: 'Nama penerima, HP, alamat, dan kota wajib diisi.' });
        await withTransaction(async (client) => {
            if (is_default)
                await client.query('UPDATE customer_addresses SET is_default=FALSE WHERE customer_id=$1', [req.customer.id]);
            await client.query(
                `UPDATE customer_addresses SET label=$1,recipient_name=$2,phone=$3,address=$4,city=$5,is_default=$6
                 WHERE id=$7 AND customer_id=$8`,
                [label, recipient_name, phone, address, city, is_default, req.params.id, req.customer.id]);
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/customer/addresses/:id
app.delete('/api/customer/addresses/:id', requireCustomer, async (req, res) => {
    try {
        const r = await dbRun('DELETE FROM customer_addresses WHERE id=$1 AND customer_id=$2', [req.params.id, req.customer.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/customer/orders — riwayat + status order milik customer ini.
app.get('/api/customer/orders', requireCustomer, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT id, order_code, order_status, payment_status, total_amount, shipping_cost,
                    has_bordir_nama, has_bordir_logo, bordir_status, shipping_courier, created_at, paid_at
             FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
            [req.customer.id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN: DATA CLIENT (customer akun website) ────────────────────────────────
// Read-only. Menu `customers` sengaja TIDAK masuk EDITABLE_MENUS — admin cuma
// melihat, tidak mengubah data akun customer dari dashboard (ganti nomor HP =
// harus relink order, lihat memory customer_accounts; itu urusan fase 2).

// GET /api/admin/customers?search=  → daftar + ringkasan order per customer.
// Dibatasi 500 baris (basis customer masih kecil; kalau tumbuh, tambah paginasi).
app.get('/api/admin/customers', requireMenu('customers'), async (req, res) => {
    try {
        const q = String(req.query.search || '').trim();
        const like = `%${q}%`;
        const rows = await dbAll(
            `SELECT c.id, c.full_name, c.phone, c.email, c.created_at,
                    COUNT(o.id) FILTER (WHERE o.order_status <> 'cancelled')                          AS orders_count,
                    COUNT(o.id) FILTER (WHERE o.payment_status <> 'paid' AND o.order_status <> 'cancelled') AS unpaid_count,
                    COALESCE(SUM(o.total_amount) FILTER (
                        WHERE o.payment_status = 'paid' AND o.order_status <> 'cancelled'), 0)        AS total_spent,
                    MAX(o.created_at) FILTER (WHERE o.order_status <> 'cancelled')                    AS last_order_at,
                    (SELECT COUNT(*) FROM customer_addresses a WHERE a.customer_id = c.id)            AS addresses_count
             FROM customers c
             LEFT JOIN orders o ON o.customer_id = c.id
             WHERE $1 = '' OR c.full_name ILIKE $2 OR c.phone ILIKE $2 OR COALESCE(c.email,'') ILIKE $2
             GROUP BY c.id
             ORDER BY c.created_at DESC
             LIMIT 500`,
            [q, like]
        );
        // Statistik dihitung di SERVER atas SELURUH customer — jangan diturunkan
        // dari `rows`. `rows` terbatas 500 baris dan menyusut saat admin mencari,
        // jadi kalau statistik ikut dihitung dari situ, angkanya diam-diam berubah
        // arti begitu kolom pencarian diisi (tiga kartu berdampingan tapi
        // cakupannya beda). Ini pernah bikin bingung → dipindah ke sini.
        const stats = await dbGet(
            `SELECT
                (SELECT COUNT(*)::int FROM customers) AS total,
                (SELECT COUNT(*)::int FROM customers
                  WHERE created_at >= NOW() - INTERVAL '30 days') AS new_30d,
                (SELECT COALESCE(SUM(o.total_amount), 0)::bigint FROM orders o
                  WHERE o.customer_id IS NOT NULL
                    AND o.payment_status = 'paid'
                    AND o.order_status <> 'cancelled') AS total_spent`
        );
        res.json({
            customers: rows, shown: rows.length, search: q,
            total: Number(stats?.total || 0),          // dipertahankan utk kompat
            stats: {
                total:       Number(stats?.total || 0),
                new_30d:     Number(stats?.new_30d || 0),
                total_spent: Number(stats?.total_spent || 0),
            },
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/customers/:id → profil + alamat + riwayat order (+ order tamu
// ber-HP sama yang BELUM tertaut). Yang terakhir penting: auto-link hanya jalan
// sekali saat registrasi, jadi order yang dibuat admin lewat Kasir/WA SESUDAH
// itu tidak otomatis masuk ke akun customer.
app.get('/api/admin/customers/:id', requireMenu('customers'), async (req, res) => {
    try {
        const c = await dbGet(
            'SELECT id, full_name, phone, email, created_at, updated_at FROM customers WHERE id = $1',
            [req.params.id]
        );
        if (!c) return res.status(404).json({ error: 'Customer tidak ditemukan' });

        const addresses = await dbAll(
            `SELECT id, label, recipient_name, phone, address, city, is_default, created_at
             FROM customer_addresses WHERE customer_id = $1
             ORDER BY is_default DESC, id ASC`, [c.id]);

        const orderCols = `id, order_code, created_at, invoice_date, order_status, payment_status,
                           total_amount, dp_amount, dp_settled_at, shipping_courier, shipping_city,
                           tracking_number, order_source`;
        const orders = await dbAll(
            `SELECT ${orderCols} FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`, [c.id]);

        const nsn = normPhone(c.phone).replace(/^0/, '');
        const unlinkedOrders = await dbAll(
            `SELECT ${orderCols}, customer_name FROM orders
             WHERE customer_id IS NULL
               AND regexp_replace(customer_phone, '\\D', '', 'g') IN ($1, $2, $3)
             ORDER BY created_at DESC`,
            ['0' + nsn, '62' + nsn, nsn]);

        res.json({ customer: c, addresses, orders, unlinked_orders: unlinkedOrders });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
        const u = getOptionalUser(req);
        const includeCogs = !!u && u.role === 'admin';
        res.json(rows.map(r => formatProduct(r, r.main_photo, { includeCogs })));
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

        const u = getOptionalUser(req);
        const includeCogs = !!u && u.role === 'admin';
        res.json({ ...formatProduct(p, mainPhoto, { includeCogs }), variants, inventory });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COGS Settings (cost add-on global: bordir nama/logo) — ADMIN ONLY ─────────
app.get('/api/settings/cogs', requireAuth(['admin']), async (req, res) => {
    try {
        const s = await getCogsSettings();
        res.json({ cogs_bordir_nama: s.bordirNama, cogs_bordir_logo: s.bordirLogo });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/settings/cogs', requireAuth(['admin']), async (req, res) => {
    try {
        const bn = parseInt(req.body.cogs_bordir_nama);
        const bl = parseInt(req.body.cogs_bordir_logo);
        if (Number.isInteger(bn) && bn >= 0) await setAppSetting('cogs_bordir_nama', bn);
        if (Number.isInteger(bl) && bl >= 0) await setAppSetting('cogs_bordir_logo', bl);
        const s = await getCogsSettings();
        res.json({ cogs_bordir_nama: s.bordirNama, cogs_bordir_logo: s.bordirLogo });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/products
app.post('/api/products', requireMenu('products','edit'), upload.any(), async (req, res) => {
    try {
        const { sku, name, category, price, short_description, long_description,
            short_description_en, long_description_en,
            sizes, colors, types, is_popular, status, price_by_type, cogs_default, cogs_by_type } = req.body;

        if (!sku || !name || !category)
            return res.status(400).json({ error: 'SKU, nama, dan kategori wajib diisi' });

        const priceByTypeObj = price_by_type ? safeJSON(price_by_type, null) : null;
        // COGS admin-only (cost rahasia). Staff non-admin tidak bisa set walau punya products:edit.
        const isAdminUser = req.user && req.user.role === 'admin';
        const cogsDefault = isAdminUser ? (parseInt(cogs_default) || 0) : 0;
        const cogsByTypeObj = (isAdminUser && cogs_by_type) ? safeJSON(cogs_by_type, null) : null;
        const cogsByColorObj = (isAdminUser && req.body.cogs_by_color) ? safeJSON(req.body.cogs_by_color, null) : null;
        const costConfigJson = (isAdminUser && typeof req.body.cost_config === 'string' && safeJSON(req.body.cost_config, null)) ? req.body.cost_config : null;
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
                  sizes, colors, types, is_popular, status, cogs_default, cogs_by_type, cost_config, cogs_by_color)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
                [sku, name, category, basePrice,
                    priceByTypeObj ? JSON.stringify(priceByTypeObj) : null,
                    short_description || '', long_description || '',
                    short_description_en || '', long_description_en || '',
                    typeof sizes === 'string' ? sizes : JSON.stringify(sizes),
                    typeof colors === 'string' ? colors : JSON.stringify(colors),
                    typeof types === 'string' ? types : JSON.stringify(types),
                    is_popular === '1' || is_popular === true ? 1 : 0,
                    status || 'active',
                    cogsDefault, cogsByTypeObj ? JSON.stringify(cogsByTypeObj) : null, costConfigJson,
                    cogsByColorObj ? JSON.stringify(cogsByColorObj) : null]
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
            sizes, colors, types, is_popular, status, sku, price_by_type, cogs_default, cogs_by_type } = req.body;

        const priceByTypeObj = price_by_type ? safeJSON(price_by_type, null) : null;
        // COGS admin-only: non-admin tidak boleh ubah (SET cogs di-skip → nilai lama dipertahankan).
        const isAdminUser = req.user && req.user.role === 'admin';
        const cogsDefault = parseInt(cogs_default) || 0;
        const cogsByTypeObj = cogs_by_type ? safeJSON(cogs_by_type, null) : null;
        const cogsByColorObj = req.body.cogs_by_color ? safeJSON(req.body.cogs_by_color, null) : null;
        const costConfigJson = (typeof req.body.cost_config === 'string' && safeJSON(req.body.cost_config, null)) ? req.body.cost_config : null;
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
            const cogsSet = isAdminUser ? ', cogs_default=$15, cogs_by_type=$16, cost_config=$17, cogs_by_color=$18' : '';
            const cogsParams = isAdminUser ? [cogsDefault, cogsByTypeObj ? JSON.stringify(cogsByTypeObj) : null, costConfigJson, cogsByColorObj ? JSON.stringify(cogsByColorObj) : null] : [];
            await client.query(
                `UPDATE products SET name=$1, category=$2, price=$3, price_by_type=$4,
                 short_description=$5, long_description=$6,
                 short_description_en=$7, long_description_en=$8,
                 sizes=$9, colors=$10, types=$11,
                 is_popular=$12, status=$13, sku=$14${cogsSet}
                 WHERE id = $${15 + cogsParams.length}`,
                [name, category, basePrice,
                    priceByTypeObj ? JSON.stringify(priceByTypeObj) : null,
                    short_description || '', long_description || '',
                    short_description_en || '', long_description_en || '',
                    typeof sizes === 'string' ? sizes : JSON.stringify(sizes),
                    typeof colors === 'string' ? colors : JSON.stringify(colors),
                    typeof types === 'string' ? types : JSON.stringify(types),
                    is_popular === '1' || is_popular === true ? 1 : 0,
                    status || 'active', sku,
                    ...cogsParams,
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
                    COALESCE(oi.custom_product_name, p.name) AS product_name,
                    inv.stock AS variant_stock,
                    CASE WHEN oi.is_custom_product THEN 'custom_product'
                         WHEN oi.is_custom_size THEN 'custom'
                         ELSE 'catalog' END AS po_type
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             LEFT JOIN products p ON p.id = oi.product_id
             LEFT JOIN inventory inv ON inv.product_id = oi.product_id AND inv.size = oi.size
                  AND inv.color = oi.color AND inv.variant_type = oi.variant_type
             WHERE (oi.is_po = TRUE OR oi.is_custom_size = TRUE OR oi.is_custom_product = TRUE)
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
        // Notif "Pesanan Baru" = order NORMAL menunggu bayar. Kecualikan cancelled +
// status TRIAL (test_sent/pending_pay/return) — trial punya badge Temporary Order
// sendiri, kalau ikut kehitung di sini jadi dobel (bug notif +1, kasus #93 size_trial).
const pendingOrders = await dbGet("SELECT COUNT(*) as count FROM orders WHERE payment_status = 'pending' AND order_status NOT IN ('cancelled','test_sent','test_pending_pay','test_pending_return')");
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
        // Notif "Pesanan Baru" = order NORMAL menunggu bayar. Kecualikan cancelled +
// status TRIAL (test_sent/pending_pay/return) — trial punya badge Temporary Order
// sendiri, kalau ikut kehitung di sini jadi dobel (bug notif +1, kasus #93 size_trial).
const pendingOrders = await dbGet("SELECT COUNT(*) as count FROM orders WHERE payment_status = 'pending' AND order_status NOT IN ('cancelled','test_sent','test_pending_pay','test_pending_return')");
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

// GET /api/reports/margin — ringkasan profit dari snapshot COGS. ADMIN ONLY.
// Net product revenue = gross produk − diskon (ongkir TIDAK termasuk). COGS dijumlah
// dari order_items.total_cogs (TERMASUK item bonus karena tetap memakan biaya,
// EXCLUDE item trial yang dikembalikan). Gross profit = net revenue − COGS.
app.get('/api/reports/margin', requireAuth(['admin']), async (req, res) => {
    try {
        const r = reportRange(req);
        if (!r) return res.status(400).json({ error: 'Parameter from & to wajib (format YYYY-MM-DD)' });
        const rev = await dbGet(
            `SELECT COALESCE(SUM(total_amount - shipping_cost + discount_amount),0)::bigint AS gross,
                    COALESCE(SUM(discount_amount),0)::bigint AS discount
               FROM orders
              WHERE payment_status='paid' AND order_status<>'cancelled'
                AND paid_at >= $1::date AND paid_at < ($2::date + 1)`,
            [r.from, r.to]
        );
        const cogsRow = await dbGet(
            `SELECT COALESCE(SUM(oi.total_cogs),0)::bigint AS cogs
               FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE o.payment_status='paid' AND o.order_status<>'cancelled'
                AND COALESCE(oi.is_test_returned, FALSE) = FALSE
                AND o.paid_at >= $1::date AND o.paid_at < ($2::date + 1)`,
            [r.from, r.to]
        );
        const gross = Number(rev.gross), discount = Number(rev.discount), cogs = Number(cogsRow.cogs);
        const net = gross - discount;
        const grossProfit = net - cogs;
        const marginPct = net > 0 ? +(grossProfit / net * 100).toFixed(1) : 0;
        res.json({ from: r.from, to: r.to, gross_revenue: gross, discount, net_revenue: net, cogs, gross_profit: grossProfit, margin_pct: marginPct });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/margin-by-product — margin per produk+variant. ADMIN ONLY.
// Pendapatan = harga jual (produk+bordir) SEBELUM diskon order (gross). COGS = snapshot.
// Exclude bonus (revenue 0), cancelled, trial-returned. Diurutkan profit terbesar.
app.get('/api/reports/margin-by-product', requireAuth(['admin']), async (req, res) => {
    try {
        const r = reportRange(req);
        if (!r) return res.status(400).json({ error: 'Parameter from & to wajib (format YYYY-MM-DD)' });
        const rows = await dbAll(
            `SELECT COALESCE(p.name, oi.custom_product_name) AS product,
                    p.sku AS sku,
                    oi.variant_type AS variant_type,
                    SUM(oi.quantity)::int AS qty,
                    COALESCE(SUM(oi.price * oi.quantity),0)::bigint AS revenue,
                    COALESCE(SUM(oi.total_cogs),0)::bigint AS cogs
               FROM order_items oi JOIN orders o ON o.id = oi.order_id
               LEFT JOIN products p ON p.id = oi.product_id
              WHERE o.payment_status='paid' AND o.order_status<>'cancelled'
                AND oi.is_bonus = FALSE
                AND COALESCE(oi.is_test_returned, FALSE) = FALSE
                AND o.paid_at >= $1::date AND o.paid_at < ($2::date + 1)
              GROUP BY product, p.sku, oi.variant_type
              ORDER BY (COALESCE(SUM(oi.price*oi.quantity),0) - COALESCE(SUM(oi.total_cogs),0)) DESC`,
            [r.from, r.to]
        );
        res.json(rows.map(x => {
            const revenue = Number(x.revenue), cogs = Number(x.cogs), gp = revenue - cogs;
            return { product: x.product, sku: x.sku, variant_type: x.variant_type, qty: x.qty,
                revenue, cogs, gross_profit: gp, margin_pct: revenue > 0 ? +(gp / revenue * 100).toFixed(1) : 0 };
        }));
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

// GET /api/reports/items-detail — per-transaction breakdown utk export Excel
// Setiap row = 1 order_item. Disertakan disc per-line (dihitung dari discount_percent order).
app.get('/api/reports/items-detail', requireMenu('report','view'), async (req, res) => {
    try {
        const r = reportRange(req);
        if (!r) return res.status(400).json({ error: 'Parameter from & to wajib (format YYYY-MM-DD)' });
        const rows = await dbAll(
            `SELECT o.paid_at,
                    o.order_code,
                    o.customer_name,
                    o.order_source,
                    COALESCE(o.discount_percent, 0)::int AS discount_percent,
                    COALESCE(p.name, oi.custom_product_name) AS product_name,
                    p.sku AS sku,
                    COALESCE(p.category, oi.custom_product_category) AS category,
                    oi.variant_type,
                    oi.color,
                    oi.size,
                    oi.quantity::int AS quantity,
                    oi.price::bigint AS unit_price,
                    COALESCE(oi.bordir_nama, FALSE) AS bordir_nama,
                    COALESCE(oi.bordir_logo, FALSE) AS bordir_logo,
                    oi.bordir_nama_price::bigint AS bordir_nama_price,
                    oi.bordir_logo_price::bigint AS bordir_logo_price,
                    oi.is_bonus,
                    oi.is_custom_size,
                    oi.is_custom_product,
                    oi.is_po,
                    oi.unit_cogs::bigint AS unit_cogs,
                    oi.bordir_nama_cogs::bigint AS bordir_nama_cogs,
                    oi.bordir_logo_cogs::bigint AS bordir_logo_cogs,
                    oi.total_cogs::bigint AS total_cogs
               FROM order_items oi
               JOIN orders o ON o.id = oi.order_id
               LEFT JOIN products p ON p.id = oi.product_id
              WHERE o.payment_status='paid' AND o.order_status<>'cancelled'
                AND oi.is_bonus = FALSE
                AND COALESCE(oi.is_test_returned, FALSE) = FALSE
                AND o.paid_at >= $1::date AND o.paid_at < ($2::date + 1)
              ORDER BY o.paid_at ASC, o.order_code ASC`,
            [r.from, r.to]
        );
        // COGS rahasia → strip dari payload kalau bukan admin (report:view bisa dipunya staf).
        const isAdmin = req.user && req.user.role === 'admin';
        if (!isAdmin) rows.forEach(row => { delete row.unit_cogs; delete row.bordir_nama_cogs; delete row.bordir_logo_cogs; delete row.total_cogs; });
        res.json(rows);
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
                AND COALESCE(oi.is_test_returned, FALSE) = FALSE
                AND o.paid_at >= $1::date AND o.paid_at < ($2::date + 1)
              GROUP BY p.id, p.name, p.sku, p.category, p.price
              ORDER BY total_sales DESC`,
            [r.from, r.to]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CITIES & SHIPPING ──────────────────────────────────────────────────────────

// GET /api/cities — Daftar kota Indonesia (+ international untuk admin)
// kasir_only entries (Malaysia/Singapore) di-hide dari public checkout supaya
// customer tidak bisa pilih sendiri — admin entry di Kasir saja.
app.get('/api/cities', (req, res) => {
    const { q } = req.query;
    const authUser = getOptionalUser(req);
    const isAdmin = !!authUser && (authUser.role === 'admin' || hasMenu(authUser, 'manual-order', 'edit'));
    let list = isAdmin ? CITIES : CITIES.filter(c => !c.kasir_only);
    if (q) {
        const lq = q.toLowerCase();
        list = list.filter(c => c.name.toLowerCase().includes(lq));
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
        // Cek CITY_RATES override dulu (mis. Aceh 40rb, Lampung 15rb, Gorontalo 50rb)
        // sebelum fallback ke ZONE_RATES.
        ratePerKg = rateForCity(cityInfo.name, zone);
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
                `SELECT oi.*, COALESCE(oi.custom_product_name, p.name) as product_name,
                        COALESCE(p.category, oi.custom_product_category) as category
                 FROM order_items oi
                 LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
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
            `SELECT oi.*, COALESCE(oi.custom_product_name, p.name) as product_name,
                    COALESCE(p.category, oi.custom_product_category) as category,
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
             LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
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
            billing_to,      // nama partner yang ditagih (collaboration_event), admin-only
            invoice_date,    // override tanggal invoice (admin-only, opsional)
            invoice_notes    // catatan customer-facing di PDF invoice (admin-only, opsional)
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

        // ── GUARD DUPLIKAT (public only) ──────────────────────────────────────
        // Kasus nyata (Lisan gigih prakoso, 1 Agu): client bikin order, tak jadi
        // bayar, lalu order lagi item sama → order pertama gantung. Cegah: kalau HP
        // sama punya order BELUM DIBAYAR dgn item identik dalam 24 jam, balas 409 +
        // kode order lama. Frontend tampilkan pilihan (bayar order lama / tetap baru).
        // Soft guard: bisa di-override dgn force_new=true (client sadar mau order lagi).
        // Skip utk admin (Kasir memang sengaja bikin order) & saat force_new.
        const forceNew = req.body.force_new === true || req.body.force_new === 'true';
        if (!isAdmin && !forceNew) {
            // Signature order = set baris (produk|size|warna|varian|qty|bordirNama|bordirLogo),
            // diurut supaya urutan item tak mempengaruhi. Dipakai bandingkan order lama vs baru.
            const sigOf = (arr) => arr.map(it => [
                (it.product_id ?? ('cp:' + (it.custom_product_name || ''))),
                it.size, it.color, (it.variant_type || 'null'),
                Number(it.quantity || 0), !!it.bordir_nama, !!it.bordir_logo
            ].join('|')).sort().join(';;');
            const incomingSig = sigOf(items);
            const candidates = await dbAll(
                `SELECT id, order_code FROM orders
                 WHERE regexp_replace(customer_phone,'\\D','','g') = $1
                   AND order_status = 'waiting_payment' AND payment_status = 'pending'
                   AND created_at > NOW() - INTERVAL '24 hours'
                 ORDER BY created_at DESC LIMIT 10`,
                [custPhoneDigits]
            );
            for (const c of candidates) {
                const oldItems = await dbAll(
                    `SELECT product_id, size, color, variant_type, quantity, bordir_nama, bordir_logo, custom_product_name
                     FROM order_items WHERE order_id = $1`, [c.id]
                );
                if (sigOf(oldItems) === incomingSig) {
                    return res.status(409).json({
                        duplicate: true,
                        existing_order_code: c.order_code,
                        existing_order_id: c.id,
                        error: `Kamu sudah punya pesanan ${c.order_code} dengan barang yang sama dan belum dibayar. Selesaikan pembayaran pesanan itu, atau tekan "Tetap buat pesanan baru".`
                    });
                }
            }
        }

        // Aggregate qty per physical variant before stock check — bordir splits share
        // the same inventory row, so checking per-item allows over-allocation when
        // the same shirt appears as multiple lines (plain + with name + with logo).
        const variantTotals = new Map();
        for (const item of items) {
            // Custom-size, Custom-Product (both off-catalog, no inventory row) and
            // Pre-Order (qty > stock, fulfilled later at receive) all skip the stock
            // check. ADMIN-ONLY: a public caller sending these flags must NOT bypass
            // stock (same anti-tamper posture as is_bonus), so the skip is gated behind isAdmin.
            if (isAdmin && (item.is_custom_size === true || item.is_po === true || item.is_custom_product === true)) continue;
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
        // COGS add-on global (bordir) — di-load sekali utk snapshot per item.
        const cogsSettings = await getCogsSettings();
        // Kategori custom product. Superset dari products.category CHECK: 'set'
        // (atasan+celana satu paket) sengaja HANYA ada di sini.
        const CUSTOM_PROD_CATS = ['tops', 'pants', 'caps', 'gown', 'set', 'aksesoris'];
        for (const item of items) {
            // Custom-Product (8 Jun): fully off-catalog, no products row. name/category/
            // price all come from the admin-supplied payload. ADMIN-ONLY — public callers
            // sending this flag must NOT bypass catalog price (anti-tamper).
            const isCustomProduct = isAdmin && item.is_custom_product === true;
            let product;
            if (isCustomProduct) {
                // Validate the client-supplied custom product payload up front; fail fast
                // before we open a transaction.
                const cpName = (item.custom_product_name || '').trim();
                const cpCat = (item.custom_product_category || '').trim();
                if (!cpName) return res.status(400).json({ error: 'Custom product: nama wajib diisi' });
                if (!CUSTOM_PROD_CATS.includes(cpCat))
                    return res.status(400).json({ error: 'Custom product: kategori tidak valid' });
                if (!Number.isInteger(item.custom_price) || item.custom_price < 0)
                    return res.status(400).json({ error: 'Custom product: harga satuan wajib & tidak boleh negatif' });
                // Synthetic product stand-in so the rest of the loop reads uniformly.
                // product_id stays NULL when we INSERT later.
                product = { name: cpName, category: cpCat, price: item.custom_price, price_by_type: null };
            } else {
                product = await dbGet('SELECT * FROM products WHERE id = $1', [item.product_id]);
                if (!product) return res.status(400).json({ error: `Produk ID ${item.product_id} tidak ditemukan` });
            }
            // Per-item price = base product price + per-item embroidery cost.
            // Bonus item (gift): entire line is free (product + bordir = Rp 0). Stock
            // is still deducted later — only the price is zeroed.
            // SECURITY: bonus is ADMIN-ONLY. A public caller sending is_bonus:true must
            // not get free products — gate it behind isAdmin.
            const isBonus = isAdmin && item.is_bonus === true;
            // Custom size (e.g. 4XL): off-catalog garment with an admin-set base price.
            // ADMIN-ONLY (anti-tamper). When custom, the base price comes from custom_price
            // instead of the catalog product.price; falls back to product.price if missing.
            const isCustomSize = isAdmin && item.is_custom_size === true && !isCustomProduct;
            // Catalog base price: tops/gown bisa punya harga berbeda per variant
            // (mis. Lengan Pendek vs Panjang di price_by_type). product.price hanya
            // menyimpan harga TERMURAH (min), jadi resolve per variant_type dulu;
            // fallback ke product.price untuk produk harga-tunggal / variant tak dikenal.
            const priceByType = safeJSON(product.price_by_type, null);
            const catalogPrice = (priceByType && item.variant_type && priceByType[item.variant_type] != null)
                ? Number(priceByType[item.variant_type])
                : Number(product.price);
            const customBase = ((isCustomSize || isCustomProduct) && Number.isInteger(item.custom_price) && item.custom_price >= 0) ? item.custom_price : catalogPrice;
            // Pre-Order (qty > stock): whole line is deferred, stock allocated later at
            // receive (FIFO, paid-only). ADMIN-ONLY. Custom takes precedence — a
            // custom (off-catalog) line is never a PO since it has no inventory to wait for.
            const isPO = isAdmin && item.is_po === true && !isCustomSize && !isCustomProduct;
            // Bordir price: admin may override per-order (e.g. logo lebih susah → 40rb);
            // public callers ALWAYS use the fixed 20rb/30rb (gate behind isAdmin, anti-tamper).
            const namaPrice = (isAdmin && Number.isInteger(item.bordir_nama_price) && item.bordir_nama_price >= 0) ? item.bordir_nama_price : 20000;
            const logoPrice = (isAdmin && Number.isInteger(item.bordir_logo_price) && item.bordir_logo_price >= 0) ? item.bordir_logo_price : 30000;
            const itemEmbroidery = isBonus ? 0 : ((item.bordir_nama ? namaPrice : 0) + (item.bordir_logo ? logoPrice : 0));
            const basePrice = isBonus ? 0 : customBase;
            const unitPrice = basePrice + itemEmbroidery;
            // ── COGS snapshot (admin-only; cost tidak pernah dari caller publik) ──
            // Custom Product → cost manual admin. Lainnya (termasuk custom size/warna)
            // → cogs_by_type[variant] ?? cogs_default produk. Item BONUS tetap kena cost
            // (cuma harga jual yg di-nol-kan), supaya margin tidak terlihat lebih bagus
            // dari realita.
            const cogsByType = safeJSON(product.cogs_by_type, null);
            const cogsByColor = safeJSON(product.cogs_by_color, null);
            // Resolusi cost: override warna (per variant) > per variant > default produk.
            const colorOv = cogsByColor && item.color ? cogsByColor[item.color] : null;
            const baseCogs = isCustomProduct
                ? ((isAdmin && Number.isInteger(item.custom_cogs) && item.custom_cogs >= 0) ? item.custom_cogs : 0)
                : ((colorOv && item.variant_type && colorOv[item.variant_type] != null) ? Number(colorOv[item.variant_type])
                    : (cogsByType && item.variant_type && cogsByType[item.variant_type] != null) ? Number(cogsByType[item.variant_type])
                    : Number(product.cogs_default || 0));
            const bordirNamaCogs = item.bordir_nama ? cogsSettings.bordirNama : 0;
            const bordirLogoCogs = item.bordir_logo ? cogsSettings.bordirLogo : 0;
            const totalCogs = (baseCogs + bordirNamaCogs + bordirLogoCogs) * item.quantity;
            itemDetails.push({ ...item, is_bonus: isBonus, is_custom_size: isCustomSize, is_custom_product: isCustomProduct, is_po: isPO, price: unitPrice, product_name: product.name, custom_product_name: isCustomProduct ? product.name : null, custom_product_category: isCustomProduct ? product.category : null, base_price: basePrice, embroidery_cost: itemEmbroidery,
                bordir_nama_price: item.bordir_nama ? namaPrice : null, bordir_logo_price: item.bordir_logo ? logoPrice : null,
                unit_cogs: baseCogs, bordir_nama_cogs: bordirNamaCogs, bordir_logo_cogs: bordirLogoCogs, packaging_cogs: 0, total_cogs: totalCogs });
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

        // invoice_date: admin override utk tanggal yg tampil di invoice (customer request,
        // mis. backdated). YYYY-MM-DD dari client. Public callers DI-IGNORE (anti-tamper
        // — supaya tidak bisa backdate sale di public checkout). Format invalid → NULL.
        let safeInvoiceDate = null;
        if (isAdmin && typeof invoice_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(invoice_date)) {
            const d = new Date(invoice_date + 'T00:00:00Z');
            if (!isNaN(d.getTime())) safeInvoiceDate = d.toISOString();
        }

        // invoice_notes: catatan customer-facing yg muncul di PDF invoice (di atas
        // Payment Information). Admin-only — public order tidak bisa set (anti-abuse,
        // customer bisa selipin pesan/link di invoice). Max 500 char utk mencegah
        // invoice bloat + attack via giant strings.
        const safeInvoiceNotes = (isAdmin && typeof invoice_notes === 'string' && invoice_notes.trim())
            ? invoice_notes.trim().slice(0, 500)
            : null;

        // shipping_cost: admin sets it manually (trusted). Public orders are RECOMPUTED
        // server-side from city + qty (same rule as /api/shipping-cost) so the client
        // can't tamper the amount (e.g. send 0).
        let shippingCost;
        if (isAdmin) {
            shippingCost = parseInt(shipping_cost || 0);
        } else {
            const ci = CITIES.find(c => c.name === shipping_city);
            // Block international (kasir_only) dari public checkout — anti DOM-bypass:
            // dropdown /api/cities sudah filter, tapi attacker bisa POST shipping_city
            // langsung. Reject di sini.
            if (ci && ci.kasir_only)
                return res.status(403).json({ error: 'Tujuan international hanya tersedia via Kasir admin' });
            const totalQty = items.reduce((s, i) => s + Number(i.quantity || 0), 0);
            const wKg = Math.ceil(totalQty / 3);
            if (!ci) shippingCost = 0;
            else if (ci.zone !== 1 && wKg > 10) shippingCost = 0;   // Lion Cargo — admin konfirmasi nanti
            else shippingCost = wKg * rateForCity(ci.name, ci.zone || 3);
        }

        // Diskon (hanya product total, ongkir tidak kena diskon).
        // SECURITY: hanya admin/manager. Order publik dipaksa 0.
        const validDiscounts = [0, 5, 30];
        const requestedPct = isAdmin ? parseInt(discount_percent) : 0;
        const safeDiscountPct = validDiscounts.includes(requestedPct) ? requestedPct : 0;
        // Admin dapat override total discount via discount_amount_custom (untuk per-produk/panel disc di Kasir cart)
        const rawCustom = parseInt(req.body.discount_amount_custom);
        const discountAmountCustom = (isAdmin && Number.isInteger(rawCustom) && rawCustom >= 0) ? rawCustom : null;
        const discountAmountRaw = discountAmountCustom !== null ? discountAmountCustom : Math.round(productTotal * safeDiscountPct / 100);
        // Clamp: diskon tidak boleh melebihi subtotal produk (cegah total_amount negatif
        // yang merusak invoice/report/refund). Konsisten dgn clamp DP di bawah.
        const discountAmount = Math.max(0, Math.min(discountAmountRaw, productTotal));
        const discountLabel = discountAmountCustom !== null
            ? (req.body.discount_label_custom || 'Diskon per produk') || null
            : (safeDiscountPct === 5 ? 'Diskon 5%' : safeDiscountPct === 30 ? 'Consignment 30%' : null);
        const total = productTotal - discountAmount + shippingCost;

        // DP / uang muka (admin-only). Total tetap penuh; DP hanya info pembayaran bertahap.
        const rawDp = parseInt(req.body.dp_amount);
        const safeDpAmount = (isAdmin && Number.isInteger(rawDp) && rawDp > 0)
            ? Math.min(rawDp, total) : 0;

        // Courier dipilih manual dari form, fallback ke logika kota jika tidak diisi
        const cityInfo = CITIES.find(c => c.name === shipping_city);
        const weightKg = parseFloat(shipping_weight_kg || 0);
        let autoCourier = 'JNE / J&T Reguler';
        if (cityInfo) {
            if (cityInfo.is_international) autoCourier = 'Ekspedisi Internasional (pilih manual)';
            else if (cityInfo.zone !== 1 && weightKg > 10) autoCourier = 'Lion Cargo (ongkir dikonfirmasi admin)';
            else autoCourier = cityInfo.zone === 1 ? 'JNE / J&T Reguler' : 'J&T Reguler / Lion Parcel';
        }
        const courier = (req_shipping_courier && req_shipping_courier.trim()) ? sanitizeCourier(req_shipping_courier) : autoCourier;

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
                  payment_method, discount_percent, discount_amount, discount_label, bordir_logo_requested, billing_to, invoice_date, dp_amount, invoice_notes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
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
                 safeBillingTo,
                 safeInvoiceDate,
                 safeDpAmount,
                 safeInvoiceNotes]
            );
            const newOrderId = orderResult.rows[0].id;

            for (const item of itemDetails) {
                await client.query(
                    `INSERT INTO order_items (order_id, product_id, size, color, variant_type, quantity, price, bordir_nama, bordir_logo, is_bonus, bordir_nama_price, bordir_logo_price, is_custom_size, is_po, is_custom_product, custom_product_name, custom_product_category, unit_cogs, bordir_nama_cogs, bordir_logo_cogs, packaging_cogs, total_cogs)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
                    [newOrderId, item.is_custom_product ? null : item.product_id, item.size, item.color,
                        item.variant_type || 'null', item.quantity, item.price,
                        item.bordir_nama || false, item.bordir_logo || false, item.is_bonus || false,
                        item.bordir_nama_price ?? null, item.bordir_logo_price ?? null, item.is_custom_size || false, item.is_po || false,
                        item.is_custom_product || false, item.custom_product_name || null, item.custom_product_category || null,
                        item.unit_cogs || 0, item.bordir_nama_cogs || 0, item.bordir_logo_cogs || 0, item.packaging_cogs || 0, item.total_cogs || 0]
                );
            }

            // Auto-confirm order gratis (total = 0): kalau semua produk bonus + ongkir 0
            // (mis. free giveaway internal, endorsement barang), lewati step "Konfirmasi
            // Bayar" — tidak ada bukti bayar yg perlu diupload. Set langsung ke status
            // berikutnya (mirror confirm-payment logic). Gate isAdmin: hanya admin yg bisa
            // set is_bonus, jadi total=0 hanya bisa muncul dari Kasir admin.
            if (isAdmin && total === 0) {
                const isPickupAuto = (courier || '').trim() === PICKUP_COURIER;
                // Bordir → 'bordir'; pickup no-bordir → langsung 'done'; else → 'confirmed' (kemas).
                const autoStatus = (hasBordirLogo || hasBordirNama)
                    ? 'bordir'
                    : (isPickupAuto ? 'done' : 'confirmed');
                const actor = authUser?.username || 'admin';
                // ── POTONG STOK (BUG FIX) ─────────────────────────────────────
                // Auto-confirm dulu TIDAK mengurangi inventory — deduksi hanya ada
                // di confirm-payment yg di-skip untuk order gratis → stok tak berkurang.
                // Mirror logic confirm-payment: agregasi per varian fisik, skip
                // custom/PO (tak punya row inventory / deduct saat receive), FOR UPDATE
                // lock + hard check anti-oversell, log order_out. Bonus IKUT dipotong
                // (barang tetap keluar gudang meski gratis).
                const freeVariantTotals = new Map();
                for (const it of itemDetails) {
                    if (it.is_custom_size || it.is_po || it.is_custom_product) continue;
                    const vt = it.variant_type || 'null';
                    const k = `${it.product_id}|${it.size}|${it.color}|${vt}`;
                    if (!freeVariantTotals.has(k)) freeVariantTotals.set(k, { product_id: it.product_id, size: it.size, color: it.color, variant_type: vt, quantity: 0 });
                    freeVariantTotals.get(k).quantity += it.quantity;
                }
                for (const v of freeVariantTotals.values()) {
                    const invRes = await client.query(
                        'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                        [v.product_id, v.size, v.color, v.variant_type]
                    );
                    const stockBefore = invRes.rows[0] ? parseInt(invRes.rows[0].stock) : 0;
                    if (stockBefore < v.quantity) {
                        const e = new Error(`Stok tidak cukup untuk order gratis: ${v.color}/${v.variant_type}/${v.size} tersisa ${stockBefore}, dibutuhkan ${v.quantity}. Sesuaikan stok atau tandai Pre-Order.`);
                        e.statusCode = 409; throw e;
                    }
                    const stockAfter = stockBefore - v.quantity;
                    await client.query(
                        'UPDATE inventory SET stock = stock - $1 WHERE product_id=$2 AND size=$3 AND color=$4 AND variant_type=$5',
                        [v.quantity, v.product_id, v.size, v.color, v.variant_type]
                    );
                    await client.query(
                        `INSERT INTO stock_movements
                         (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                         VALUES ($1,$2,$3,$4,'order_out',$5,$6,$7,$8,$9,$10)`,
                        [v.product_id, v.size, v.color, v.variant_type, -v.quantity, stockBefore, stockAfter, `Order gratis ${orderCode}`, newOrderId, actor]
                    );
                }
                await client.query(
                    `UPDATE orders SET payment_status = 'paid', order_status = $1, paid_at = NOW(), updated_at = NOW() WHERE id = $2`,
                    [autoStatus, newOrderId]
                );
                // Audit photo step 'payment' tanpa foto — tidak ada bukti bayar untuk order gratis.
                await client.query(
                    `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,'payment',NULL,$2,$3)`,
                    [newOrderId, 'Auto-confirmed: total Rp 0 (bonus/free)', actor]
                );
                // Pickup langsung done → catat audit 'done' juga (konsisten dgn confirm-payment).
                if (autoStatus === 'done') {
                    await client.query(
                        `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,'done',NULL,$2,$3)`,
                        [newOrderId, 'Diambil langsung di event/walk-in', actor]
                    );
                }
            }
            return newOrderId;
        });

        // Rich WA notification for admin (sent AFTER commit — failure here doesn't
        // invalidate the order; just logs and the customer still gets success)
        const itemSummary = itemDetails.map(i => {
            let line = `• ${i.product_name} (${i.color}${i.variant_type && i.variant_type !== 'null' ? ', ' + i.variant_type : ''}, ${i.size}) x${i.quantity}`;
            if (i.is_custom_size) line += ` [Custom]`;
            if (i.is_custom_product) line += ` [Custom Product]`;
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
            // Nama: render baris ke-2 inline kalau ada (mis. "dr. James // Sp.PD").
            // Pakai " // " separator supaya jelas terbaca di WA single-line context.
            const v1 = e.value || '';
            const v2 = (e.value_line2 || '').trim();
            const sep = e.value_underline ? ' | garis pemisah | ' : ' // ';
            return v2 ? `${v1}${sep}${v2}` : v1;
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
            discount_label: discountLabel,
            dp_amount: safeDpAmount
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
            ? await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders', { optimize: true })
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

            // Temporary order (trial/loan) — stock SUDAH terdeduct saat trial dikirim
            // (movement_type='test_out' di POST /api/temp-orders). Confirm-payment di sini
            // hanya finalize status: tagihan diterima, transisi ke pending_return atau done.
            // Skip stock deduction + skip aggregation di bawah.
            const isTrialOrder = order.order_source === 'test_size';

            // Aggregate per physical variant first — bordir splits (plain + nama + logo)
            // share one inventory row, so summing avoids missing the true total demand.
            const variantTotals = new Map();
            if (!isTrialOrder) {
                for (const it of items) {
                    // Custom-size lines have no inventory row → never deduct (and skip the
                    // hard stock check below, which would otherwise throw a false 409).
                    // Pre-Order lines are deferred: stock is allocated/deducted later at
                    // receive (FIFO), not here — so skip them at confirm too.
                    if (it.is_custom_size || it.is_po || it.is_custom_product) continue;
                    const k = `${it.product_id}|${it.size}|${it.color}|${it.variant_type}`;
                    if (!variantTotals.has(k)) variantTotals.set(k, { product_id: it.product_id, size: it.size, color: it.color, variant_type: it.variant_type, quantity: 0 });
                    variantTotals.get(k).quantity += it.quantity;
                }
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

            // ── PO PAID-AFTER-RECEIVE FIX ─────────────────────────────────────
            // Skenario: stok PO datang SEBELUM customer bayar. Endpoint receive
            // cuma fulfill PO yg sudah paid (FIFO), jadi order ini di-skip.
            // Saat customer akhirnya bayar, tanpa block ini, item PO tetap stuck
            // (`is_po=true && po_fulfilled=false`) padahal stok sudah tersedia,
            // gate "Tunggu PO" gak akan lepas. Bug aslinya: 19 Jun 2026, order
            // WS-WA-20260528-9582 Susan — fixed via SQL manual + block ini.
            //
            // Logic: untuk setiap is_po item, kalau stok sekarang ≥ qty → fulfill
            // inline (deduct + mark + log). Kalau belum cukup, biarkan stuck
            // sampai receive berikutnya (FIFO sequence tetap dijaga).
            // Skip trial (gak punya is_po) + custom (manual fulfill via UI).
            if (!isTrialOrder) {
                for (const it of items) {
                    if (!it.is_po || it.po_fulfilled) continue;
                    if (it.is_custom_size || it.is_custom_product) continue;
                    const invPO = await client.query(
                        'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                        [it.product_id, it.size, it.color, it.variant_type]
                    );
                    const poBefore = invPO.rows[0] ? parseInt(invPO.rows[0].stock) : 0;
                    if (poBefore < it.quantity) continue;
                    const poAfter = poBefore - it.quantity;
                    await client.query(
                        'UPDATE inventory SET stock = stock - $1 WHERE product_id=$2 AND size=$3 AND color=$4 AND variant_type=$5',
                        [it.quantity, it.product_id, it.size, it.color, it.variant_type]
                    );
                    await client.query(
                        'UPDATE order_items SET po_fulfilled = TRUE WHERE id = $1',
                        [it.id]
                    );
                    await client.query(
                        `INSERT INTO stock_movements
                         (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                         VALUES ($1,$2,$3,$4,'order_out',$5,$6,$7,$8,$9,$10)`,
                        [it.product_id, it.size, it.color, it.variant_type,
                         -it.quantity, poBefore, poAfter,
                         `PO terpenuhi (paid-after-receive) ${order.order_code}`,
                         order.id, req.user.username]
                    );
                }
            }

            // Determine next status:
            // - Trial order → routing khusus: kalau ada item yg dibalikin → test_pending_return
            //   (admin tunggu fisik barang balik), kalau semua kept → langsung done.
            // - bordir → 'bordir' (perlu proses 1 minggu)
            // - pickup di tempat + no bordir → langsung 'done' (barang sudah diambil
            //   customer di event/walk-in — tak perlu Kemas/Kirim). Audit step 'done'
            //   dicatat utk timeline.
            // - else → 'confirmed' (siap dikemas)
            const hasBordir = order.has_bordir_logo || order.has_bordir_nama;
            const isPickup = (order.shipping_courier || '').trim() === PICKUP_COURIER;
            let ns;
            if (isTrialOrder) {
                const hasReturns = items.some(it => it.is_test_returned === true);
                ns = hasReturns ? 'test_pending_return' : 'done';
            } else {
                ns = hasBordir ? 'bordir' : (isPickup ? 'done' : 'confirmed');
            }
            await client.query(
                `UPDATE orders SET payment_status = 'paid', order_status = $1, paid_at = NOW(), updated_at = NOW() WHERE id = $2`,
                [ns, order.id]
            );
            // Audit record utk timeline kalau langsung done (skip Kemas/Kirim).
            if (ns === 'done') {
                await client.query(
                    `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,'done',NULL,$2,$3)`,
                    [order.id, 'Diambil langsung di event/walk-in', req.user.username]
                );
            }

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
        // Bordir review gate: cuma boleh tandai selesai kalau sudah disetujui.
        // Status lain (pending/rejected/partial_rejected) = bordir tak boleh dimulai/lanjut.
        if (order.bordir_status !== 'approved')
            return res.status(409).json({ error: 'Bordir belum disetujui — review dulu di detail pesanan sebelum tandai selesai.' });
        // Outstanding selisih bordir tambahan harus lunas dulu.
        if (Number(order.additional_amount_due || 0) > 0 && !order.additional_paid_at)
            return res.status(409).json({ error: 'Selisih bordir tambahan belum lunas. Konfirmasi bayar dulu.' });
        // PO katalog unfulfilled guard: bordir fisik tidak bisa dimulai/selesai kalau
        // barang fisik belum lengkap. PO katalog otomatis fulfilled saat receive stok
        // (FIFO, paid-only). Custom_size/custom_product di-fulfill manual via fulfill-po
        // — di sini tidak di-block karena custom dijahit dari nol (terpisah dari proses
        // bordir katalog), jadi bisa parallel.
        const pendingCatPO = await dbGet(
            'SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1 AND is_po = TRUE AND po_fulfilled = FALSE',
            [order.id]
        );
        if (pendingCatPO && pendingCatPO.n > 0)
            return res.status(409).json({ error: 'Ada item Pre-Order menunggu stok masuk — bordir baru bisa selesai setelah barang ready. Tunggu receive stok katalog.' });

        // Photo OPTIONAL (storage saving): admin confirms via checklist. The step record
        // (who + when + note) is still logged for audit — only the image is skipped.
        const photoUrl = req.file ? await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders', { optimize: true }) : null;

        // Pickup courier: skip Kemas/Kirim → langsung 'done' (mirip flow walk-in).
        const isPickup = (order.shipping_courier || '').trim() === PICKUP_COURIER;
        const nextStatus = isPickup ? 'done' : 'confirmed';

        // Atomic: photo record + status transition (+ audit done kalau langsung selesai)
        await withTransaction(async (client) => {
            await client.query(
                `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,$2,$3,$4,$5)`,
                [order.id, 'bordir', photoUrl, req.body.note || '', req.user.username]
            );
            await client.query(
                `UPDATE orders SET order_status = $1, updated_at = NOW() WHERE id = $2`,
                [nextStatus, order.id]
            );
            if (nextStatus === 'done') {
                await client.query(
                    `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,'done',NULL,$2,$3)`,
                    [order.id, 'Bordir selesai → diambil langsung di event/walk-in', req.user.username]
                );
            }
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

        // Bordir guard: order dgn bordir harus sudah disetujui istri sebelum dikemas.
        // Defense-in-depth — frontend gate "Review Bordir Dulu" sudah ada, ini backend safety.
        if ((order.has_bordir_logo || order.has_bordir_nama) && order.bordir_status !== 'approved')
            return res.status(409).json({ error: 'Bordir belum disetujui — review dulu di detail pesanan sebelum kemas.' });

        // Additional bordir (post-payment) guard: kalau ada selisih outstanding, jangan
        // pack — barang sudah ada bordir baru tapi customer belum bayar selisihnya.
        if (Number(order.additional_amount_due || 0) > 0 && !order.additional_paid_at)
            return res.status(409).json({ error: 'Selisih bordir tambahan belum lunas. Konfirmasi bayar dulu dari banner di detail pesanan.' });

        // Pre-Order / Custom guard: an order stays at 'confirmed' until every made-to-order
        // line is ready (po_fulfilled). Catalog PO is fulfilled automatically at receive;
        // custom size is marked ready manually. Block packing/shipping while any line is
        // still waiting — otherwise we'd ship goods we don't have yet.
        const pendingPO = await dbGet(
            'SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1 AND (is_po = TRUE OR is_custom_size = TRUE OR is_custom_product = TRUE) AND po_fulfilled = FALSE',
            [order.id]
        );
        if (pendingPO && pendingPO.n > 0)
            return res.status(409).json({ error: 'Ada item Pre-Order / Custom yang belum siap. Tidak bisa dikemas dulu. PO katalog dipenuhi otomatis saat terima stok; item custom tandai "Siap" dulu di detail pesanan.' });

        // Photo OPTIONAL (storage saving): admin confirms via checklist. Step record still logged.
        const photoUrl = req.file ? await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders', { optimize: true }) : null;

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
        // Gate DP: uang harus masuk penuh sebelum barang keluar. Order DP boleh
        // diproduksi & dikemas, tapi tidak boleh dikirim sampai pelunasan dikonfirmasi.
        if (Number(order.dp_amount || 0) > 0 && !order.dp_settled_at)
            return res.status(400).json({ error: 'Pelunasan DP belum dikonfirmasi. Selesaikan pelunasan sebelum mengirim pesanan.' });

        const finalCourier = courierOverride || order.shipping_courier || 'Kurir';
        // "Kirim sendiri" (antar langsung) tidak punya nomor resi kurir → resi opsional.
        const isSelfDelivery = finalCourier === 'Kirim sendiri';
        if (!tracking && !isSelfDelivery) return res.status(400).json({ error: 'Nomor resi wajib diisi' });

        // Upload before TX (slow external)
        const photoUrl = req.file
            ? await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders', { optimize: true })
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
        // Trial di test_pending_return: customer sudah bayar utk kept items, returned items
        // tinggal dikonfirmasi terima. Cancel di sini ambigu — pakai endpoint receive-returns
        // utk closing yg proper (atau revisi keep/return via flow lain).
        if (order.order_source === 'test_size' && order.order_status === 'test_pending_return')
            return res.status(400).json({ error: 'Trial di status test_pending_return — gunakan "Terima Barang" utk menutup. Cancel di sini akan menabrak record bayar yg sudah masuk.' });
        // Trial flag — restore stock dgn movement 'test_return' (bukan order_cancel_restore)
        // dan skip refund auto-create (trial belum ada pembayaran nyata sampai test_pending_pay paid).
        const isTrialOrder = order.order_source === 'test_size';

        const { cancel_reason, set_bordir_status } = req.body;
        // Audit hook: caller (mis. flow "Tolak Bordir") boleh sekalian set bordir_status
        // jadi 'rejected' supaya alasan struktural pembatalan terekam di kolom yg tepat.
        // Restrict ke nilai valid; kalau dikirim sampah, abaikan (anti-injection).
        const safeBordirStatus = (set_bordir_status === 'rejected' || set_bordir_status === 'pending')
            ? set_bordir_status : null;
        // Optional context attachment (mis. screenshot percakapan dengan customer).
        // NOT a "refund proof" — refund flow is separate via the Refund module.
        // For paid orders, a refund record is auto-created with status='pending' so
        // admin follows up the actual money transfer through that flow.
        const cancelContextUrl = req.file
            ? await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders', { optimize: true })
            : null;

        // Atomic: stock restore (if paid OR trial) + photo + cancel update — all-or-nothing.
        // Trial: stock dipotong di test_sent (sebelum payment), jadi restore dipicu oleh
        // isTrialOrder, BUKAN payment_status. Movement type 'test_return' utk audit clarity.
        await withTransaction(async (client) => {
            const shouldRestoreStock = isTrialOrder || order.payment_status === 'paid';
            if (shouldRestoreStock) {
                const itemsRes = await client.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
                for (const item of itemsRes.rows) {
                    // Custom-size / Custom-Product lines were never deducted at confirm →
                    // nothing to restore (and they have no inventory row; restoring would
                    // just log a bogus ledger entry).
                    if (item.is_custom_size || item.is_custom_product) continue;
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
                    const moveType = isTrialOrder ? 'test_return' : 'order_cancel_restore';
                    const noteTxt = isTrialOrder ? `Trial cancelled ${order.order_code}` : `Pembatalan ${order.order_code}`;
                    await client.query(
                        `INSERT INTO stock_movements
                         (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                        [item.product_id, item.size, item.color, item.variant_type,
                         moveType, item.quantity, stockBefore, stockAfter,
                         noteTxt, order.id, user.username]
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
                `UPDATE orders SET order_status = 'cancelled', cancel_reason = $1, cancelled_by = $2,
                                   bordir_status = COALESCE($3::text, bordir_status),
                                   updated_at = NOW()
                 WHERE id = $4`,
                [cancel_reason || '', user.username, safeBordirStatus, order.id]
            );

            // Auto-create refund entry if order was paid — only if not already exists
            // (defensive: re-cancellation shouldn't duplicate). Refund proof from cancel
            // is the initial proof; admin can mark transferred later with another proof.
            // Trial cancellation di-skip: cancel di trial hanya allowed di test_sent atau
            // test_pending_pay (status 'paid' di-block via guard di atas), jadi payment_status
            // pasti 'pending' — gak ada uang masuk, gak perlu refund record.
            if (order.payment_status === 'paid' && !isTrialOrder) {
                const existing = await client.query(
                    'SELECT id FROM refunds WHERE order_id = $1 AND refund_type = $2',
                    [order.id, 'cancellation']
                );
                if (existing.rows.length === 0) {
                    // Build items summary string for at-a-glance reference
                    const itemsRes = await client.query(
                        `SELECT oi.quantity, oi.size, oi.color, oi.variant_type, COALESCE(oi.custom_product_name, p.name) AS product_name
                         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
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
// PUT /api/orders/:id/edit — admin update data customer & shipping & payment.
// Whitelist: customer_name, customer_phone, customer_address, shipping_city,
// shipping_courier, shipping_weight_kg, shipping_cost, payment_method.
// Tidak edit: items, discount, total_amount (auto-recompute kalau shipping_cost berubah).
// Blok: cancelled / done / shipped (sudah keluar fisik). Items & total tidak diubah.
app.put('/api/orders/:id/edit', requireMenu('orders','edit'), upload.none(), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (['cancelled','done','shipped'].includes(order.order_status))
            return res.status(400).json({ error: 'Pesanan ini tidak bisa diedit (sudah dibatalkan/dikirim/selesai)' });

        const {
            customer_name, customer_phone, customer_address,
            shipping_city, shipping_courier, shipping_weight_kg,
            shipping_cost, payment_method,
            order_source, billing_to, notes, invoice_notes
        } = req.body;

        const setClauses = [];
        const params = [];
        let idx = 1;

        // Customer name — required if provided
        if (customer_name !== undefined) {
            const v = String(customer_name).trim();
            if (!v) return res.status(400).json({ error: 'Nama tidak boleh kosong' });
            setClauses.push(`customer_name = $${idx++}`); params.push(v);
        }
        // Customer phone — format Indonesia (08xxx/62xxx/8xxx), 9–15 digit
        if (customer_phone !== undefined) {
            const digits = String(customer_phone).replace(/\D/g, '');
            if (digits.length < 9 || digits.length > 15 || !/^(0|62|8)/.test(digits))
                return res.status(400).json({ error: 'Nomor WhatsApp tidak valid (gunakan format 08xxx / 62xxx)' });
            setClauses.push(`customer_phone = $${idx++}`); params.push(String(customer_phone).trim());
        }
        // Customer address — required if provided
        if (customer_address !== undefined) {
            const v = String(customer_address).trim();
            if (!v) return res.status(400).json({ error: 'Alamat tidak boleh kosong' });
            setClauses.push(`customer_address = $${idx++}`); params.push(v);
        }
        // Payment method — whitelist (same as POST /orders)
        if (payment_method !== undefined) {
            const ALLOWED_PAYMENT = ['Transfer BCA / Mandiri','BCA','BRI','Mandiri','BNI','QRIS','Cash','Bonus/Free','bank_transfer','qris'];
            const safe = ALLOWED_PAYMENT.includes(payment_method) ? payment_method : '';
            setClauses.push(`payment_method = $${idx++}`); params.push(safe);
        }
        // Shipping fields — admin trusted (sama spt POST). Validate city ada di CITIES kalau diisi.
        if (shipping_city !== undefined) {
            const v = String(shipping_city).trim();
            // Allow empty (defensive) atau kota valid
            if (v && !CITIES.find(c => c.name === v))
                return res.status(400).json({ error: `Kota '${v}' tidak ada di daftar` });
            setClauses.push(`shipping_city = $${idx++}`); params.push(v);
        }
        if (shipping_courier !== undefined) {
            setClauses.push(`shipping_courier = $${idx++}`); params.push(sanitizeCourier(shipping_courier));
        }
        if (shipping_weight_kg !== undefined) {
            const w = parseFloat(shipping_weight_kg);
            if (!(w >= 0)) return res.status(400).json({ error: 'Berat tidak valid' });
            setClauses.push(`shipping_weight_kg = $${idx++}`); params.push(w);
        }
        // Shipping cost — admin sets manually. Kalau berubah, recompute total_amount
        // deterministically: total_baru = total_lama - ongkir_lama + ongkir_baru.
        // (Subtotal produk & diskon tidak terganggu — itu cara aman supaya tak ada
        // drift dari edit berulang vs sumber kebenaran items.)
        let newShippingCost = null;
        if (shipping_cost !== undefined) {
            const c = parseInt(shipping_cost);
            if (!(c >= 0)) return res.status(400).json({ error: 'Ongkir tidak valid' });
            newShippingCost = c;
            setClauses.push(`shipping_cost = $${idx++}`); params.push(c);
            const newTotal = Number(order.total_amount) - Number(order.shipping_cost) + c;
            setClauses.push(`total_amount = $${idx++}`); params.push(newTotal);
        }

        // Order source — whitelist same as POST (admin-only sources). 'website' tetap allowed
        // sbg fallback walaupun secara normal cuma diset utk order publik via checkout — admin
        // boleh re-tag manual kalau perlu. Kalau ganti AWAY dari collaboration_event, billing_to
        // diset NULL otomatis utk konsistensi (kolom itu cuma relevan utk collab).
        let sourceChangedAwayFromCollab = false;
        if (order_source !== undefined) {
            const ALLOWED_SOURCES = ['website','whatsapp','event_offline','offline','collaboration_event'];
            if (!ALLOWED_SOURCES.includes(order_source))
                return res.status(400).json({ error: 'Sumber order tidak valid' });
            setClauses.push(`order_source = $${idx++}`); params.push(order_source);
            if (order.order_source === 'collaboration_event' && order_source !== 'collaboration_event')
                sourceChangedAwayFromCollab = true;
        }
        // billing_to — relevan hanya kalau order_source effektif = collaboration_event.
        // Effective source = nilai baru kalau dikirim, else nilai lama.
        const effectiveSource = order_source !== undefined ? order_source : order.order_source;
        if (billing_to !== undefined) {
            if (effectiveSource === 'collaboration_event') {
                const v = String(billing_to).trim();
                if (!v) return res.status(400).json({ error: 'Bill To (Partner) wajib diisi untuk Collaboration Event' });
                setClauses.push(`billing_to = $${idx++}`); params.push(v.slice(0, 120));
            } else {
                // Source bukan collab tapi admin coba isi billing_to → tolak biar konsisten.
                setClauses.push(`billing_to = $${idx++}`); params.push(null);
            }
        } else if (sourceChangedAwayFromCollab) {
            // Source di-switch keluar dari collab tanpa kirim billing_to → bersihkan otomatis.
            setClauses.push(`billing_to = $${idx++}`); params.push(null);
        }
        // Notes — bebas teks, batasi panjang anti-abuse.
        if (notes !== undefined) {
            setClauses.push(`notes = $${idx++}`); params.push(String(notes).slice(0, 1000));
        }
        // invoice_notes: catatan customer-facing untuk PDF invoice. Empty string
        // → NULL (biar invoice tidak render section kosong). Max 500 char.
        if (invoice_notes !== undefined) {
            const trimmed = String(invoice_notes).trim().slice(0, 500);
            setClauses.push(`invoice_notes = $${idx++}`); params.push(trimmed || null);
        }

        if (setClauses.length === 0)
            return res.status(400).json({ error: 'Tidak ada perubahan' });

        setClauses.push(`updated_at = NOW()`);
        params.push(req.params.id);
        await dbRun(`UPDATE orders SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);

        const updated = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        res.json({ message: 'Pesanan diperbarui', order: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orders/:id/split — Pisahkan order jadi 2 berdasar items terpilih.
// Use case utama: event mixed ambil+kirim. Sebagian item diambil langsung
// (kurir "Diambil di Event", ongkir 0), sisanya tetap pakai kurir asli (dikirim).
//
// Desain:
// - Original RETAINED (bukan cancelled). Items subset di-move ke child via
//   UPDATE order_id. Lebih bersih dari "cancel + buat 2 baru" karena tidak
//   trigger refund auto kalau paid, dan tracking customer tetap satu titik.
// - Child = order baru. Copy semua data customer + payment context. Order code
//   baru via generateOrderCode (pakai source asli).
// - Diskon dibagi PROPORTIONAL ke subtotal items masing-masing pihak.
// - Stok tidak disentuh — item moved, alokasi stok sudah benar (dilakukan saat
//   confirm-payment original).
// - has_bordir_*/bordir_status recompute per pihak berdasar items aktualnya.
// - Embroidery_details COPY ke child (tidak split per item_label — MVP sederhana;
//   admin lihat array yg sama, UI tetap render item_label-aware).
// - Notes append "[Dipisah dari/jadi #X]" di kedua sisi untuk audit trail.
app.post('/api/orders/:id/split', requireMenu('orders','edit'), upload.none(), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (['cancelled','done','shipped'].includes(order.order_status))
            return res.status(400).json({ error: 'Pesanan ini tidak bisa dipisah (sudah dikirim/dibatalkan/selesai)' });

        let { item_ids } = req.body;
        const { new_courier, new_shipping_cost, new_weight_kg, new_shipping_city } = req.body;

        // Multer .none() parse FormData multi-value → string[]. JSON body bisa array langsung.
        // Defensive: terima string single, comma-string, atau array.
        if (typeof item_ids === 'string') item_ids = item_ids.split(',').map(s => s.trim()).filter(Boolean);
        if (!Array.isArray(item_ids) || item_ids.length === 0)
            return res.status(400).json({ error: 'Pilih minimal 1 item untuk dipindah ke pesanan baru' });
        const moveIds = item_ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
        if (moveIds.length === 0)
            return res.status(400).json({ error: 'item_ids tidak valid' });

        // Ambil items & pastikan yang dipilih benar-benar punya order ini (anti-tamper).
        const allItems = await dbAll('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
        const moveSet = new Set(moveIds);
        const movingItems = allItems.filter(i => moveSet.has(Number(i.id)));
        const stayingItems = allItems.filter(i => !moveSet.has(Number(i.id)));
        if (movingItems.length !== moveIds.length)
            return res.status(400).json({ error: 'Sebagian item yang dipilih bukan dari pesanan ini' });
        if (movingItems.length === 0)
            return res.status(400).json({ error: 'Tidak ada item yang dipindah' });
        if (stayingItems.length === 0)
            return res.status(400).json({ error: 'Tidak boleh memindah SEMUA item — minimal sisakan 1 di pesanan asli' });

        // Subtotal per pihak (harga × qty). price sudah include bordir cost karena
        // di POST orders kita simpan unitPrice = basePrice + embroidery_cost.
        const sumSubtotal = (items) => items.reduce((s, i) => s + (Number(i.price) * Number(i.quantity)), 0);
        const movingSubtotal = sumSubtotal(movingItems);
        const stayingSubtotal = sumSubtotal(stayingItems);
        const totalSubtotal = movingSubtotal + stayingSubtotal;

        // Proportional discount: split berdasar share subtotal. Pembulatan: child ambil
        // round, sisanya ke original supaya sum tetap = total diskon asli (no drift).
        const originalDiscount = Number(order.discount_amount || 0);
        const movingDiscount = totalSubtotal > 0 ? Math.round(originalDiscount * movingSubtotal / totalSubtotal) : 0;
        const stayingDiscount = originalDiscount - movingDiscount;

        // Child shipping params (admin set, defaults aman).
        const childCourier = (new_courier && String(new_courier).trim()) || 'Diambil di Event';
        const childShippingCost = Number.isFinite(parseInt(new_shipping_cost)) ? Math.max(0, parseInt(new_shipping_cost)) : 0;
        const childWeight = Number.isFinite(parseFloat(new_weight_kg)) ? Math.max(0, parseFloat(new_weight_kg)) : 0;
        const childCity = new_shipping_city !== undefined ? String(new_shipping_city).trim() : (order.shipping_city || '');

        // Bordir flags recompute per pihak.
        const childHasBordirLogo = movingItems.some(i => i.bordir_logo);
        const childHasBordirNama = movingItems.some(i => i.bordir_nama);
        const stayingHasBordirLogo = stayingItems.some(i => i.bordir_logo);
        const stayingHasBordirNama = stayingItems.some(i => i.bordir_nama);

        // Filter embroidery_details per pihak berdasar item_label. Sebelumnya copy mentah
        // → kedua order tampilkan instruksi bordir milik item yg sudah pindah (admin
        // bingung, salah kirim instruksi ke pihak bordir). Item label format dari saat
        // create order: `${product_name} (${color}, ${size})`. Untuk item_label duplicate
        // (kalau 2 item identik product+color+size, edge case rare), entry copy ke kedua
        // sisi — over-include defensive, admin manual cek di UI.
        const allEmbroidery = safeJSON(order.embroidery_details, []);
        const allEmbroideryArr = Array.isArray(allEmbroidery) ? allEmbroidery : [];
        // Butuh product_name utk rebuild label. Fetch sekali.
        const itemsWithName = await dbAll(
            `SELECT oi.id, oi.color, oi.size, COALESCE(oi.custom_product_name, p.name) AS product_name FROM order_items oi
             LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
            [order.id]
        );
        const labelById = new Map(itemsWithName.map(i => [
            Number(i.id),
            `${i.product_name} (${i.color || '-'}, ${i.size || '-'})`
        ]));
        const movingLabels = new Set(movingItems.map(i => labelById.get(Number(i.id))).filter(Boolean));
        const stayingLabels = new Set(stayingItems.map(i => labelById.get(Number(i.id))).filter(Boolean));
        const movingEmbroidery = allEmbroideryArr.filter(e => movingLabels.has(e.item_label));
        const stayingEmbroidery = allEmbroideryArr.filter(e => stayingLabels.has(e.item_label));

        // Total per pihak.
        const childTotal = movingSubtotal - movingDiscount + childShippingCost;
        const stayingTotal = stayingSubtotal - stayingDiscount + Number(order.shipping_cost || 0);

        // Pickup auto-skip untuk child: konsisten dgn confirm-payment/bordir-done logic.
        // Kalau child courier pickup + no bordir + paid → langsung 'done'.
        const childIsPickup = childCourier === PICKUP_COURIER;
        const childChildOrderStatus = (childIsPickup && !childHasBordirLogo && !childHasBordirNama && order.payment_status === 'paid')
            ? 'done'
            : order.order_status;

        const childOrderCode = generateOrderCode(order.order_source);
        const childNote = ((order.notes || '').trim() + (order.notes ? '\n' : '') + `[Dipisah dari #${order.order_code}]`).trim();
        const stayingNote = ((order.notes || '').trim() + (order.notes ? '\n' : '') + `[Dipisah jadi #${childOrderCode}]`).trim();

        const newOrderId = await withTransaction(async (client) => {
            // 1. Insert child — copy customer & payment context dari original
            const childRes = await client.query(`
                INSERT INTO orders (
                    order_code, customer_name, customer_phone, customer_address,
                    shipping_city, shipping_courier, shipping_weight_kg, shipping_cost, total_amount,
                    embroidery_details, has_bordir_logo, has_bordir_nama, bordir_status,
                    notes, order_source, payment_method, payment_status, order_status,
                    discount_percent, discount_amount, discount_label, bordir_logo_requested,
                    billing_to, paid_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
                RETURNING id`,
                [
                    childOrderCode, order.customer_name, order.customer_phone, order.customer_address,
                    childCity, childCourier, childWeight, childShippingCost, childTotal,
                    JSON.stringify(movingEmbroidery),
                    childHasBordirLogo, childHasBordirNama,
                    (childHasBordirLogo || childHasBordirNama) ? (order.bordir_status || 'pending') : null,
                    childNote, order.order_source, order.payment_method, order.payment_status, childChildOrderStatus,
                    order.discount_percent || 0, movingDiscount, order.discount_label, order.bordir_logo_requested,
                    order.billing_to, order.paid_at
                ]
            );
            const newId = childRes.rows[0].id;

            // Pickup auto-skip: catat audit step 'done' supaya timeline konsisten dgn
            // confirm-payment pickup path.
            if (childChildOrderStatus === 'done') {
                await client.query(
                    `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,'done',NULL,$2,$3)`,
                    [newId, 'Hasil split → diambil langsung di event/walk-in', req.user.username]
                );
            }

            // 2. Re-parent items terpilih ke child
            await client.query(
                `UPDATE order_items SET order_id = $1 WHERE order_id = $2 AND id = ANY($3::int[])`,
                [newId, order.id, moveIds]
            );

            // 3. Update original: subtotal, diskon, bordir flags, embroidery filtered, notes
            await client.query(`
                UPDATE orders SET
                    total_amount = $1,
                    discount_amount = $2,
                    has_bordir_logo = $3,
                    has_bordir_nama = $4,
                    bordir_status = CASE WHEN ($3 OR $4) THEN COALESCE(bordir_status, 'pending') ELSE NULL END,
                    embroidery_details = $5,
                    notes = $6,
                    updated_at = NOW()
                WHERE id = $7`,
                [stayingTotal, stayingDiscount, stayingHasBordirLogo, stayingHasBordirNama,
                 JSON.stringify(stayingEmbroidery), stayingNote, order.id]
            );

            return newId;
        });

        res.json({
            message: 'Pesanan berhasil dipisah',
            new_order_id: newOrderId,
            new_order_code: childOrderCode,
            original_new_total: stayingTotal,
            child_total: childTotal
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orders/:id/add-bordir — Tambah bordir SETELAH order dibayar
// (customer berubah pikiran). Hanya untuk item yg BELUM ada bordir (rule bisnis:
// 1 nama + 1 logo per baju, kalau slot sudah terisi → order baru).
//
// Body JSON: { items: [{ item_id, bordir_nama?, nama_text?, nama_color?, nama_pos?,
//             nama_price?, bordir_logo?, logo_color?, logo_pos?, logo_price? }] }
//
// Efek:
// - Update order_items: set bordir_nama/_logo flags + per-item prices
// - Append entries ke embroidery_details (tak ganggu entri lama)
// - has_bordir_logo/_nama re-derived dari semua items
// - additional_amount_due += sum(harga bordir baru × qty)
// - total_amount += additional (nilai final, tampil di invoice/laporan)
// - bordir_status = 'pending' (admin review lagi setelah selisih lunas)
// - Audit note: append "[Tambah bordir post-payment: Rp X]"
app.post('/api/orders/:id/add-bordir', requireMenu('orders','edit'), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.payment_status !== 'paid')
            return res.status(400).json({ error: 'Pesanan ini belum dibayar — gunakan Edit Pesanan biasa kalau mau ubah bordir.' });
        if (['shipped','done','cancelled','packed'].includes(order.order_status))
            return res.status(400).json({ error: 'Pesanan ini tidak bisa ditambah bordir (sudah dikemas/dikirim/selesai/dibatalkan)' });

        const { items: bordirRequests } = req.body;
        if (!Array.isArray(bordirRequests) || bordirRequests.length === 0)
            return res.status(400).json({ error: 'Pilih minimal 1 item untuk ditambah bordir' });

        // Fetch existing items + product names (utk item_label rebuild)
        const orderItems = await dbAll(
            `SELECT oi.*, COALESCE(oi.custom_product_name, p.name) AS product_name FROM order_items oi
             LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
            [order.id]
        );
        const itemMap = new Map(orderItems.map(i => [Number(i.id), i]));

        // Validate each requested item
        const newEntries = []; // utk append ke embroidery_details
        let totalAdditional = 0;
        const itemUpdates = []; // [{id, nama?, namaPrice?, logo?, logoPrice?}]

        for (const r of bordirRequests) {
            const item = itemMap.get(Number(r.item_id));
            if (!item) return res.status(400).json({ error: `Item ID ${r.item_id} bukan dari pesanan ini` });
            if (item.bordir_nama || item.bordir_logo)
                return res.status(400).json({ error: `Item "${item.product_name}" sudah punya bordir — tidak bisa ditambah lagi (1 nama + 1 logo per baju). Kalau perlu, buat order baru.` });
            const wantNama = !!r.bordir_nama;
            const wantLogo = !!r.bordir_logo;
            if (!wantNama && !wantLogo)
                return res.status(400).json({ error: `Item "${item.product_name}": pilih minimal 1 (nama / logo)` });
            // Validate nama detail
            let namaPrice = 0;
            if (wantNama) {
                const t = String(r.nama_text || '').trim();
                if (!t) return res.status(400).json({ error: `Item "${item.product_name}": isi teks nama bordir` });
                namaPrice = parseInt(r.nama_price);
                if (!(Number.isInteger(namaPrice) && namaPrice >= 0))
                    return res.status(400).json({ error: `Item "${item.product_name}": harga bordir nama tidak valid` });
            }
            // Validate logo detail
            let logoPrice = 0;
            if (wantLogo) {
                logoPrice = parseInt(r.logo_price);
                if (!(Number.isInteger(logoPrice) && logoPrice >= 0))
                    return res.status(400).json({ error: `Item "${item.product_name}": harga bordir logo tidak valid` });
            }
            // Posisi must differ kalau both
            if (wantNama && wantLogo) {
                const np = r.nama_pos || 'kanan';
                const lp = r.logo_pos || 'kiri';
                if (np === lp) return res.status(400).json({ error: `Item "${item.product_name}": posisi nama & logo tidak boleh sama` });
            }

            const itemLabel = `${item.product_name} (${item.color || '-'}, ${item.size || '-'})`;
            // Variant disimpan di entry bordir — itemLabel tidak memuatnya, padahal
            // size sama bisa beda variant (Lengan Pendek vs Panjang) dan tim produksi
            // butuh tahu potong mana. Additive: itemLabel tidak berubah, matching
            // bordir↔item di invoice/Format Order tetap seperti semula.
            const itemVariant = (item.variant_type && item.variant_type !== 'null')
                ? String(item.variant_type).trim() : '';
            if (wantNama) {
                // Baris ke-2 opsional. Disimpan sebagai field `value_line2` di JSON kalau ada.
                // Renderer graceful: kalau absent → render 1 baris seperti dulu.
                const t2 = String(r.nama_text2 || '').trim();
                const entry = {
                    type: 'nama',
                    item_label: itemLabel,
                    value: String(r.nama_text).trim(),
                    color: String(r.nama_color || '').trim(),
                    position: r.nama_pos || 'kanan'
                };
                if (t2) entry.value_line2 = t2;
                // Garis pemisah opsional di antara baris 1 & baris 2 (visual mockup).
                if (r.nama_underline === true) entry.value_underline = true;
                if (itemVariant) entry.variant_type = itemVariant;
                newEntries.push(entry);
                totalAdditional += namaPrice * Number(item.quantity);
            }
            if (wantLogo) {
                // logo_data opsional — admin bisa upload file di modal (base64 dataURL)
                // atau kosongkan (placeholder 'Logo dikirim via WA' — file diminta via WA).
                // externalizeEmbroideryLogos akan upload base64 → Supabase Storage saat save.
                const logoData = typeof r.logo_data === 'string' && r.logo_data.startsWith('data:image/')
                    ? r.logo_data
                    : 'Logo dikirim via WA';
                const logoEntry = {
                    type: 'logo',
                    item_label: itemLabel,
                    value: logoData,
                    color: String(r.logo_color || '').trim(),
                    position: r.logo_pos || 'kiri'
                };
                if (itemVariant) logoEntry.variant_type = itemVariant;
                newEntries.push(logoEntry);
                totalAdditional += logoPrice * Number(item.quantity);
            }
            itemUpdates.push({
                id: item.id,
                bordir_nama: wantNama, bordir_nama_price: wantNama ? namaPrice : null,
                bordir_logo: wantLogo, bordir_logo_price: wantLogo ? logoPrice : null
            });
        }

        if (totalAdditional <= 0)
            return res.status(400).json({ error: 'Total harga bordir tambahan harus > 0' });

        // Rebuild embroidery_details: keep yg lama + append baru.
        // Externalize base64 logo dataURL → Supabase Storage (anti DB bloat, mirror
        // POST /api/orders behavior). Yg gagal upload di-fallback ke base64 (never block).
        const existingEntries = safeJSON(order.embroidery_details, []);
        const newEntriesStored = await externalizeEmbroideryLogos(newEntries);
        const mergedEntries = [...(Array.isArray(existingEntries) ? existingEntries : []), ...newEntriesStored];

        const newHasNama = order.has_bordir_nama || newEntries.some(e => e.type === 'nama');
        const newHasLogo = order.has_bordir_logo || newEntries.some(e => e.type === 'logo');
        const newTotalAmount = Number(order.total_amount) + totalAdditional;
        const newAdditionalDue = Number(order.additional_amount_due || 0) + totalAdditional;
        const auditNote = ((order.notes || '').trim() + (order.notes ? '\n' : '') +
            `[Tambah bordir post-payment: Rp ${totalAdditional.toLocaleString('id-ID')}]`).trim();

        await withTransaction(async (client) => {
            // Update each item
            for (const u of itemUpdates) {
                await client.query(
                    `UPDATE order_items SET
                        bordir_nama = COALESCE($1, bordir_nama),
                        bordir_nama_price = COALESCE($2, bordir_nama_price),
                        bordir_logo = COALESCE($3, bordir_logo),
                        bordir_logo_price = COALESCE($4, bordir_logo_price),
                        price = price + $5
                     WHERE id = $6`,
                    [u.bordir_nama ? true : null,
                     u.bordir_nama_price,
                     u.bordir_logo ? true : null,
                     u.bordir_logo_price,
                     (u.bordir_nama_price || 0) + (u.bordir_logo_price || 0),
                     u.id]
                );
            }
            // Update order — reset order_status ke 'bordir' supaya tombol "Tandai Bordir
            // Selesai" muncul dan alur konsisten dgn flow normal (order dgn bordir =
            // status 'bordir' sampai istri tandai selesai). Kalau sudah 'bordir', stay.
            await client.query(
                `UPDATE orders SET
                    embroidery_details = $1,
                    has_bordir_nama = $2,
                    has_bordir_logo = $3,
                    bordir_status = 'pending',
                    order_status = 'bordir',
                    total_amount = $4,
                    additional_amount_due = $5,
                    additional_paid_at = NULL,
                    notes = $6,
                    updated_at = NOW()
                 WHERE id = $7`,
                [JSON.stringify(mergedEntries), newHasNama, newHasLogo,
                 newTotalAmount, newAdditionalDue, auditNote, order.id]
            );
        });

        res.json({
            message: 'Bordir tambahan dicatat',
            additional_amount_due: newAdditionalDue,
            new_total_amount: newTotalAmount
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/confirm-additional-payment — admin upload bukti bayar selisih
// dari customer (tambah bordir). Set additional_paid_at, catat audit photo.
app.put('/api/orders/:id/confirm-additional-payment', requireMenu('orders','edit'), upload.single('payment_proof'), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (!order.additional_amount_due || Number(order.additional_amount_due) <= 0)
            return res.status(400).json({ error: 'Pesanan ini tidak punya tagihan bordir tambahan' });
        if (order.additional_paid_at)
            return res.status(400).json({ error: 'Selisih bordir sudah dikonfirmasi sebelumnya' });
        if (!req.file)
            return res.status(400).json({ error: 'Upload bukti pembayaran selisih dulu' });

        const photoUrl = await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders', { optimize: true });

        await withTransaction(async (client) => {
            await client.query(
                `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by)
                 VALUES ($1, 'payment', $2, $3, $4)`,
                [order.id, photoUrl,
                 `Pembayaran selisih bordir Rp ${Number(order.additional_amount_due).toLocaleString('id-ID')}`,
                 req.user.username]
            );
            await client.query(
                `UPDATE orders SET additional_paid_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [order.id]
            );
        });

        res.json({ message: 'Pembayaran selisih dikonfirmasi', photo_url: await signedMediaUrl(photoUrl) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/settle-dp — pelunasan sisa DP. Admin boleh menyesuaikan ongkir
// final (real ongkir sering beda dari estimasi) → total + sisa dihitung ulang, lalu
// order ditandai lunas (dp_settled_at). Baru setelah ini order boleh dikirim.
app.put('/api/orders/:id/settle-dp', requireMenu('orders','edit'), upload.single('payment_proof'), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (!(Number(order.dp_amount || 0) > 0))
            return res.status(400).json({ error: 'Pesanan ini bukan pesanan DP' });
        if (order.payment_status !== 'paid')
            return res.status(400).json({ error: 'DP belum dikonfirmasi. Konfirmasi pembayaran DP dulu.' });
        if (order.dp_settled_at)
            return res.status(400).json({ error: 'Pesanan ini sudah lunas' });
        if (order.order_status === 'cancelled')
            return res.status(400).json({ error: 'Pesanan sudah dibatalkan' });
        if (!req.file)
            return res.status(400).json({ error: 'Upload bukti pelunasan dulu' });

        // Ongkir final opsional. Kalau diisi & beda → recompute total (bisa naik/turun).
        const oldShipping = Number(order.shipping_cost || 0);
        const rawFinalShip = req.body.final_shipping_cost;
        const hasFinalShip = rawFinalShip !== undefined && String(rawFinalShip).trim() !== '' && !isNaN(parseInt(rawFinalShip));
        const finalShipping = hasFinalShip ? Math.max(0, parseInt(rawFinalShip)) : oldShipping;
        const shippingChanged = finalShipping !== oldShipping;
        const oldTotal = Number(order.total_amount || 0);
        const newTotal = oldTotal - oldShipping + finalShipping;
        const dp = Number(order.dp_amount || 0);
        const remaining = Math.max(0, newTotal - dp);
        const overpay = Math.max(0, dp - newTotal);

        const photoUrl = await uploadToSupabase(req.file.buffer, req.file.originalname, 'orders', { optimize: true });

        await withTransaction(async (client) => {
            if (shippingChanged) {
                await client.query(
                    `UPDATE orders SET shipping_cost = $1, total_amount = $2, updated_at = NOW() WHERE id = $3`,
                    [finalShipping, newTotal, order.id]
                );
            }
            let note = `Pelunasan DP. Sisa dibayar Rp ${remaining.toLocaleString('id-ID')}`;
            if (shippingChanged) note += ` (ongkir final Rp ${finalShipping.toLocaleString('id-ID')}, estimasi awal Rp ${oldShipping.toLocaleString('id-ID')})`;
            if (overpay > 0) note += `. Kelebihan bayar Rp ${overpay.toLocaleString('id-ID')} — perlu refund manual`;
            await client.query(
                `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,'payment',$2,$3,$4)`,
                [order.id, photoUrl, note, req.user.username]
            );
            await client.query(
                `UPDATE orders SET dp_settled_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [order.id]
            );
        });

        res.json({
            message: 'Pelunasan dikonfirmasi',
            remaining, overpay,
            total_amount: newTotal,
            shipping_cost: finalShipping,
            shipping_changed: shippingChanged,
            photo_url: await signedMediaUrl(photoUrl)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/finalize-shipping — set ongkir final (real) SEBELUM pelunasan.
// Real ongkir sering beda dari estimasi. Endpoint ini update shipping_cost + total
// supaya invoice + WA tagihan yang dikirim ke customer pakai angka real. BELUM
// menandai lunas (dp_settled_at tetap NULL) — customer bayar dulu, baru pelunasan
// dikonfirmasi via /settle-dp. Boleh dipanggil berkali-kali (re-adjust).
app.put('/api/orders/:id/finalize-shipping', requireMenu('orders','edit'), upload.none(), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (!(Number(order.dp_amount || 0) > 0))
            return res.status(400).json({ error: 'Pesanan ini bukan pesanan DP' });
        if (order.payment_status !== 'paid')
            return res.status(400).json({ error: 'DP belum dikonfirmasi. Konfirmasi pembayaran DP dulu.' });
        if (order.dp_settled_at)
            return res.status(400).json({ error: 'Pesanan sudah lunas' });
        if (order.order_status === 'cancelled')
            return res.status(400).json({ error: 'Pesanan sudah dibatalkan' });

        const raw = req.body.final_shipping_cost;
        if (raw === undefined || String(raw).trim() === '' || isNaN(parseInt(raw)))
            return res.status(400).json({ error: 'Ongkir final wajib diisi (angka)' });
        const finalShipping = Math.max(0, parseInt(raw));
        const oldShipping = Number(order.shipping_cost || 0);
        const oldTotal = Number(order.total_amount || 0);
        const newTotal = oldTotal - oldShipping + finalShipping;
        const dp = Number(order.dp_amount || 0);
        const remaining = Math.max(0, newTotal - dp);
        const overpay = Math.max(0, dp - newTotal);
        const changed = finalShipping !== oldShipping;

        if (changed) {
            await withTransaction(async (client) => {
                await client.query(
                    `UPDATE orders SET shipping_cost = $1, total_amount = $2, updated_at = NOW() WHERE id = $3`,
                    [finalShipping, newTotal, order.id]
                );
                let note = `Ongkir final disesuaikan: Rp ${finalShipping.toLocaleString('id-ID')} (estimasi awal Rp ${oldShipping.toLocaleString('id-ID')}). Sisa pelunasan jadi Rp ${remaining.toLocaleString('id-ID')}`;
                if (overpay > 0) note += `. Kelebihan bayar Rp ${overpay.toLocaleString('id-ID')} — perlu refund manual`;
                await client.query(
                    `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,'payment',NULL,$2,$3)`,
                    [order.id, note, req.user.username]
                );
            });
        }

        res.json({ message: 'Ongkir final tersimpan', total_amount: newTotal, shipping_cost: finalShipping, remaining, overpay, changed });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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

        const proofUrl = await uploadToSupabase(req.file.buffer, req.file.originalname, 'refunds', { optimize: true });
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
        // Off-catalog items (custom_product: product_id NULL, no catalog row; custom_size:
        // size like 4XL not in inventory) tidak punya stok katalog untuk di-swap. Tolak
        // di sini supaya error message jelas (bukan FK/constraint 500 dari INSERT/approve).
        if (item.is_custom_product || item.is_custom_size)
            return res.status(400).json({ error: 'Item custom (custom product / custom size) tidak bisa tukar size — tidak ada stok katalog untuk dipakai sebagai pengganti.' });
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

// PUT /api/orders/:id/embroidery/:index — edit SATU entry bordir (nama / logo)
// sebelum barang dikemas. Client sering ubah nama/gelar/logo. Body (nama):
// { value, value_line2, value_underline, color, position }. Logo: { color, position }
// + optional file 'logo_file' (ganti gambar). Karena isi bordir berubah → reset
// bordir_status ke 'pending' (perlu review ulang, keputusan James). Tidak sentuh stok.
app.put('/api/orders/:id/embroidery/:index', requireMenu('orders','edit'), upload.single('logo_file'), async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [req.params.id]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        // Gate: boleh edit selama BELUM dikemas (keputusan James). Sekali packed,
        // baju sudah dibordir & dibungkus → edit tak masuk akal.
        if (['packed','shipped','done','cancelled'].includes(order.order_status))
            return res.status(400).json({ error: 'Bordir tidak bisa diedit — pesanan sudah dikemas/dikirim/selesai/dibatalkan.' });

        let arr = [];
        try { arr = order.embroidery_details ? (typeof order.embroidery_details === 'string' ? JSON.parse(order.embroidery_details) : order.embroidery_details) : []; } catch (e) {}
        const idx = parseInt(req.params.index, 10);
        if (!Array.isArray(arr) || !Number.isInteger(idx) || idx < 0 || idx >= arr.length)
            return res.status(400).json({ error: 'Entry bordir tidak ditemukan' });

        const entry = { ...arr[idx] };
        const posIn = String(req.body.position || '').trim().toLowerCase();
        const validPos = ['kanan', 'kiri'].includes(posIn) ? posIn : entry.position;

        if (entry.type === 'nama') {
            const val = String(req.body.value || '').trim();
            if (!val) return res.status(400).json({ error: 'Teks nama wajib diisi' });
            entry.value = val;
            const line2 = String(req.body.value_line2 || '').trim();
            if (line2) entry.value_line2 = line2; else delete entry.value_line2;      // anti-noise
            const underline = req.body.value_underline === 'true' || req.body.value_underline === true;
            if (underline) entry.value_underline = true; else delete entry.value_underline;
            entry.color = String(req.body.color || '').trim();
            entry.position = validPos;
        } else if (entry.type === 'logo') {
            entry.color = String(req.body.color || '').trim();
            entry.position = validPos;
            if (req.file) {
                // Ganti gambar: set base64 lalu externalize (upload ke Storage) di bawah.
                entry.value = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
            }
        } else {
            return res.status(400).json({ error: 'Tipe bordir tidak dikenal' });
        }

        arr[idx] = entry;
        const stored = await externalizeEmbroideryLogos(arr);   // upload logo base64 → URL

        await withTransaction(async (client) => {
            await client.query(
                `UPDATE orders SET embroidery_details = $1, updated_at = NOW() WHERE id = $2`,
                [JSON.stringify(stored), order.id]
            );
            // Isi bordir berubah → approval lama basi, reset ke 'pending' utk review ulang.
            if (order.bordir_status && order.bordir_status !== 'pending') {
                await client.query(`UPDATE orders SET bordir_status = 'pending' WHERE id = $1`, [order.id]);
            }
            await client.query(
                `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1,'bordir',NULL,$2,$3)`,
                [order.id, `Edit bordir ${entry.type} (${entry.item_label || '-'})${order.bordir_status === 'approved' ? ' — approval di-reset ke pending' : ''}`, req.user.username]
            );
        });
        res.json({ message: `Bordir ${entry.type} diperbarui${order.bordir_status === 'approved' ? ' — perlu review ulang' : ''}` });
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
        if (!item.is_custom_size && !item.is_custom_product)
            return res.status(400).json({ error: 'Hanya item Custom yang ditandai siap manual. PO katalog dipenuhi otomatis saat terima stok.' });
        if (item.po_fulfilled)
            return res.status(400).json({ error: 'Item ini sudah ditandai siap' });

        await dbRun('UPDATE order_items SET po_fulfilled = TRUE WHERE id = $1', [item.id]);
        await dbRun('UPDATE orders SET updated_at = NOW() WHERE id = $1', [order.id]);
        res.json({ message: 'Item custom ditandai siap — pesanan sekarang bisa dikemas' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── TEMPORARY ORDER (LOAN / TRIAL) ───────────────────────────────────────────
// Customer pinjam barang sementara — Size Trial / Endorsement / Other.
// Lifecycle:
//   POST /api/temp-orders → status='test_sent' (stock potong via 'test_out')
//   PUT  .../finalize     → per-item keep/return → 'test_pending_pay' or 'test_pending_return'
//   PUT  /api/orders/:id/confirm-payment → existing endpoint, branching test_size handled inline
//   PUT  .../receive-returns → restore stock → 'done' (≥1 kept) or 'cancelled' (0 kept)
// is_test_returned di order_items = TRUE artinya item dibalikin customer (bukan keep).

const TRIAL_TYPES = ['size_trial', 'endorsement', 'other'];
const TRIAL_FREE_COURIERS = ['Kirim sendiri', PICKUP_COURIER];

function isTrialFreeCourier(c) {
    return TRIAL_FREE_COURIERS.includes((c || '').trim());
}

// POST /api/temp-orders — create new temporary order (admin only)
app.post('/api/temp-orders', requireMenu('temp-order','edit'), async (req, res) => {
    try {
        const {
            customer_name, customer_phone, customer_address, items, notes,
            shipping_city, shipping_cost,
            shipping_courier, shipping_weight_kg,
            trial_type
        } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ error: 'Daftar item kosong' });
        if (!TRIAL_TYPES.includes(trial_type)) return res.status(400).json({ error: 'Type wajib: size_trial / endorsement / other' });

        // Validate customer identity (same as /api/orders).
        const custNameTrim = (customer_name || '').trim();
        const custAddrTrim = (customer_address || '').trim();
        const custPhoneDigits = (customer_phone || '').replace(/\D/g, '');
        if (!custNameTrim) return res.status(400).json({ error: 'Nama pelanggan wajib diisi' });
        if (!custAddrTrim) return res.status(400).json({ error: 'Alamat pelanggan wajib diisi' });
        if (custPhoneDigits.length < 9 || custPhoneDigits.length > 15 || !/^(0|62|8)/.test(custPhoneDigits))
            return res.status(400).json({ error: 'Nomor WhatsApp tidak valid (08xxx / 62xxx)' });

        // Reject disallowed item flags (anti-tamper). Temp order DISABLE:
        // - bordir (nama/logo)  ← trial cuma utk fit-check, bordir dipesan ulang nanti
        // - custom_size / custom_product  ← off-catalog, gak bisa balik ke stock
        // - is_po  ← trial butuh barang fisik real, gak boleh PO
        for (const item of items) {
            if (item.bordir_nama || item.bordir_logo)
                return res.status(400).json({ error: 'Temporary order tidak mengizinkan bordir' });
            if (item.is_custom_size || item.is_custom_product)
                return res.status(400).json({ error: 'Temporary order tidak mengizinkan custom size / custom product' });
            if (item.is_po)
                return res.status(400).json({ error: 'Temporary order tidak mengizinkan Pre-Order — stok harus tersedia' });
            const q = Number(item.quantity);
            if (!Number.isInteger(q) || q < 1)
                return res.status(400).json({ error: 'Quantity setiap item harus bilangan bulat minimal 1' });
        }

        // Stock check — aggregate per variant (sama mekanik /api/orders).
        const variantTotals = new Map();
        for (const item of items) {
            const k = `${item.product_id}|${item.size}|${item.color}|${item.variant_type || 'null'}`;
            variantTotals.set(k, (variantTotals.get(k) || 0) + Number(item.quantity || 0));
        }
        for (const [k, totalQty] of variantTotals) {
            const [pid, size, color, vtype] = k.split('|');
            const product = await dbGet('SELECT * FROM products WHERE id = $1', [pid]);
            if (!product) return res.status(400).json({ error: `Produk ID ${pid} tidak ditemukan` });
            const inv = await dbGet(
                'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4',
                [pid, size, color, vtype]
            );
            const available = inv ? Number(inv.stock) : 0;
            if (available < totalQty) {
                return res.status(400).json({
                    error: `Stok ${product.name} (${color}, ${vtype}, ${size}) tidak cukup. Tersisa ${available}, diminta ${totalQty}`
                });
            }
        }

        // Compute prices & details.
        let productTotal = 0;
        const itemDetails = [];
        for (const item of items) {
            const product = await dbGet('SELECT * FROM products WHERE id = $1', [item.product_id]);
            if (!product) return res.status(400).json({ error: `Produk ID ${item.product_id} tidak ditemukan` });
            const priceByType = safeJSON(product.price_by_type, null);
            const catalogPrice = (priceByType && item.variant_type && priceByType[item.variant_type] != null)
                ? Number(priceByType[item.variant_type]) : Number(product.price);
            itemDetails.push({
                product_id: product.id,
                product_name: product.name,
                size: item.size, color: item.color,
                variant_type: item.variant_type || 'null',
                quantity: item.quantity,
                price: catalogPrice
            });
            productTotal += catalogPrice * item.quantity;
        }

        // Shipping cost. Free couriers (Kirim sendiri / Pickup) → always 0.
        const courier = (shipping_courier || '').trim() || 'Kirim sendiri';
        const weightKg = parseFloat(shipping_weight_kg || 0);
        const shipCost = isTrialFreeCourier(courier) ? 0 : Math.max(0, parseInt(shipping_cost || 0));

        // Provisional total (full items + ongkir) — DI-RECOMPUTE saat finalize sesuai
        // keep/return + sesuai courier policy. Disimpan sebagai initial estimate.
        const provisionalTotal = productTotal + shipCost;
        const orderCode = generateOrderCode('test_size');

        // Atomic: insert order + items + stock deduction (test_out) — all-or-nothing.
        const orderId = await withTransaction(async (client) => {
            const ord = await client.query(
                `INSERT INTO orders
                 (order_code, customer_name, customer_phone, customer_address,
                  shipping_city, shipping_courier, shipping_weight_kg, shipping_cost,
                  total_amount, notes, order_source, order_status,
                  trial_type, test_sent_at, payment_status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'test_size','test_sent',
                         $11, NOW(), 'pending') RETURNING id`,
                [orderCode, custNameTrim, customer_phone, custAddrTrim,
                 shipping_city || '', courier, weightKg, shipCost,
                 provisionalTotal, notes || '', trial_type]
            );
            const newOrderId = ord.rows[0].id;
            for (const it of itemDetails) {
                await client.query(
                    `INSERT INTO order_items (order_id, product_id, size, color, variant_type, quantity, price, is_test_returned)
                     VALUES ($1,$2,$3,$4,$5,$6,$7, FALSE)`,
                    [newOrderId, it.product_id, it.size, it.color, it.variant_type, it.quantity, it.price]
                );
            }
            // Deduct stock per variant + log 'test_out' (FOR UPDATE lock anti race).
            for (const [k, totalQty] of variantTotals) {
                const [pid, size, color, vtype] = k.split('|');
                const inv = await client.query(
                    'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                    [pid, size, color, vtype]
                );
                const stockBefore = inv.rows[0] ? parseInt(inv.rows[0].stock) : 0;
                if (stockBefore < totalQty) {
                    const e = new Error(`Stok ${color}/${vtype}/${size} kehabisan saat lock (race) — coba lagi`);
                    e.statusCode = 409; throw e;
                }
                const stockAfter = stockBefore - totalQty;
                await client.query(
                    `UPDATE inventory SET stock = stock - $1 WHERE product_id=$2 AND size=$3 AND color=$4 AND variant_type=$5`,
                    [totalQty, pid, size, color, vtype]
                );
                await client.query(
                    `INSERT INTO stock_movements
                     (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                     VALUES ($1,$2,$3,$4,'test_out',$5,$6,$7,$8,$9,$10)`,
                    [pid, size, color, vtype, -totalQty, stockBefore, stockAfter,
                     `Temp Order ${orderCode} (${trial_type})`, newOrderId, req.user.username]
                );
            }
            return newOrderId;
        });

        res.json({ success: true, order_id: orderId, order_code: orderCode });
    } catch (err) {
        const sc = err.statusCode || 500;
        res.status(sc).json({ error: err.message });
    }
});

// PUT /api/temp-orders/:id/finalize — admin marks per-item keep / return
// Body: { decisions: [{item_id, action: 'keep'|'return'}, ...] }
// Transition routing:
//   - Total tagihan > 0  → 'test_pending_pay' (perlu konfirmasi pembayaran)
//   - Total tagihan = 0  → 'test_pending_return' langsung (gak ada yg ditagih)
//   - 0 kept + 0 ongkir  → 'test_pending_return' (free customer keep nothing)
app.put('/api/temp-orders/:id/finalize', requireMenu('temp-order','edit'), async (req, res) => {
    try {
        const orderId = req.params.id;
        const { decisions } = req.body;
        if (!Array.isArray(decisions) || !decisions.length)
            return res.status(400).json({ error: 'Decisions kosong' });

        const order = await dbGet('SELECT * FROM orders WHERE id=$1', [orderId]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.order_source !== 'test_size')
            return res.status(400).json({ error: 'Bukan temporary order' });
        // Finalize BOLEH DIULANG selama belum ada konsekuensi yang tak bisa ditarik:
        // admin sering baru sadar salah pilih Keep/Return atau lupa diskon setelah
        // klik Lanjutkan. Aman karena finalize TIDAK menyentuh stok sama sekali —
        // stok keluar saat create (test_out) dan baru kembali saat receive-returns.
        // Dua pagar (keduanya titik tak-bisa-mundur):
        //   1. sudah dibayar  → total tak boleh berubah lagi (kacau di report/refund)
        //   2. retur sudah diterima → stok terlanjur dipulihkan mengikuti flag LAMA;
        //      mengubah flag setelah itu bikin stok tidak sinkron
        const REFINALIZABLE = ['test_sent', 'test_pending_pay', 'test_pending_return'];
        if (!REFINALIZABLE.includes(order.order_status))
            return res.status(400).json({ error: `Status saat ini "${order.order_status}", keputusan Keep/Return tidak bisa diubah lagi.` });
        if (order.payment_status === 'paid')
            return res.status(400).json({ error: 'Pesanan ini sudah dibayar — keputusan Keep/Return & diskon tidak bisa diubah lagi.' });
        if (order.test_returned_at)
            return res.status(400).json({ error: 'Barang retur sudah diterima (stok sudah dikembalikan) — keputusan tidak bisa diubah lagi.' });

        const items = await dbAll('SELECT * FROM order_items WHERE order_id=$1', [orderId]);
        const itemById = new Map(items.map(it => [it.id, it]));

        // Validate decisions: every item_id must exist in order, every action valid.
        for (const d of decisions) {
            if (!itemById.has(Number(d.item_id)))
                return res.status(400).json({ error: `Item ID ${d.item_id} tidak ada di pesanan ini` });
            if (!['keep','return'].includes(d.action))
                return res.status(400).json({ error: `Action ${d.action} invalid (keep / return)` });
        }
        // Ensure all items in order are covered (avoid silent half-decision).
        const decidedIds = new Set(decisions.map(d => Number(d.item_id)));
        for (const it of items) {
            if (!decidedIds.has(it.id))
                return res.status(400).json({ error: `Item ${it.id} belum diberi keputusan keep/return` });
        }

        // Compute new total: kept items × price + ongkir_conditional.
        // Ongkir di-charge kalau: courier paid (bukan Kirim sendiri / Pickup) AND
        // setidaknya ada barang yg keluar (semua trial kan udah keluar, jadi ongkir
        // selalu di-tagih kalau paid courier).
        const keptIds = new Set(decisions.filter(d => d.action === 'keep').map(d => Number(d.item_id)));
        const keptItems = items.filter(it => keptIds.has(it.id));
        const keptTotal = keptItems.reduce((s, it) => s + Number(it.price) * Number(it.quantity), 0);
        const ongkirCharge = isTrialFreeCourier(order.shipping_courier) ? 0 : Number(order.shipping_cost || 0);

        // Diskon opsional saat konfirmasi (admin kadang kasih potongan ke customer
        // yang jadi beli setelah trial). Hanya kena ke item yang DI-KEEP — ongkir
        // tidak didiskon, konsisten dgn POST /api/orders & aturan consignment.
        // Temp order tidak pernah punya bordir (ditolak saat create), jadi tidak
        // perlu varian inc/exc seperti di Kasir — cukup persentase.
        const validDiscounts = [0, 5, 30];
        const reqPct = parseInt(req.body.discount_percent);
        const discPct = validDiscounts.includes(reqPct) ? reqPct : 0;
        const discountAmount = Math.max(0, Math.min(Math.round(keptTotal * discPct / 100), keptTotal));
        const discountLabel = discPct === 5 ? 'Diskon 5%' : discPct === 30 ? 'Consignment 30%' : null;

        const newTotal = keptTotal - discountAmount + ongkirCharge;

        // Routing: ada yg ditagih → test_pending_pay; tagihan 0 → langsung test_pending_return.
        const nextStatus = newTotal > 0 ? 'test_pending_pay' : 'test_pending_return';

        await withTransaction(async (client) => {
            // Update per-item is_test_returned flag.
            for (const d of decisions) {
                await client.query(
                    `UPDATE order_items SET is_test_returned = $1 WHERE id = $2`,
                    [d.action === 'return', Number(d.item_id)]
                );
            }
            // Recompute total + update status + log decision time.
            // Ongkir di-zero-kan kalau gak ditagih (transparency di DB).
            await client.query(
                `UPDATE orders SET
                    total_amount = $1,
                    shipping_cost = $2,
                    order_status = $3,
                    discount_percent = $4,
                    discount_amount = $5,
                    discount_label = $6,
                    test_decision_at = NOW(),
                    updated_at = NOW()
                 WHERE id = $7`,
                [newTotal, ongkirCharge, nextStatus, discPct, discountAmount, discountLabel, orderId]
            );
        });

        res.json({
            success: true, next_status: nextStatus, total: newTotal,
            kept_total: keptTotal, discount_amount: discountAmount, discount_label: discountLabel
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/temp-orders/:id/receive-returns — admin terima fisik barang yg dikembalikan
// Restore stock utk semua item is_test_returned=TRUE via 'test_return' movement.
// Final state: 'done' (ada ≥1 kept) atau 'cancelled' (0 kept = semua dibalikin).
app.put('/api/temp-orders/:id/receive-returns', requireMenu('temp-order','edit'), async (req, res) => {
    try {
        const orderId = req.params.id;
        const order = await dbGet('SELECT * FROM orders WHERE id=$1', [orderId]);
        if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
        if (order.order_source !== 'test_size')
            return res.status(400).json({ error: 'Bukan temporary order' });
        if (order.order_status !== 'test_pending_return')
            return res.status(400).json({ error: `Status saat ini "${order.order_status}", receive-returns hanya saat test_pending_return` });

        const items = await dbAll('SELECT * FROM order_items WHERE order_id=$1', [orderId]);
        const returnedItems = items.filter(it => it.is_test_returned);
        const keptItems = items.filter(it => !it.is_test_returned);
        if (!returnedItems.length)
            return res.status(400).json({ error: 'Tidak ada item yg dikembalikan — gak perlu receive-returns' });

        const finalStatus = keptItems.length > 0 ? 'done' : 'cancelled';

        await withTransaction(async (client) => {
            // Aggregate returned qty per variant (multiple lines bisa share inventory row).
            const variantTotals = new Map();
            for (const it of returnedItems) {
                const k = `${it.product_id}|${it.size}|${it.color}|${it.variant_type}`;
                if (!variantTotals.has(k)) variantTotals.set(k, { product_id: it.product_id, size: it.size, color: it.color, variant_type: it.variant_type, quantity: 0 });
                variantTotals.get(k).quantity += Number(it.quantity);
            }
            // Restore inventory + log 'test_return'.
            for (const v of variantTotals.values()) {
                const inv = await client.query(
                    'SELECT stock FROM inventory WHERE product_id=$1 AND size=$2 AND color=$3 AND variant_type=$4 FOR UPDATE',
                    [v.product_id, v.size, v.color, v.variant_type]
                );
                const stockBefore = inv.rows[0] ? parseInt(inv.rows[0].stock) : 0;
                const stockAfter = stockBefore + v.quantity;
                await client.query(
                    `UPDATE inventory SET stock = stock + $1 WHERE product_id=$2 AND size=$3 AND color=$4 AND variant_type=$5`,
                    [v.quantity, v.product_id, v.size, v.color, v.variant_type]
                );
                await client.query(
                    `INSERT INTO stock_movements
                     (product_id, size, color, variant_type, movement_type, quantity_change, quantity_before, quantity_after, note, order_id, admin_user)
                     VALUES ($1,$2,$3,$4,'test_return',$5,$6,$7,$8,$9,$10)`,
                    [v.product_id, v.size, v.color, v.variant_type, v.quantity, stockBefore, stockAfter,
                     `Temp Order ${order.order_code} return`, order.id, req.user.username]
                );
            }
            await client.query(
                `UPDATE orders SET order_status = $1, test_returned_at = NOW(), updated_at = NOW() WHERE id = $2`,
                [finalStatus, orderId]
            );
            // Audit row utk timeline (sama pattern dgn 'done' di confirm-payment).
            await client.query(
                `INSERT INTO order_photos (order_id, step, photo_url, note, performed_by) VALUES ($1, 'test_return', NULL, $2, $3)`,
                [orderId, `${returnedItems.length} item dikembalikan, ${keptItems.length} dipertahankan`, req.user.username]
            );
        });

        res.json({ success: true, final_status: finalStatus });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/temp-orders/active-counts — agregat qty item yg lagi keluar utk trial
// Per varian. Output dipakai badge "🧪 N keluar" di card inventory.
// Hanya item yg masih out (NOT is_test_returned, status sebelum done/cancelled).
app.get('/api/temp-orders/active-counts', requireAuth(), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT oi.product_id, oi.size, oi.color, oi.variant_type,
                    SUM(oi.quantity)::int AS qty_out,
                    COUNT(DISTINCT o.id)::int AS order_count
               FROM order_items oi
               JOIN orders o ON o.id = oi.order_id
              WHERE o.order_source = 'test_size'
                AND o.order_status IN ('test_sent','test_pending_pay','test_pending_return')
                AND oi.is_test_returned = FALSE
                AND oi.product_id IS NOT NULL
              GROUP BY oi.product_id, oi.size, oi.color, oi.variant_type`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/temp-orders/by-variant — list order yg punya varian ini lagi keluar
app.get('/api/temp-orders/by-variant', requireAuth(), async (req, res) => {
    try {
        const { product_id, color, variant_type, size } = req.query;
        if (!product_id) return res.status(400).json({ error: 'product_id wajib' });
        const rows = await dbAll(
            `SELECT o.id, o.order_code, o.customer_name, o.trial_type, o.order_status,
                    o.test_sent_at, oi.quantity
               FROM order_items oi
               JOIN orders o ON o.id = oi.order_id
              WHERE o.order_source = 'test_size'
                AND o.order_status IN ('test_sent','test_pending_pay','test_pending_return')
                AND oi.is_test_returned = FALSE
                AND oi.product_id = $1
                AND oi.size = $2
                AND oi.color = $3
                AND oi.variant_type = $4
              ORDER BY o.test_sent_at ASC`,
            [product_id, size || '', color || '', variant_type || 'null']
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 Wearscrubs Backend berjalan di http://localhost:${PORT}`);
    console.log(`   API: http://localhost:${PORT}/api/products`);
    console.log(`   WA Token: ${process.env.FONNTE_TOKEN ? 'Terkonfigurasi ✅' : 'Belum ⚠️'}\n`);
});
