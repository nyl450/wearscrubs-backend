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

    // --- 4. CHATBOT AI (via /api/chat backend) ---
    const chatBtn = document.getElementById('ai-chat-btn');
    const chatPanel = document.getElementById('ai-chat-panel');
    const closeChat = document.getElementById('close-chat');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const chatMessages = document.getElementById('chat-messages');

    let conversationHistory = [];

    if (chatBtn && chatPanel) {
        chatBtn.addEventListener('click', () => {
            chatPanel.style.display = 'flex';
            requestAnimationFrame(() => {
                chatPanel.style.transform = 'scale(1)';
                chatPanel.style.opacity = '1';
            });
            if (chatInput) chatInput.focus();
        });
    }

    if (closeChat && chatPanel) {
        closeChat.addEventListener('click', () => {
            chatPanel.style.transform = 'scale(0.95)';
            chatPanel.style.opacity = '0';
            setTimeout(() => { chatPanel.style.display = 'none'; }, 200);
        });
    }

    function appendMessage(text, sender) {
        if (!chatMessages) return;
        const msgDiv = document.createElement('div');
        msgDiv.classList.add('p-3', 'max-w-[85%]', 'border', 'shadow-sm');
        if (sender === 'user') {
            msgDiv.classList.add('bg-blue-600', 'text-white', 'border-transparent', 'rounded-tl-xl', 'rounded-bl-xl', 'rounded-br-xl', 'self-end');
            msgDiv.textContent = text;
        } else {
            msgDiv.classList.add('bg-gray-200', 'dark:bg-[#3a3a3a]', 'text-gray-900', 'dark:text-white', 'border-transparent', 'dark:border-white/5', 'rounded-tr-xl', 'rounded-bl-xl', 'rounded-br-xl', 'self-start');
            msgDiv.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        }
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function showTypingIndicator() {
        if (!chatMessages) return;
        const typingDiv = document.createElement('div');
        typingDiv.id = 'typing-indicator';
        typingDiv.classList.add('bg-gray-200', 'dark:bg-[#3a3a3a]', 'p-3', 'rounded-tr-xl', 'rounded-bl-xl', 'rounded-br-xl', 'max-w-[85%]', 'self-start', 'border', 'border-transparent', 'dark:border-white/5', 'typing-indicator', 'shadow-sm');
        typingDiv.innerHTML = '<span></span><span></span><span></span>';
        chatMessages.appendChild(typingDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function removeTypingIndicator() {
        const el = document.getElementById('typing-indicator');
        if (el) el.remove();
    }

    async function sendToBackend() {
        const response = await fetch('http://localhost:3000/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation: conversationHistory })
        });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        const data = await response.json();
        if (!data.result) throw new Error('No result in response');
        return data.result;
    }

    if (chatForm) {
        chatForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const text = chatInput.value.trim();
            if (!text) return;
            appendMessage(text, 'user');
            chatInput.value = '';
            chatInput.disabled = true;
            conversationHistory.push({ role: 'user', text });
            showTypingIndicator();
            try {
                const aiText = await sendToBackend();
                conversationHistory.push({ role: 'model', text: aiText });
                removeTypingIndicator();
                appendMessage(aiText, 'ai');
            } catch (err) {
                removeTypingIndicator();
                const errorMsg = err.message.includes('No result') ? 'Sorry, no response received.' : 'Failed to get response from server.';
                appendMessage(errorMsg, 'ai');
                console.error('[WearScrubs Chat]', err);
            } finally {
                chatInput.disabled = false;
                if (chatInput) chatInput.focus();
            }
        });
    }

    // --- UPDATE CART BADGE (all pages, even without catalog.js) ---
    try {
        const _rawCart = localStorage.getItem('ws_cart');
        const _cart = _rawCart ? JSON.parse(_rawCart) : [];
        const _count = Array.isArray(_cart) ? _cart.reduce((s, i) => s + (Number(i.quantity) || 0), 0) : 0;
        document.querySelectorAll('.cart-count').forEach(el => { el.textContent = _count; });
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

    // ── Universal fix: any plain <a> link pointing to an ID-version page ───────
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

    // ── Universal fix: any plain <a> link pointing to an EN-version page ────────
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