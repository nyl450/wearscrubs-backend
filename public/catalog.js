/**
 * catalog.js — WearScrubs Dynamic Catalog Engine
 * Handles: product loading from API, filtering (with inventory), sorting, cart management
 */

// Auto-detect environment: use Railway URL in production, localhost in dev
var WS_API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://wearscrubs-backend-production.up.railway.app';  // ← ganti dengan URL Railway Anda

const COLOR_META = {
    // Scrub colors
    'black':        { label: 'Black',        hex: '#000000' },
    'beige':        { label: 'Beige',        hex: '#d7c5a9' },
    'olive':        { label: 'Olive',        hex: '#696250' },
    'charcoal-grey':{ label: 'Charcoal Grey',hex: '#5f5051' },
    'light-grey':   { label: 'Light Grey',   hex: '#898391' },
    'maroon':       { label: 'Maroon',       hex: '#6c1b22' },
    'purple':       { label: 'Purple',       hex: '#a4b4e8' },
    'blush':        { label: 'Blush',        hex: '#f0c6bb' },
    'turquoise':    { label: 'Turquoise',    hex: '#40e0d0' },
    'white':        { label: 'White',        hex: '#f0f0f0' },
    // Gown Polos colors
    'navy':         { label: 'Navy',         hex: '#1b2a6b' },
    'tosca':        { label: 'Tosca',        hex: '#00a693' },
    'orange':       { label: 'Orange',       hex: '#f97316' },
    'blue':         { label: 'Blue',         hex: '#3b82f6' },
    'off-white':    { label: 'Off White',    hex: '#f5f0e8' },
    'grey':         { label: 'Grey',         hex: '#9ca3af' },
    'new-pink':     { label: 'New Pink',     hex: '#f472b6' },
    'green-mint':   { label: 'Green Mint',   hex: '#6ee7b7' },
    'baby-blue':    { label: 'Baby Blue',    hex: '#93c5fd' },
    'baby-pink':    { label: 'Baby Pink',    hex: '#fbcfe8' },
    'old-pink':     { label: 'Old Pink',     hex: '#e8a0a0' },
    // Gown Ber Design — motifs (stored as "color" key in inventory)
    'sea-world':      { label: 'Sea World',      hex: '#0ea5e9', isMotif: true },
    'balloon':        { label: 'Balloon',         hex: '#f59e0b', isMotif: true },
    'princess':       { label: 'Princess',        hex: '#ec4899', isMotif: true },
    'fruits':         { label: 'Fruits',          hex: '#22c55e', isMotif: true },
    'numbers':        { label: 'Numbers',         hex: '#8b5cf6', isMotif: true },
    'fairies':        { label: 'Fairies',         hex: '#a78bfa', isMotif: true },
    'baby-tooth-grey':{ label: 'Baby Tooth Grey', hex: '#94a3b8', isMotif: true },
    'baby-tooth-maroon':{ label: 'Baby Tooth Maroon', hex: '#7f1d1d', isMotif: true },
    'brush-tooth':    { label: 'Brush Tooth',     hex: '#64748b', isMotif: true },
    'cars':           { label: 'Cars',            hex: '#ef4444', isMotif: true },
    'circus':         { label: 'Circus',          hex: '#f97316', isMotif: true },
    'tooth-doodle':   { label: 'Tooth Doodle',    hex: '#06b6d4', isMotif: true },
};

// ── Cart Utilities ────────────────────────────────────────────────────────────
const Cart = {
    get() { try { return JSON.parse(localStorage.getItem('ws_cart') || '[]'); } catch { return []; } },
    save(cart) { localStorage.setItem('ws_cart', JSON.stringify(cart)); Cart.updateBadge(); },
    count() { return Cart.get().reduce((s, i) => s + i.quantity, 0); },
    add(item) {
        const cart = Cart.get();
        const idx = cart.findIndex(c => c.product_id === item.product_id && c.size === item.size && c.color === item.color);
        if (idx > -1) cart[idx].quantity += item.quantity;
        else cart.push(item);
        Cart.save(cart);
    },
    updateBadge() {
        const count = Cart.count();
        document.querySelectorAll('.cart-count').forEach(el => { el.textContent = count; });
    }
};

// ── Catalog Engine ────────────────────────────────────────────────────────────
const Catalog = {
    products: [],
    filtered: [],
    inventoryMap: {},  // key: `productId_color_size_type` → stock qty

    async load(category) {
        try {
            const [prodRes, invRes] = await Promise.all([
                fetch(`${WS_API}/api/products?category=${category}`),
                fetch(`${WS_API}/api/inventory?category=${category}`).catch(() => null)
            ]);
            if (!prodRes.ok) throw new Error('API Error');
            this.products = await prodRes.json();

            // Build inventory map for fast lookup
            this.inventoryMap = {};
            if (invRes && invRes.ok) {
                const invRows = await invRes.json();
                invRows.forEach(row => {
                    const key = `${row.product_id}_${row.color}_${row.size}_${row.variant_type || 'null'}`;
                    this.inventoryMap[key] = (this.inventoryMap[key] || 0) + (row.stock || 0);
                });
            }

            this.filtered = [...this.products];
            this.renderGrid();
            this.updateCount();
        } catch (e) {
            console.error('Failed to load products:', e);
            const grid = document.getElementById('product-grid');
            if (grid) {
                const isEn = localStorage.getItem('ws_lang') === 'en' || location.pathname.includes('-en.html');
                grid.innerHTML = `
                    <div class="col-span-3 text-center py-16 text-gray-400 dark:text-white/40">
                        <i class="fa-solid fa-plug-circle-xmark text-4xl mb-3 block"></i>
                        <p class="font-medium">${isEn ? 'Failed to load products. Please ensure the backend server is running.' : 'Gagal memuat produk. Pastikan server backend berjalan.'}</p>
                    </div>`;
            }
        }
    },

    // Check if a specific variant has stock
    hasStock(productId, color, size, type) {
        const key = `${productId}_${color}_${size}_${type || 'null'}`;
        return (this.inventoryMap[key] || 0) > 0;
    },

    // Any stock for a product (any color/size/type combo)
    productHasAnyStock(product) {
        const sizes = product.sizes || [];
        const colors = product.colors || [];
        const types = (product.types && product.types[0] !== 'null') ? product.types : ['null'];
        for (const color of colors)
            for (const size of sizes)
                for (const type of types)
                    if (this.hasStock(product.id, color, size, type)) return true;
        return false;
    },

    filter() {
        const checkboxes = document.querySelectorAll('.filter-checkbox:checked');
        const activeFilters = {};
        checkboxes.forEach(cb => {
            if (!activeFilters[cb.name]) activeFilters[cb.name] = [];
            activeFilters[cb.name].push(cb.value);
        });

        this.filtered = this.products.filter(p => {
            // Only show products with available inventory
            if (Object.keys(this.inventoryMap).length > 0 && !this.productHasAnyStock(p)) return false;

            for (const [key, allowed] of Object.entries(activeFilters)) {
                if (key === 'size') {
                    const pSizes = (p.sizes || []).map(s => s.toLowerCase());
                    if (!allowed.some(s => pSizes.includes(s))) return false;
                } else if (key === 'sub_type' || key === 'types') {
                    const pTypes = p.types || [p.sub_type];
                    if (!allowed.some(t => pTypes.includes(t))) return false;
                } else if (key === 'color') {
                    const pColors = p.colors || [];
                    if (!allowed.some(c => pColors.includes(c))) return false;
                }
            }
            return true;
        });

        this.renderGrid();
        this.updateCount();
    },

    sort(order) {
        if (order === 'price-low') this.filtered.sort((a, b) => a.price - b.price);
        else if (order === 'price-high') this.filtered.sort((a, b) => b.price - a.price);
        else this.filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        this.renderGrid();
    },

    updateCount() {
        const el = document.getElementById('results-count');
        if (!el) return;
        const isEn = document.documentElement.lang === 'en' ||
                     localStorage.getItem('ws_lang') === 'en' ||
                     location.pathname.includes('-en.html');
        el.textContent = isEn
            ? `${this.filtered.length} product${this.filtered.length !== 1 ? 's' : ''} found`
            : `${this.filtered.length} produk ditemukan`;
    },

    renderGrid() {
        const grid = document.getElementById('product-grid');
        const empty = document.getElementById('empty-state');
        if (!grid) return;

        if (this.filtered.length === 0) {
            grid.innerHTML = '';
            if (empty) { empty.classList.remove('hidden'); empty.classList.add('flex'); }
            return;
        }
        if (empty) { empty.classList.add('hidden'); empty.classList.remove('flex'); }

        grid.innerHTML = this.filtered.map(p => this.renderCard(p)).join('');
    },

    renderCard(p) {
        const img1 = p.main_photo
            ? (p.main_photo.startsWith('/') ? WS_API + p.main_photo : p.main_photo)
            : 'images/logo/logo%20ws%20white%20250x55.png';

        // Hover image = second variant photo if available
        const img2 = (p.variants && p.variants.length > 1 && p.variants[1].photo_url)
            ? (p.variants[1].photo_url.startsWith('/') ? WS_API + p.variants[1].photo_url : p.variants[1].photo_url)
            : img1;

        // Types/sub-type row (only for tops/pants if types exist)
        const types = (p.types && p.types.length > 0 && p.types[0] !== 'null') ? p.types : [];
        const typesHTML = types.length > 0 ? `
            <div class="flex flex-wrap gap-1 mb-1" id="types-${p.id}">
                ${types.map(t => {
                    const label = t === 'pendek' ? 'Lengan Pendek' : t === 'panjang' ? 'Lengan Panjang' : t;
                    const anyStockForType = (p.colors || []).some(c =>
                        (p.sizes || []).some(s => this.hasStock(p.id, c, s, t))
                    );
                    const outClass = anyStockForType ? '' : 'line-through opacity-40 cursor-not-allowed';
                    return `<span class="text-[9px] font-bold px-2 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/60 uppercase tracking-wide ${outClass}">${label}</span>`;
                }).join('')}
            </div>` : '';

        // Color dots — dim & strikethrough if no stock for that color
        const firstColorMeta = (p.colors && p.colors[0]) ? COLOR_META[p.colors[0]] : null;
        const firstColorLabel = firstColorMeta ? firstColorMeta.label : '';
        const firstIsMotif = firstColorMeta && firstColorMeta.isMotif;
        const dotsHTML = (p.colors || []).map((c, i) => {
            const hex = p.color_hex_map ? p.color_hex_map[c] : (COLOR_META[c] ? COLOR_META[c].hex : '#ccc');
            const anyStockForColor = types.length > 0
                ? types.some(t => (p.sizes || []).some(s => this.hasStock(p.id, c, s, t)))
                : (p.sizes || []).some(s => this.hasStock(p.id, c, s, 'null'));
            const outAttr = anyStockForColor ? '' : 'data-out-of-stock="1" title="Stok habis"';
            const outStyle = anyStockForColor ? '' : 'opacity:0.3; cursor:not-allowed;';
            const colorMeta = COLOR_META[c];
            const colorLabel = colorMeta ? colorMeta.label : c;
            const isMotifColor = colorMeta && colorMeta.isMotif;
            if (isMotifColor) {
                // Render as text pill for motif gown
                return `<button type="button" data-product-id="${p.id}" data-color="${c}" data-color-label="${colorLabel}"
                    onclick="Catalog.selectColor(this)"
                    class="motif-pill text-[9px] font-bold px-2 py-0.5 rounded-full border-2 transition-all ${i === 0 ? 'border-gray-900 dark:border-white bg-gray-900 dark:bg-white text-white dark:text-black' : 'border-gray-200 dark:border-white/20 text-gray-600 dark:text-white/60 hover:border-gray-700 dark:hover:border-white'}"
                    style="${outStyle}" ${outAttr}>${colorLabel}</button>`;
            }
            return `<button type="button" data-product-id="${p.id}" data-color="${c}" data-color-label="${colorLabel}"
                onclick="Catalog.selectColor(this)"
                class="color-dot w-4 h-4 rounded-full border-2 transition-all ${i === 0 ? 'border-gray-900 dark:border-white scale-110' : 'border-transparent hover:border-gray-500 hover:scale-110'}"
                style="background-color:${hex}; ${outStyle}" ${outAttr}></button>`;
        }).join('');

        // Size buttons — disabled & strikethrough if no stock
        // SESUDAH ✅ — cek semua tipe, bukan hanya tipe pertama
            const selectedColor = (p.colors || [])[0] || null;
            const sizesHTML = (p.sizes || []).map(s => {
                const inStock = selectedColor
                    ? (types.length > 0
                        ? types.some(t => this.hasStock(p.id, selectedColor, s, t))
                        : this.hasStock(p.id, selectedColor, s, 'null'))
                    : false;
            const disabledClass = inStock ? '' : 'line-through opacity-35 cursor-not-allowed';
            return `<button type="button" data-product-id="${p.id}" data-size="${s}"
                onclick="Catalog.selectSize(this)"
                class="size-btn text-[10px] font-bold px-2.5 py-1 rounded border border-gray-200 dark:border-white/15 text-gray-500 dark:text-white/50 hover:border-gray-900 hover:text-gray-900 dark:hover:border-white dark:hover:text-white transition-all ${disabledClass}"
                ${inStock ? '' : 'disabled title="Stok habis"'}>${s}</button>`;
        }).join('');

        // Caps description (only for scrub-caps category)
        const isCaps = p.category === 'caps';
        const isGown = p.category === 'gown';
        const isEn = localStorage.getItem('ws_lang') === 'en' || location.pathname.includes('-en.html');
        const capsDescId = 'Dengan desain yang ringan dan ergonomis, cap scrub ini menjamin kenyamanan dan kesesuaian yang pas selama shift panjang sekaligus menjaga rambut tetap tertutup rapi.';
        const capsDescEn = 'With a lightweight and ergonomic design, this scrub cap ensures comfort and a perfect fit during long shifts while keeping hair neatly covered.';
        const capsDesc = isCaps ? `<p class="text-[11px] text-gray-500 dark:text-white/50 leading-relaxed mt-0.5">${isEn ? capsDescEn : capsDescId}</p>` : '';
        const gownDescId = 'Baju gown medis dengan bahan premium, praktis, dan nyaman untuk prosedur klinis.';
        const gownDescEn = 'Premium medical gown, practical and comfortable for clinical procedures.';
        const gownDesc = isGown ? `<p class="text-[11px] text-gray-500 dark:text-white/50 leading-relaxed mt-0.5">${isEn ? gownDescEn : gownDescId}</p>` : '';
        const btnLabel = isEn ? 'View Product' : 'Detail Produk';

        return `
        <div class="product-card-wrapper" data-id="${p.id}">
            <div class="group relative bg-white dark:bg-darkcard rounded-2xl shadow-sm hover:shadow-xl transition-all duration-300 border border-gray-100 dark:border-white/5 overflow-hidden flex flex-col h-full">
                <div class="relative aspect-[3/4] bg-gray-100 dark:bg-darkbg overflow-hidden cursor-pointer" onclick="window.location.href='product.html?id=${p.id}'">
                    <img loading="lazy" decoding="async" id="pc-img1-${p.id}" src="${img1}" alt="${p.name}" class="absolute inset-0 w-full h-full object-cover object-top transition-all duration-700 opacity-100 group-hover:scale-105 z-10" onerror="this.src='images/logo/logo%20ws%20white%20250x55.png';">
                    <img loading="lazy" decoding="async" id="pc-img2-${p.id}" src="${img2}" alt="${p.name}" class="absolute inset-0 w-full h-full object-cover object-top transition-all duration-700 opacity-0 group-hover:opacity-100 group-hover:scale-105 z-0">
                    ${p.is_popular ? '<span class="absolute top-3 left-3 text-[10px] font-bold px-2 py-1 rounded-full bg-black/70 text-white backdrop-blur-sm z-20">⭐ Popular</span>' : ''}
                </div>
                <div class="p-4 flex-1 flex flex-col gap-2">
                    <div onclick="window.location.href='product.html?id=${p.id}'" class="cursor-pointer">
                        <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug hover:underline">${p.name}</h3>
                        <p class="text-sm font-bold text-gray-800 dark:text-white/80 mt-0.5">${p.price_formatted}</p>
                        ${capsDesc}${gownDesc}
                    </div>
                    ${typesHTML}
                    <div class="flex flex-wrap gap-1" id="sizes-${p.id}">${sizesHTML}</div>
                    <div class="flex items-center justify-between mt-auto pt-2 border-t border-gray-100 dark:border-white/5">
                        <div class="flex flex-col gap-1">
                            <div class="flex gap-1.5 flex-wrap" id="colors-${p.id}">${dotsHTML}</div>
                            <span id="color-label-${p.id}" class="text-[10px] text-gray-500 dark:text-white/50 font-medium">${firstIsMotif ? 'Motif: ' : ''}${firstColorLabel}</span>
                        </div>
                        <button onclick="window.location.href='product.html?id=${p.id}'" class="flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-black rounded-full hover:bg-gray-700 dark:hover:bg-gray-200 transition-all shrink-0">${btnLabel}</button>
                    </div>
                </div>
            </div>
        </div>`;
    },

    selectColor(btn) {
        if (btn.dataset.outOfStock) return; // disabled
        const pid = Number(btn.dataset.productId);
        const color = btn.dataset.color;
        const product = this.products.find(p => p.id === pid);
        if (!product) return;

        // Update active dot
        document.querySelectorAll(`#colors-${pid} .color-dot`).forEach(b => {
            b.classList.remove('border-gray-900', 'dark:border-white', 'scale-110');
            b.classList.add('border-transparent');
        });
        btn.classList.remove('border-transparent');
        btn.classList.add('border-gray-900', 'dark:border-white', 'scale-110');

        // Update active color label
        const labelEl = document.getElementById(`color-label-${pid}`);
        if (labelEl) labelEl.textContent = btn.dataset.colorLabel || color;

        // Change main image to first photo of the selected color
        const applyPhoto = (variants) => {
            // New grouped format: each variant has color + photos[]
            const v = variants.find(v => v.color === color);
            if (v) {
                const url = v.photos && v.photos.length > 0 ? v.photos[0] : v.photo_url;
                if (url) {
                    const resolved = url.startsWith('/') ? WS_API + url : url;
                    const imgEl = document.getElementById(`pc-img1-${pid}`);
                    if (imgEl) imgEl.src = resolved;
                }
            }
        };

        if (product.variants && product.variants.length > 0) {
            applyPhoto(product.variants);
        } else {
            fetch(`${WS_API}/api/products/${pid}`)
                .then(r => r.json())
                .then(full => { product.variants = full.variants || []; applyPhoto(product.variants); })
                .catch(() => {});
        }

        // Update size availability based on selected color
        this._updateSizeAvailability(pid, color, product);
    },

    // SESUDAH ✅ — cek semua tipe
    _updateSizeAvailability(pid, color, product) {
    const types = (product.types && product.types[0] !== 'null') ? product.types : [];
    document.querySelectorAll(`#sizes-${pid} .size-btn`).forEach(btn => {
        const size = btn.dataset.size;
        const inStock = types.length > 0
            ? types.some(t => this.hasStock(pid, color, size, t))
            : this.hasStock(pid, color, size, 'null');
            if (inStock) {
                btn.classList.remove('line-through', 'opacity-35', 'cursor-not-allowed');
                btn.disabled = false;
                btn.removeAttribute('title');
            } else {
                btn.classList.add('line-through', 'opacity-35', 'cursor-not-allowed');
                btn.disabled = true;
                btn.title = 'Stok habis';
            }
        });
    },

    selectSize(btn) {
        if (btn.disabled) return;
        const pid = btn.dataset.productId;
        document.querySelectorAll(`#sizes-${pid} .size-btn`).forEach(b => {
            b.classList.remove('bg-gray-900', 'text-white', 'border-gray-900',
                               'dark:bg-white', 'dark:text-black', 'dark:border-white');
            b.classList.add('border-gray-200', 'text-gray-500', 'dark:border-white/15', 'dark:text-white/50');
        });
        btn.classList.remove('border-gray-200', 'text-gray-500', 'dark:border-white/15', 'dark:text-white/50');
        btn.classList.add('bg-gray-900', 'text-white', 'border-gray-900');
    },

    addToCart(productId) {
        window.location.href = `product.html?id=${productId}`;
    }
};

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, isError = false) {
    let el = document.getElementById('ws-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'ws-toast';
        el.className = 'fixed bottom-6 right-6 z-[9999] transition-all duration-300 translate-y-4 opacity-0';
        el.innerHTML = `<div class="bg-gray-900 dark:bg-white text-white dark:text-black px-5 py-3 rounded-2xl shadow-2xl text-sm font-medium flex items-center gap-3 max-w-sm">
            <i id="ws-toast-icon" class="fa-solid fa-check-circle text-green-400 dark:text-green-600 shrink-0"></i>
            <span id="ws-toast-msg"></span>
        </div>`;
        document.body.appendChild(el);
    }
    document.getElementById('ws-toast-msg').textContent = msg;
    document.getElementById('ws-toast-icon').className = `fa-solid ${isError ? 'fa-triangle-exclamation text-red-400' : 'fa-check-circle text-green-400 dark:text-green-600'} shrink-0`;
    el.classList.remove('translate-y-4', 'opacity-0');
    clearTimeout(el._timeout);
    el._timeout = setTimeout(() => el.classList.add('translate-y-4', 'opacity-0'), 3000);
}

// ── Init on DOM Ready ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    Cart.updateBadge();

    document.querySelectorAll('.filter-checkbox').forEach(cb => {
        cb.addEventListener('change', () => Catalog.filter());
    });

    const resetBtn = document.getElementById('reset-filters');
    if (resetBtn) resetBtn.addEventListener('click', e => {
        e.preventDefault();
        document.querySelectorAll('.filter-checkbox').forEach(cb => cb.checked = false);
        Catalog.filter();
    });

    const sortSel = document.getElementById('sort-select');
    if (sortSel) sortSel.addEventListener('change', e => Catalog.sort(e.target.value));

    document.querySelectorAll('.cart-btn').forEach(btn => {
        btn.addEventListener('click', () => window.location.href = 'cart.html');
    });
});
