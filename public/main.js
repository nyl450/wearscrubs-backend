document.addEventListener('DOMContentLoaded', function () {

    // --- 0. MOBILE DRAWER ---
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const mobileCloseBtn = document.getElementById('mobile-close-btn');
    const mobileDrawer = document.getElementById('mobile-drawer');
    const mobileOverlay = document.getElementById('mobile-overlay');

    function openDrawer() {
        if (!mobileDrawer) return;
        mobileDrawer.classList.remove('translate-x-full');
        if (mobileOverlay) {
            mobileOverlay.classList.remove('opacity-0', 'pointer-events-none');
            mobileOverlay.classList.add('opacity-100');
        }
        document.body.style.overflow = 'hidden';
    }

    function closeDrawer() {
        if (!mobileDrawer) return;
        mobileDrawer.classList.add('translate-x-full');
        if (mobileOverlay) {
            mobileOverlay.classList.add('opacity-0', 'pointer-events-none');
            mobileOverlay.classList.remove('opacity-100');
        }
        document.body.style.overflow = '';
    }

    if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', openDrawer);
    if (mobileCloseBtn) mobileCloseBtn.addEventListener('click', closeDrawer);
    if (mobileOverlay) mobileOverlay.addEventListener('click', closeDrawer);

    document.querySelectorAll('.mobile-nav-link').forEach(link => {
        link.addEventListener('click', closeDrawer);
    });


    // --- 1. MODE TERANG/GELAP (TEMA) ---
    const htmlEl = document.documentElement;

    // Restore saved theme from localStorage (default: dark)
    const savedTheme = localStorage.getItem('ws_theme');
    let isDark = savedTheme !== 'light'; // default dark unless explicitly saved as light

    // Apply immediately on load
    applyTheme(isDark);

    function applyTheme(dark) {
        isDark = dark;
        if (dark) {
            htmlEl.classList.add('dark');
        } else {
            htmlEl.classList.remove('dark');
        }
        // Save to localStorage
        localStorage.setItem('ws_theme', dark ? 'dark' : 'light');
        // Update all theme toggles (desktop + mobile)
        const _isEn = (location.pathname.split('/').pop() || '').endsWith('-en.html') ||
                      (location.pathname.split('/').pop() || '') === 'index-en.html';
        document.querySelectorAll('[data-theme-text]').forEach(el => {
            el.textContent = dark
                ? (_isEn ? 'DARK MODE'  : 'MODE GELAP')
                : (_isEn ? 'LIGHT MODE' : 'MODE TERANG');
        });
        document.querySelectorAll('[data-theme-thumb]').forEach(el => {
            if (dark) {
                el.classList.add('translate-x-4');
                el.classList.remove('translate-x-0');
            } else {
                el.classList.remove('translate-x-4');
                el.classList.add('translate-x-0');
            }
        });
    }

    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
        btn.addEventListener('click', () => applyTheme(!isDark));
    });


    // --- 2. EFEK SCROLL HEADER ---
    window.addEventListener('scroll', () => {
        const header = document.querySelector('header');
        if (!header) return;
        if (window.scrollY > 50) {
            header.classList.add('py-2');
            header.classList.remove('py-4');
        } else {
            header.classList.add('py-4');
            header.classList.remove('py-2');
        }
    });

    // --- 3. LOGIKA TAB UNTUK KATALOG SCRUB ---
    const catalogTabs = document.querySelectorAll('.catalog-tab');
    const catalogContents = document.querySelectorAll('.catalog-content');

    catalogTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            catalogTabs.forEach(t => {
                t.classList.remove('bg-gray-900', 'text-white', 'dark:bg-white', 'dark:text-black', 'active', 'shadow-sm');
                t.classList.add('bg-gray-200', 'text-gray-600', 'dark:bg-darkcard', 'dark:text-gray-400');
            });
            catalogContents.forEach(content => {
                content.classList.add('hidden');
            });
            tab.classList.remove('bg-gray-200', 'text-gray-600', 'dark:bg-darkcard', 'dark:text-gray-400');
            tab.classList.add('bg-gray-900', 'text-white', 'dark:bg-white', 'dark:text-black', 'active', 'shadow-sm');
            const targetId = tab.getAttribute('data-target');
            const target = document.getElementById(targetId);
            if (target) target.classList.remove('hidden');
        });
    });
    // --- UPDATE CART BADGE (all pages, even without catalog.js) ---
    try {
        const _rawCart = localStorage.getItem('ws_cart');
        const _cart = _rawCart ? JSON.parse(_rawCart) : [];
        const _count = Array.isArray(_cart) ? _cart.reduce((s, i) => s + (Number(i.quantity) || 0), 0) : 0;
        document.querySelectorAll('.cart-count').forEach(el => { el.textContent = _count; });
    } catch(e) {}

    // --- TOMBOL AKUN CUSTOMER (#3) — disuntik di kanan cart di SEMUA halaman ---
    // Additive: tidak mengubah markup halaman, cuma menambah 1 link akun setelah
    // tiap .cart-btn. Kalau sudah login → tampil nama, else "Masuk".
    try {
        const isEn = (location.pathname.split('/').pop() || '').includes('-en.html');
        const acctHref = isEn ? 'akun-en.html' : 'akun.html';
        const t = localStorage.getItem('ws_customer_token');
        // Sudah login → "Akun/Account"; belum → "Masuk/Sign In".
        const label = t ? (isEn ? 'Account' : 'Akun') : (isEn ? 'Sign In' : 'Masuk');
        document.querySelectorAll('.cart-btn').forEach(cartBtn => {
            // Jangan dobel kalau sudah ada.
            if (cartBtn.parentElement && cartBtn.parentElement.querySelector('.acct-btn')) return;
            const a = document.createElement('a');
            a.href = acctHref;
            a.className = 'acct-btn flex items-center gap-1.5 text-gray-700 dark:text-gray-300 hover:text-black dark:hover:text-white transition-colors' + (cartBtn.className.includes('w-full') ? ' w-full justify-between py-3 px-4 bg-gray-100 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/10 mt-2 text-sm font-medium' : ' ml-5');
            const isDrawer = cartBtn.className.includes('w-full');
            a.innerHTML = isDrawer
                ? `<span class="flex items-center gap-3"><i class="fa-regular fa-user"></i> ${label}</span>`
                : `<i class="fa-regular fa-user text-[15px]"></i><span class="uppercase text-[12px] tracking-widest font-medium">${label}</span>`;
            cartBtn.insertAdjacentElement('afterend', a);
        });
    } catch(e) {}

}); // end DOMContentLoaded


// Legacy color selection (for static pages only).
// product.html sets window._productPageActive = true before loading main.js,
// so we skip overwriting its selectColor.
if (!window._productPageActive) {
    window.selectColor = function(btn, imgId, src) {
        const img = document.getElementById(imgId);
        if (img) img.src = src;
        const parent = btn ? btn.parentElement : null;
        if (!parent) return;
        const siblings = parent.querySelectorAll('.color-dot');
        siblings.forEach(b => {
            b.classList.remove('ring-2', 'ring-gray-900', 'dark:ring-white', 'scale-110');
            b.classList.add(b.classList.contains('w-4') ? 'border-gray-300' : 'border-gray-400');
        });
        btn.classList.remove('border-gray-300', 'border-gray-400');
        btn.classList.add('ring-2', 'ring-gray-900', 'dark:ring-white', 'scale-110');
    };
}

// -- FAQ Accordion ----------------------------------------------------------
function toggleFaq(btn) {
    const body = btn.nextElementSibling;
    const icon = btn.querySelector('.faq-icon');
    const isOpen = !body.classList.contains('hidden');
    document.querySelectorAll('.faq-body').forEach(b => b.classList.add('hidden'));
    document.querySelectorAll('.faq-icon').forEach(i => { i.classList.remove('fa-minus'); i.classList.add('fa-plus'); });
    if (!isOpen) {
        body.classList.remove('hidden');
        icon.classList.remove('fa-plus'); icon.classList.add('fa-minus');
    }
}

// -- LANGUAGE PERSISTENCE ----------------------------------------------------
const WS_LANG_MAP = {
    'index.html':        'index-en.html',
    'scrub-top.html':    'scrub-top-en.html',
    'scrub-pants.html':  'scrub-pants-en.html',
    'scrub-caps.html':   'scrub-caps-en.html',
    'about-us.html':     'about-us-en.html',
    'contact.html':      'contact-en.html',
    'FAQ.html':          'FAQ-en.html',
    'karir.html':        'karir-en.html',
    'shipping.html':     'shipping-en.html',
    'ukuran.html':       'ukuran-en.html',
    'news-1.html':       'news-1-en.html',
    'news-2.html':       'news-2-en.html',
    'news-3.html':       'news-3-en.html',
    'news-4.html':       'news-4-en.html',
    'payments-shipping.html': 'payments-shipping-en.html',
    'gown.html':             'gown-en.html',
    'index-en.html':     'index.html',
    'scrub-top-en.html': 'scrub-top.html',
    'scrub-pants-en.html':'scrub-pants.html',
    'scrub-caps-en.html':'scrub-caps.html',
    'about-us-en.html':  'about-us.html',
    'contact-en.html':   'contact.html',
    'FAQ-en.html':       'FAQ.html',
    'karir-en.html':     'karir.html',
    'shipping-en.html':  'shipping.html',
    'ukuran-en.html':    'ukuran.html',
    'news-1-en.html':    'news-1.html',
    'news-2-en.html':    'news-2.html',
    'news-3-en.html':    'news-3.html',
    'news-4-en.html':    'news-4.html',
    'payments-shipping-en.html': 'payments-shipping.html',
    'gown-en.html':          'gown.html',
};

(function initLanguage() {
    const currentFile = location.pathname.split('/').pop() || 'index.html';
    const isEnPage = currentFile.endsWith('-en.html') || currentFile === 'index-en.html';
    const savedLang = localStorage.getItem('ws_lang');
    // ws_langSet = 'true' means the user has explicitly clicked a language button
    const userHasChosen = localStorage.getItem('ws_lang_set') === 'true';

    // Only redirect if user has explicitly chosen a language AND it doesn't match the current page
    if (userHasChosen && savedLang) {
        if (savedLang === 'en' && !isEnPage && WS_LANG_MAP[currentFile]) {
            location.replace(WS_LANG_MAP[currentFile]);
            return;
        }
        if (savedLang === 'id' && isEnPage && WS_LANG_MAP[currentFile]) {
            location.replace(WS_LANG_MAP[currentFile]);
            return;
        }
    }

    // Sync localStorage to current page (without triggering redirect)
    localStorage.setItem('ws_lang', isEnPage ? 'en' : 'id');

    // Update language links dynamically (data-lang-en / data-lang-id attributes)
    const counterpart = WS_LANG_MAP[currentFile];
    document.querySelectorAll('[data-lang-en]').forEach(el => {
        if (counterpart && !isEnPage) el.href = counterpart;
        el.classList.toggle('font-bold', isEnPage);
        el.classList.toggle('text-black', isEnPage);
        el.classList.toggle('dark:text-white', isEnPage);
        el.classList.toggle('font-medium', !isEnPage);
        el.classList.toggle('text-gray-500', !isEnPage);
    });
    document.querySelectorAll('[data-lang-id]').forEach(el => {
        if (counterpart && isEnPage) el.href = counterpart;
        el.classList.toggle('font-bold', !isEnPage);
        el.classList.toggle('text-black', !isEnPage);
        el.classList.toggle('dark:text-white', !isEnPage);
        el.classList.toggle('font-medium', isEnPage);
        el.classList.toggle('text-gray-500', isEnPage);
    });

    // -- Critical fix: save lang to localStorage BEFORE navigating ----------
    document.querySelectorAll('[data-lang-en]').forEach(el => {
        el.addEventListener('click', () => {
            localStorage.setItem('ws_lang', 'en');
            localStorage.setItem('ws_lang_set', 'true'); // user explicitly chose EN
        });
    });
    document.querySelectorAll('[data-lang-id]').forEach(el => {
        el.addEventListener('click', () => {
            localStorage.setItem('ws_lang', 'id');
            localStorage.setItem('ws_lang_set', 'true'); // user explicitly chose ID
        });
    });

    // â”€â”€ Universal fix: any plain <a> link pointing to an ID-version page â”€â”€â”€â”€â”€â”€â”€
    // Covers hardcoded href links in EN pages (e.g. href="scrub-top.html" for ID button)
    // When clicked, stamp ws_lang='id' so initLanguage() on landing page won't redirect back.
    const idPages = Object.keys(WS_LANG_MAP).filter(k => !k.endsWith('-en.html') && k !== 'index-en.html');
    document.querySelectorAll('a[href]').forEach(el => {
        const href = el.getAttribute('href');
        const targetFile = (href || '').split('/').pop().split('?')[0];
        if (idPages.includes(targetFile) && isEnPage) {
            el.addEventListener('click', () => {
                localStorage.setItem('ws_lang', 'id');
                localStorage.setItem('ws_lang_set', 'true');
            });
        }
    });

    // â”€â”€ Universal fix: any plain <a> link pointing to an EN-version page â”€â”€â”€â”€â”€â”€â”€â”€
    // Covers hardcoded href links in ID pages (e.g. href="scrub-top-en.html" for EN button)
    const enPages = Object.keys(WS_LANG_MAP).filter(k => k.endsWith('-en.html') || k === 'index-en.html');
    document.querySelectorAll('a[href]').forEach(el => {
        const href = el.getAttribute('href');
        const targetFile = (href || '').split('/').pop().split('?')[0];
        if (enPages.includes(targetFile) && !isEnPage) {
            el.addEventListener('click', () => {
                localStorage.setItem('ws_lang', 'en');
                localStorage.setItem('ws_lang_set', 'true');
            });
        }
    });
})();