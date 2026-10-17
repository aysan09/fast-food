const money = amount => `ETB ${Number(amount).toLocaleString('en-ET')}`;
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let menuItems = [];
let orders = [];
let adminOverview = { today_revenue: 0, completed_orders: 0, average_order: 0, active_tables: 0, total_tables: 0 };
let adminTables = [];
let currentUser = null;
let cart = {};
let waiterCart = {};
let waiterPaymentMethod = 'cash';
let waiterReceiptFile = null;
let activeCategory = 'All items';
let menuSearch = '';
let menuSearchOpen = false;
let selectedTable = new URLSearchParams(location.search).get('table') || new URLSearchParams(location.hash.split('?')[1] || '').get('table') || '05';
let checkoutMethod = 'cbe_transfer';
let paymentChannel = 'telebirr';
let paymentDetails = { account_name: '', telebirr_account: '', cbe_account: '' };
let receiptFile = null;
let toastTimer;
let renderVersion = 0;
let paymentPollTimer;
let socket = window.io ? window.io() : null;

async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        credentials: 'same-origin',
        headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    if (response.status === 204) return null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || 'The request could not be completed.'), { status: response.status });
    return result;
}

function normalizeOrder(order) {
    return {
        id: String(order.id),
        table: order.table_number,
        source: order.source || (order.order_type === 'waiter_assisted' ? 'Waiter' : 'QR menu'),
        payment: order.payment || (order.payment_method === 'cash' ? 'cash' : 'digital'),
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status || order.paymentStatus,
        receiptUrl: order.payment_screenshot_url,
        status: order.status,
        createdAt: Date.parse(order.created_at) || Date.now(),
        total: Number(order.total_amount ?? order.total),
        lines: order.lines || []
    };
}

function route() { return location.hash.replace(/^#\/?/, '').split('?')[0] || 'home'; }
function routeQuery() { return new URLSearchParams(location.hash.split('?')[1] || ''); }
function go(path) { location.hash = `/${path}`; }
function statusName(status) { return ({ in_stock: 'In Stock', out_of_stock: 'Out of Stock', out_of_order: 'Out of Order', discontinued: 'Discontinued' })[status] || status; }
function statusClass(status) { return status === 'in_stock' ? 'badge-stock' : status === 'discontinued' ? 'badge-discontinued' : 'badge-out'; }
function available(item) { return item.status === 'in_stock'; }
function imageUrl(item) { return `https://images.unsplash.com/${item.image}?auto=format&fit=crop&w=720&q=82`; }
function tableBadge() { return `<span class="table-pill">Table ${esc(selectedTable)}</span>`; }
function brand() { return `<a class="brand" href="#/home" aria-label="Ember Kitchen home"><span class="brand-mark">E</span><span><span class="brand-name">EMBER KITCHEN</span><span class="brand-tag">FRESH FROM THE GRILL</span></span></a>`; }
function header(extra = '') { return `<header class="topbar">${brand()}<div class="top-actions"><span class="network-pill"><span class="network-dot"></span>Service live</span>${extra}</div></header>`; }
function staffSidebar(active) {
    const links = [['home', '⌂', 'Portal'], ['cashier', '▤', 'Cashier'], ['waiter', '＋', 'Waiter'], ['admin', '◈', 'Admin']];
    return `<aside class="sidebar"><p class="sidebar-label">Workspaces</p><nav class="side-nav" aria-label="Staff workspaces">${links.map(([path, glyph, label]) => `<a class="side-link ${active === path ? 'active' : ''}" href="#/${path}" aria-label="${label}" title="${label}"><span class="side-glyph">${glyph}</span><span>${label}</span></a>`).join('')}</nav><div class="sidebar-bottom"><strong>EMBER KITCHEN</strong><small>Restaurant operating system</small></div></aside>`;
}
function layout(content, active) { return `${header('<button class="top-link" data-action="logout">Sign out</button>')}<div class="workspace">${staffSidebar(active)}<main class="work-content">${content}</main></div>`; }
function showToast(message, warning = false) {
    document.querySelector('.toast')?.remove();
    const toast = document.createElement('div');
    toast.className = `toast${warning ? ' warning' : ''}`;
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    document.body.append(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 3000);
}

function renderHome() {
    const base = location.href.split('#')[0];
    const qrTarget = `${base}?table=${encodeURIComponent(selectedTable)}#/menu`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=12&data=${encodeURIComponent(qrTarget)}`;
    return `${header('<a class="top-link" href="#/menu">Customer menu <span class="arrow">↗</span></a>')}<main class="page home-page"><section class="home-intro"><div><span class="eyebrow">Restaurant operating system</span><h1>Good food.<br /><em>Clear orders.</em></h1><p class="intro-copy">A simpler way to run the rush. Take orders at the table, keep the menu in sync, and move every ticket forward.</p><div class="hero-actions"><a class="button button-primary" href="#/menu">Open customer menu <span class="arrow">→</span></a><a class="button button-outline" href="#/cashier">Go to cashier</a></div></div><section class="qr-panel" aria-label="Table QR code"><div class="qr-head"><div><span class="qr-label">Scan to order</span><h2>Table ${esc(selectedTable)}</h2></div><span class="active-tag">Active</span></div><div class="qr-main"><img class="qr-image" src="${qrUrl}" alt="QR code for the Table ${esc(selectedTable)} customer menu" /><div class="qr-info"><p>Menu, right at the table.</p><small>Customers land directly on the menu, with their table already selected.</small></div></div><div class="qr-controls"><label for="qr-table">Preview table</label><select id="qr-table" aria-label="Choose QR table">${Array.from({ length: 12 }, (_, index) => `<option value="${String(index + 1).padStart(2, '0')}" ${selectedTable === String(index + 1).padStart(2, '0') ? 'selected' : ''}>Table ${String(index + 1).padStart(2, '0')}</option>`).join('')}</select><a class="top-link" href="${qrUrl}" target="_blank" rel="noreferrer">Print QR ↗</a></div></section></section><section class="portal-section"><div class="section-heading"><div><span class="eyebrow">Staff access</span><h2>Choose your workspace</h2></div><p>Jump into the right part of service.</p></div><div class="role-grid"><a class="role-card" href="#/cashier"><span class="role-icon">▤</span><span class="role-content"><strong>Cashier</strong><span>Orders, payments & kitchen queue</span></span><span class="role-arrow">→</span></a><a class="role-card" href="#/waiter"><span class="role-icon">＋</span><span class="role-content"><strong>Waiter</strong><span>Build an order for any table</span></span><span class="role-arrow">→</span></a><a class="role-card" href="#/admin"><span class="role-icon">◈</span><span class="role-content"><strong>Admin</strong><span>Menu, availability & store pulse</span></span><span class="role-arrow">→</span></a></div></section><footer class="page-footer">EMBER KITCHEN · Restaurant operating system · Addis Ababa, Ethiopia</footer></main>`;
}

function renderHomePortal() {
    const base = location.href.split('#')[0];
    const qrTarget = `${base}?table=${encodeURIComponent(selectedTable)}#/menu`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=12&data=${encodeURIComponent(qrTarget)}`;
    const tables = Array.from({ length: 14 }, (_, index) => String(index + 1).padStart(2, '0'));
    return `<div class="home-portal"><header class="home-portal-header"><a class="brand" href="#/home" aria-label="Ember Kitchen home"><span class="brand-mark">E</span><span><span class="brand-name">EMBER KITCHEN</span><span class="brand-tag">FRESH FROM THE GRILL</span></span></a><span class="home-online"><i></i>Restaurant online</span></header><main class="home-portal-main"><section class="home-portal-copy"><span class="home-portal-eyebrow">STAFF ACCESS PORTAL</span><h1>Run service.<br /><em>Keep it simple.</em></h1><p>Staff workspaces are private. Choose your role and sign in with your assigned Ember Kitchen account.</p><div class="home-access-links"><a class="home-access-card primary" href="#/login?role=cashier"><span class="home-access-icon">▤</span><span><strong>Cashier login</strong><small>Orders &amp; payments</small></span><span class="home-access-arrow">‹</span></a><a class="home-access-card" href="#/login?role=admin"><span class="home-access-icon">▥</span><span><strong>Admin login</strong><small>Reports &amp; menu</small></span><span class="home-access-arrow">‹</span></a></div><a class="home-waiter-link" href="#/login?role=waiter">Waiter sign in</a></section><section class="home-qr-card" aria-label="Customer menu QR code"><header class="home-qr-heading"><div><span>TABLE ${esc(selectedTable)}</span><h2>Customer menu QR</h2></div><span class="home-qr-active">Active</span></header><img class="home-qr-image" src="${qrUrl}" alt="QR code linking customers to the Table ${esc(selectedTable)} menu" /><h3>Scan to order from Table ${esc(selectedTable)}</h3><p>Customers go directly to the menu. Staff dashboards and login links are not shown in their experience.</p><div class="home-qr-actions"><label class="home-table-select"><span class="sr-only">Preview table</span><select id="qr-table" aria-label="Choose QR table">${tables.map(table => `<option value="${table}" ${selectedTable === table ? 'selected' : ''}>Table ${table}</option>`).join('')}</select></label><a href="${qrUrl}" target="_blank" rel="noreferrer" class="home-print-link"><span aria-hidden="true">▦</span>Open printable QR code</a></div></section></main><footer class="home-portal-footer">EMBER KITCHEN · RESTAURANT OPERATING SYSTEM</footer></div>`;
}

function cartCount(target = cart) { return Object.values(target).reduce((sum, quantity) => sum + quantity, 0); }
function cartTotal(target = cart) { return Object.entries(target).reduce((sum, [id, quantity]) => sum + (menuItems.find(item => item.id === id)?.price || 0) * quantity, 0); }
function renderCart(target = cart, waiter = false) {
    const entries = Object.entries(target).filter(([, quantity]) => quantity > 0);
    return `<aside class="${waiter ? 'waiter-summary' : 'cart-panel'} ${!waiter && mobileCartOpen ? 'open' : ''}" id="cart-panel"><div class="cart-head"><h2>${waiter ? 'Order summary' : 'Your order'}</h2><span class="cart-count">${cartCount(target)}</span></div>${entries.length ? `<div class="cart-lines">${entries.map(([id, quantity]) => { const item = menuItems.find(entry => entry.id === id); if (!item) return ''; return `<div class="cart-line"><div><span class="cart-line-name">${esc(item.name)}</span><div class="quantity-control"><button data-qty="${waiter ? 'waiter' : 'cart'}" data-id="${esc(id)}" data-delta="-1" aria-label="Remove one ${esc(item.name)}">−</button><span>${quantity}</span><button data-qty="${waiter ? 'waiter' : 'cart'}" data-id="${esc(id)}" data-delta="1" aria-label="Add one ${esc(item.name)}">+</button></div></div><span class="cart-line-price">${money(item.price * quantity)}</span></div>`; }).join('')}</div>` : `<p class="cart-empty">${waiter ? 'Add menu items to start this table’s order.' : 'Your cart is ready when you are. Add a favorite from the menu.'}</p>`}<div class="cart-subtotal"><span>Total</span><span>${money(cartTotal(target))}</span></div>${waiter ? `<button type="button" class="button button-primary" data-action="submit-waiter" ${entries.length ? '' : 'disabled'}>Review customer order <span class="arrow">→</span></button>` : `<button class="button button-primary" data-action="checkout" ${entries.length ? '' : 'disabled'}>Continue to checkout <span class="arrow">→</span></button>`}</aside>`;
}
let mobileCartOpen = false;
function renderCustomer() {
    const categories = ['All items', ...new Set(menuItems.map(item => item.category))];
    const visible = menuItems.filter(item => activeCategory === 'All items' || item.category === activeCategory);
    const cards = visible.map(item => `<article class="food-card"><div class="food-photo">${item.image ? `<img src="${imageUrl(item)}" alt="${esc(item.name)}" loading="lazy" />` : '<div class="food-placeholder" aria-hidden="true">E</div>'}<span class="food-status tiny-badge ${statusClass(item.status)}">${esc(statusName(item.status))}</span></div><div class="food-card-content"><div class="food-name-row"><h3>${esc(item.name)}</h3><span class="food-price">${money(item.price)}</span></div><p>${esc(item.description || item.category)}</p><button class="add-button" data-action="add-cart" data-id="${esc(item.id)}" ${available(item) ? '' : 'disabled'}>${available(item) ? '＋ Add to order' : 'Currently unavailable'}</button></div></article>`).join('');
    return `${header(tableBadge())}<main class="page customer-page"><section class="customer-banner"><div><span class="eyebrow">Fresh from the grill</span><h1>Made for your<br />kind of hungry.</h1><p>Good things are cooking. Pick your favorites.</p></div><div class="banner-stamp">Made<br />fresh</div></section><div class="menu-toolbar"><h2>Explore the menu</h2><span class="menu-count">${visible.length} ${visible.length === 1 ? 'item' : 'items'}</span></div><div class="category-list" role="tablist" aria-label="Menu categories">${categories.map(category => `<button class="category-button ${activeCategory === category ? 'active' : ''}" role="tab" aria-selected="${activeCategory === category}" data-action="category" data-category="${esc(category)}">${esc(category)}</button>`).join('')}</div><div class="customer-layout"><section class="menu-grid" aria-label="Menu items">${cards || '<p>No menu items in this category yet.</p>'}</section>${renderCart()}</div><button class="mobile-cart-bar" data-action="toggle-cart"><span>${cartCount()} items in your order</span><span>${money(cartTotal())}　→</span></button></main>`;
}

function menuDisplayCategory(item) {
    const category = String(item.category || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();
    if (category.includes('dessert') || name.includes('dessert')) return 'Desserts';
    if (category === 'juice' || name.includes('juice')) return 'Juice';
    if (['drink', 'drinks', 'beverage', 'beverages'].includes(category)) return 'Drinks';
    return 'Food';
}

function filteredMenuItems() {
    const query = menuSearch.trim().toLowerCase();
    return menuItems.filter(item => {
        const matchesCategory = activeCategory === 'All items'
            || (['Food', 'Drinks', 'Juice', 'Desserts'].includes(activeCategory)
                ? menuDisplayCategory(item) === activeCategory
                : item.category === activeCategory);
        return matchesCategory && (!query || `${item.name} ${item.description || ''} ${item.category}`.toLowerCase().includes(query));
    });
}

function renderMenuCards(items) {
    if (!items.length) return '<p class="menu-empty">No menu items match your search.</p>';
    return items.map((item, index) => `<article class="menu-food-card"><div class="menu-food-image">${item.image ? `<img src="${imageUrl(item)}" alt="${esc(item.name)}" loading="${index < 4 ? 'eager' : 'lazy'}" />` : '<span aria-hidden="true">E</span>'}${available(item) ? '' : '<span class="menu-sold-out">Unavailable</span>'}</div><div class="menu-food-content"><h3>${esc(item.name)}</h3><p>${esc(item.description || item.category)}</p><div class="menu-food-bottom"><strong>${money(item.price)}</strong><button class="menu-add-button" data-action="add-cart" data-id="${esc(item.id)}" aria-label="Add ${esc(item.name)} to order" ${available(item) ? '' : 'disabled'}>${available(item) ? '+' : '−'}</button></div></div></article>`).join('');
}

function renderCustomerMenu() {
    const categories = ['All items', 'Food', 'Drinks', 'Juice', 'Desserts'];
    const visible = filteredMenuItems();
    return `<div class="customer-menu"><header class="customer-menu-header"><a class="brand" href="#/home" aria-label="Ember Kitchen home"><span class="brand-mark">E</span><span><span class="brand-name">EMBER KITCHEN</span><span class="brand-tag">FRESH FROM THE GRILL</span></span></a><span class="customer-table"><i></i>Table ${esc(selectedTable)}</span></header><main class="customer-menu-main"><section class="menu-welcome"><span class="eyebrow">Fresh off the grill</span><div class="menu-welcome-row"><h1>Find your next<br />favourite.</h1><button class="menu-search-toggle" type="button" data-action="toggle-menu-search" aria-label="Search menu" title="Search menu">⌕</button></div>${menuSearchOpen ? `<input class="menu-search-input" id="menu-search" type="search" placeholder="Search dishes" value="${esc(menuSearch)}" aria-label="Search dishes" />` : ''}</section><nav class="menu-category-strip" role="tablist" aria-label="Menu categories">${categories.map(category => `<button class="menu-category-chip ${activeCategory === category ? 'active' : ''}" role="tab" aria-selected="${activeCategory === category}" data-action="category" data-category="${esc(category)}">${esc(category)}</button>`).join('')}</nav><div class="menu-toolbar"><h2 id="menu-heading">${esc(activeCategory)}</h2><span class="menu-count" id="menu-count">${visible.length} ${visible.length === 1 ? 'item' : 'items'}</span></div><div class="customer-menu-layout"><section class="menu-food-grid" id="menu-grid" aria-label="Menu items">${renderMenuCards(visible)}</section>${renderCart()}</div></main><button class="customer-cartbar" data-action="checkout" ${cartCount() ? '' : 'disabled'}><span class="customer-cart-icon" aria-hidden="true">▣</span><span class="customer-cart-summary"><small>${cartCount()} ${cartCount() === 1 ? 'item' : 'items'}</small><strong>${money(cartTotal())}</strong></span><span class="customer-cart-checkout">Checkout</span><span class="customer-cart-arrow" aria-hidden="true">‹</span></button></div>`;
}

function renderCheckout() {
    const lines = Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => { const item = menuItems.find(entry => entry.id === id); return item ? `<div class="checkout-line"><span>${quantity} × ${esc(item.name)}</span><strong>${money(item.price * quantity)}</strong></div>` : ''; }).join('');
    return `${header(tableBadge())}<main class="checkout-wrap"><a class="back-link" href="#/menu">← Back to menu</a><span class="eyebrow">Nearly there</span><h1>Review your order</h1><p class="checkout-sub">Table ${esc(selectedTable)} · Your order is prepared fresh.</p>${cartCount() ? `<form class="checkout-layout" id="checkout-form"><section class="checkout-panel"><h2>How would you like to pay?</h2><div class="payment-options"><label class="payment-option"><input type="radio" name="payment" value="digital" ${checkoutMethod === 'digital' ? 'checked' : ''} /><span><strong>Pay from your phone</strong><small>Approve a secure payment prompt</small></span></label>${checkoutMethod === 'digital' ? `<div class="gateway-options" role="group" aria-label="Choose mobile money provider"><button class="gateway-chip ${paymentChannel === 'telebirr' ? 'active' : ''}" type="button" data-action="payment-channel" data-channel="telebirr" aria-pressed="${paymentChannel === 'telebirr'}">Telebirr</button><button class="gateway-chip ${paymentChannel === 'cbebirr' ? 'active' : ''}" type="button" data-action="payment-channel" data-channel="cbebirr" aria-pressed="${paymentChannel === 'cbebirr'}">CBE Birr</button></div><div class="checkout-contact"><div class="field"><label for="checkout-phone">Mobile money phone number</label><input id="checkout-phone" name="phone_number" type="tel" autocomplete="tel" placeholder="0912345678" pattern="(\\+251|251|0)[79][0-9]{8}" required /></div><p class="demo-note">We’ll send an approval prompt to your phone. Keep it nearby; your order goes to the kitchen after payment is confirmed.</p></div>` : ''}<label class="payment-option"><input type="radio" name="payment" value="cash" ${checkoutMethod === 'cash' ? 'checked' : ''} /><span><strong>Cash at counter</strong><small>Pay the cashier before we start your order</small></span></label>${checkoutMethod === 'cash' ? '<p class="demo-note">Cash orders stay pending until a cashier confirms receipt.</p>' : ''}</section><section class="checkout-panel"><h2>Order summary</h2>${lines}<div class="checkout-total"><span>Total due</span><span>${money(cartTotal())}</span></div><button class="button button-primary" style="width:100%" type="submit">${checkoutMethod === 'cash' ? 'Request cash approval' : `Send ${paymentChannel === 'cbebirr' ? 'CBE Birr' : 'Telebirr'} prompt`} <span class="arrow">→</span></button></section></form>` : `<section class="checkout-panel"><p>Your cart is empty.</p><a class="button button-primary" href="#/menu">Back to menu</a></section>`}</main>`;
}

function renderTransferCheckout() {
    const lines = Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => {
        const item = menuItems.find(entry => entry.id === id);
        return item ? `<div class="checkout-line"><span>${quantity} × ${esc(item.name)}</span><strong>${money(item.price * quantity)}</strong></div>` : '';
    }).join('');
    const isTransfer = ['telebirr_transfer', 'cbe_transfer'].includes(checkoutMethod);
    const account = checkoutMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account;
    const accountLabel = checkoutMethod === 'cbe_transfer' ? 'CBE account number' : 'Telebirr account';
    const submitDisabled = isTransfer && (!receiptFile || !account);
    const paymentChoices = [
        ['telebirr_transfer', 'Telebirr transfer', 'Transfer to the restaurant account, then attach your receipt.'],
        ['cbe_transfer', 'CBE transfer', 'Transfer to the restaurant account, then attach your receipt.'],
        ['digital', 'Phone prompt', 'Approve a secure Chapa payment prompt.'],
        ['cash', 'Cash at counter', 'Pay the cashier before we start your order.']
    ];
    return `${header(tableBadge())}<main class="checkout-wrap"><a class="back-link" href="#/menu">← Back to menu</a><span class="eyebrow">Nearly there</span><h1>Review your order</h1><p class="checkout-sub">Table ${esc(selectedTable)} · Your order is prepared fresh.</p>${cartCount() ? `<form class="checkout-layout" id="checkout-form"><section class="checkout-panel"><h2>How would you like to pay?</h2><div class="payment-options">${paymentChoices.map(([value, title, description]) => `<label class="payment-option"><input type="radio" name="payment" value="${value}" ${checkoutMethod === value ? 'checked' : ''} /><span><strong>${title}</strong><small>${description}</small></span></label>`).join('')}
        ${isTransfer ? `<section class="transfer-details"><div><span class="eyebrow">TRANSFER TO</span><h3>${checkoutMethod === 'cbe_transfer' ? 'CBE' : 'Telebirr'}</h3></div><div class="account-row"><span><small>${accountLabel}</small><strong>${esc(account || 'Account details not configured')}</strong></span>${account ? `<button class="button button-outline copy-account" type="button" data-action="copy-account" data-account="${esc(account)}">Copy</button>` : ''}</div>${paymentDetails.account_name ? `<p class="account-owner">Account name: <strong>${esc(paymentDetails.account_name)}</strong></p>` : ''}<div class="field receipt-field"><label for="receipt-image">Transfer receipt screenshot</label><input id="receipt-image" name="receipt_image" type="file" accept="image/*" /><small id="receipt-file-name">${receiptFile ? esc(receiptFile.name) : 'JPG, PNG, or WebP, up to 5 MB'}</small></div>${!account ? '<p class="demo-note">Restaurant transfer details are not configured. Please contact the restaurant.</p>' : '<p class="demo-note">Complete the transfer outside the app, then attach its receipt. The cashier will verify it before sending your order to the kitchen.</p>'}</section>` : ''}
        ${checkoutMethod === 'digital' ? `<div class="gateway-options" role="group" aria-label="Choose mobile money provider"><button class="gateway-chip ${paymentChannel === 'telebirr' ? 'active' : ''}" type="button" data-action="payment-channel" data-channel="telebirr" aria-pressed="${paymentChannel === 'telebirr'}">Telebirr</button><button class="gateway-chip ${paymentChannel === 'cbebirr' ? 'active' : ''}" type="button" data-action="payment-channel" data-channel="cbebirr" aria-pressed="${paymentChannel === 'cbebirr'}">CBE Birr</button></div><div class="field"><label for="checkout-phone">Mobile money phone number</label><input id="checkout-phone" name="phone_number" type="tel" autocomplete="tel" placeholder="0912345678" pattern="(\\+251|251|0)[79][0-9]{8}" required /></div>` : ''}
        ${checkoutMethod === 'cash' ? '<p class="demo-note">Cash orders stay pending until a cashier confirms receipt.</p>' : ''}</div></section><aside class="checkout-panel"><h2>Your order</h2>${lines}<div class="checkout-total"><span>Total</span><span>${money(cartTotal())}</span></div><button class="button button-primary" type="submit" ${submitDisabled ? 'disabled' : ''}>${isTransfer ? 'Submit for cashier review' : checkoutMethod === 'digital' ? 'Send payment prompt' : 'Place cash order'} <span class="arrow">→</span></button></aside></form>` : '<p>Your cart is empty.</p>'}</main>`;
}

function renderReviewOrder() {
    const entries = Object.entries(cart).filter(([, quantity]) => quantity > 0);
    const lines = entries.map(([id, quantity]) => {
        const item = menuItems.find(entry => entry.id === id);
        if (!item) return '';
        return `<article class="review-item"><div class="review-item-image">${item.image ? `<img src="${imageUrl(item)}" alt="${esc(item.name)}" />` : '<span aria-hidden="true">E</span>'}</div><div class="review-item-info"><strong>${esc(item.name)}</strong><small>${money(item.price)}</small><div class="review-quantity"><button type="button" data-qty="cart" data-id="${esc(id)}" data-delta="-1" aria-label="Remove one ${esc(item.name)}">−</button><span>${quantity}</span><button type="button" data-qty="cart" data-id="${esc(id)}" data-delta="1" aria-label="Add one ${esc(item.name)}">+</button></div></div><strong class="review-item-total">${money(item.price * quantity)}</strong></article>`;
    }).join('');
    const isTransfer = ['telebirr_transfer', 'cbe_transfer'].includes(checkoutMethod);
    const account = checkoutMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account;
    const bankLabel = checkoutMethod === 'cbe_transfer' ? 'CBE ACCOUNT NUMBER' : 'TELEBIRR ACCOUNT';
    const paymentChoices = [
        ['telebirr_transfer', '▣', 'Telebirr transfer', 'Send payment from your Telebirr wallet'],
        ['cbe_transfer', '⌂', 'Bank account transfer', 'Transfer from CBE or another banking app'],
        ['cash', '▤', 'Cash at counter', 'Pay after confirming your order']
    ];
    const disabled = isTransfer && (!receiptFile || !account);
    const actionLabel = isTransfer ? (receiptFile ? 'Submit order for review' : 'Upload screenshot to continue') : checkoutMethod === 'digital' ? 'Send payment prompt' : 'Place cash order';
    return `<div class="review-page"><header class="review-header"><a class="review-back" href="#/menu" aria-label="Back to menu">‹</a><div><small>TABLE ${esc(selectedTable)}</small><strong>Checkout</strong></div></header><form class="review-form" id="checkout-form"><main class="review-content"><section class="review-section"><div class="review-section-heading"><div><span>YOUR ORDER</span><h1>Order summary</h1></div><small>${cartCount()} ${cartCount() === 1 ? 'item' : 'items'}</small></div><div class="review-order-card">${lines}<div class="review-total"><strong>Total</strong><strong>${money(cartTotal())}</strong></div></div></section><section class="review-section payment-review"><div class="review-section-heading"><div><span>SECURE PAYMENT</span><h2>Choose payment method</h2></div></div><div class="review-methods">${paymentChoices.map(([value, icon, title, description]) => `<label class="review-method ${checkoutMethod === value ? 'selected' : ''}"><span class="review-method-icon" aria-hidden="true">${icon}</span><span class="review-method-copy"><strong>${title}</strong><small>${description}</small></span><input type="radio" name="payment" value="${value}" ${checkoutMethod === value ? 'checked' : ''} /></label>`).join('')}</div>${isTransfer ? `<section class="review-transfer"><div class="review-account"><div><small>${bankLabel}</small><strong>${esc(account || 'Account details not configured')}</strong><span>Account name: ${esc(paymentDetails.account_name || 'Not configured')}</span></div>${account ? `<button type="button" class="review-copy" data-action="copy-account" data-account="${esc(account)}">Copy</button>` : ''}</div><div class="review-upload-head"><div><strong>Transfer screenshot</strong><span>Complete your bank transfer, then upload a clear screenshot as proof.</span></div><small class="required-pill">REQUIRED</small></div><label class="review-upload" for="receipt-image"><span class="review-upload-icon">↑</span><span><strong>${receiptFile ? 'Screenshot attached' : 'Upload payment screenshot'}</strong><small id="receipt-file-name">${receiptFile ? esc(receiptFile.name) : 'PNG, JPG or photo from your phone'}</small></span><input id="receipt-image" name="receipt_image" type="file" accept="image/*" /></label>${!account ? '<p class="review-config-note">Restaurant transfer details are not configured.</p>' : ''}</section>` : ''}${checkoutMethod === 'digital' ? `<div class="gateway-options" role="group" aria-label="Choose mobile money provider"><button class="gateway-chip ${paymentChannel === 'telebirr' ? 'active' : ''}" type="button" data-action="payment-channel" data-channel="telebirr" aria-pressed="${paymentChannel === 'telebirr'}">Telebirr</button><button class="gateway-chip ${paymentChannel === 'cbebirr' ? 'active' : ''}" type="button" data-action="payment-channel" data-channel="cbebirr" aria-pressed="${paymentChannel === 'cbebirr'}">CBE Birr</button></div><div class="field review-phone"><label for="checkout-phone">Mobile money phone number</label><input id="checkout-phone" name="phone_number" type="tel" autocomplete="tel" placeholder="0912345678" pattern="(\\+251|251|0)[79][0-9]{8}" required /></div>` : ''}<button type="button" class="review-phone-link" data-action="use-phone-payment">Use a secure phone prompt instead</button></section></main><footer class="review-submitbar"><button class="review-submit" type="submit" ${disabled ? 'disabled' : ''}><span id="checkout-submit-label">${actionLabel}</span><strong>${money(cartTotal())}</strong></button></footer></form></div>`;
}

function renderConfirmation(order) {
    const isCash = order.payment_method === 'cash';
    const isTransfer = ['telebirr_transfer', 'cbe_transfer'].includes(order.payment_method);
    const paid = order.payment_status === 'paid';
    const heading = isTransfer ? 'Transfer received for review.' : paid ? 'Thanks, we’ve got it.' : 'Pay at the counter.';
    const status = isTransfer ? 'Awaiting cashier verification' : paid ? 'Payment confirmed' : 'Cash order received';
    const message = isTransfer ? 'The cashier will compare your receipt with the bank notification. Your order goes to the kitchen after approval.' : isCash ? 'Show this order to the cashier. It will enter the kitchen once cash is confirmed.' : 'Your verified payment is confirmed. The kitchen has received your order.';
    const waiterSubmitted = routeQuery().get('source') === 'waiter';
    const confirmationHeading = waiterSubmitted ? 'Order sent to cashier.' : heading;
    const confirmationStatus = waiterSubmitted ? 'Waiting for cashier' : status;
    const confirmationMessage = waiterSubmitted
        ? isTransfer ? 'The customer payment receipt was attached. The cashier will verify it and send the order to the kitchen.' : 'The cashier received the order and will confirm the customer’s cash payment before sending it to the kitchen.'
        : message;
    const returnLink = waiterSubmitted ? '<a class="button button-primary" href="#/waiter">Take another order</a>' : '<a class="button button-primary" href="#/menu">Keep browsing</a>';
    return `${header(`<span class="table-pill">Table ${esc(order.table_number)}</span>`)}<main class="confirmation"><div class="confirmation-mark">${waiterSubmitted ? '✓' : paid ? '✓' : '…'}</div><span class="eyebrow">${confirmationStatus}</span><h1>${confirmationHeading}</h1><p>Order <strong>#${esc(order.order_id)}</strong> for Table ${esc(order.table_number)}<br />${confirmationMessage}</p><div class="checkout-total"><span>Order total</span><span>${money(order.total_amount)}</span></div>${returnLink}</main>`;
}

function renderPaymentReturn(order) {
    if (order.payment_status === 'paid') {
        location.hash = `/confirmation?token=${encodeURIComponent(routeQuery().get('token'))}`;
        return '<main class="confirmation"><p>Payment verified. Loading your order…</p></main>';
    }
    if (order.payment_status === 'failed' || order.status === 'cancelled') {
        return `${header()}<main class="confirmation"><div class="confirmation-mark">!</div><span class="eyebrow">Payment not completed</span><h1>Your order is still safe.</h1><p>Chapa could not confirm the payment. Return to the menu and try checkout again, or pay at the counter.</p><a class="button button-primary" href="#/menu">Back to menu</a></main>`;
    }
    clearTimeout(paymentPollTimer);
    paymentPollTimer = setTimeout(() => { if (route() === 'payment-return') render(); }, 2500);
    const channel = order.payment_channel === 'cbebirr' ? 'CBE Birr' : 'Telebirr';
    return `${header()}<main class="confirmation"><div class="confirmation-mark">…</div><span class="eyebrow">Phone approval</span><h1>Waiting for approval on your phone.</h1><p>Approve the ${channel} prompt for ${money(order.total_amount)}. We’ll send your order to the kitchen as soon as payment is verified.</p><span class="network-pill"><span class="network-dot"></span>Checking payment status</span></main>`;
}

function renderLogin(role) {
    const selectedRole = ['cashier', 'admin', 'waiter'].includes(role) ? role : 'cashier';
    const email = selectedRole === 'admin' ? 'admin@ember.et' : selectedRole === 'cashier' ? 'cashier@ember.et' : 'waiter@ember.et';
    return `<main class="login-page"><section class="login-shell"><a class="login-back" href="#/home"><span aria-hidden="true">‹</span> Back to home</a><a class="login-brand" href="#/home" aria-label="Ember Kitchen home"><span class="brand-mark">E</span><span><strong>EMBER KITCHEN</strong><small>FRESH FROM THE GRILL</small></span></a><div class="login-intro"><span class="login-eyebrow">STAFF SIGN IN</span><h1>Welcome back</h1><p>Select your role and enter your credentials.</p></div><form class="login-form" id="staff-login-form"><div class="login-role-switch" role="group" aria-label="Choose staff role"><button type="button" class="login-role-button ${selectedRole === 'cashier' ? 'active' : ''}" data-action="login-role" data-role="cashier" aria-pressed="${selectedRole === 'cashier'}"><span aria-hidden="true">▤</span>Cashier</button><button type="button" class="login-role-button ${selectedRole === 'admin' ? 'active' : ''}" data-action="login-role" data-role="admin" aria-pressed="${selectedRole === 'admin'}"><span aria-hidden="true">▥</span>Admin</button></div><input id="staff-role" name="role" type="hidden" value="${selectedRole}" /><div class="login-fields"><div class="login-field"><label for="staff-email">Email address</label><input id="staff-email" name="email" type="email" autocomplete="username" value="${email}" required /></div><div class="login-field"><label for="staff-password">Password</label><input id="staff-password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required /></div></div><p class="login-error" id="login-error" role="alert"></p><button class="login-submit" type="submit"><span id="login-submit-label">Sign in as ${selectedRole}</span><span aria-hidden="true">‹</span></button></form><aside class="login-account-note"><span>ACCOUNT ACCESS</span><p>Staff credentials are configured by your restaurant administrator.</p></aside><button type="button" class="login-waiter-link" data-action="login-role" data-role="waiter">Waiter sign in</button></section></main>`;
}

function renderLoginScreen(role) {
    return `<div class="login-split"><aside class="login-story"><a class="login-story-brand" href="#/home" aria-label="Ember Kitchen home"><span class="brand-mark">E</span><span><strong>EMBER KITCHEN</strong><small>FRESH FROM THE GRILL</small></span></a><div class="login-story-copy"><span class="login-eyebrow">PRIVATE STAFF ACCESS</span><h2>Great service starts<br />with a clear view.</h2><p>Sign in to manage orders, payments, menus, and restaurant performance.</p></div><small class="login-story-footer">EMBER KITCHEN · SECURE WORKSPACE</small></aside><section class="login-panel">${renderLogin(role)}</section></div>`;
}

function renderWaiterPaymentDialog() {
    const selectedAccount = waiterPaymentMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account;
    const accountLabel = waiterPaymentMethod === 'cbe_transfer' ? 'CBE account number' : 'Telebirr account';
    const requiresReceipt = ['telebirr_transfer', 'cbe_transfer'].includes(waiterPaymentMethod);
    return `<dialog class="waiter-checkout-dialog" id="waiter-checkout-dialog"><form id="waiter-order-form"><header class="waiter-dialog-heading"><div><span class="eyebrow">TABLE ${esc(selectedTable)}</span><h2>Confirm customer order</h2></div><button type="button" class="waiter-dialog-close" data-action="close-waiter-checkout" aria-label="Close">×</button></header><p class="waiter-dialog-copy">Choose how the customer paid. The cashier will verify the order before it enters the kitchen.</p><div class="waiter-payment-options"><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="cash" ${waiterPaymentMethod === 'cash' ? 'checked' : ''} /><span><strong>Cash</strong><small>Cashier confirms payment</small></span></label><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="telebirr_transfer" ${waiterPaymentMethod === 'telebirr_transfer' ? 'checked' : ''} /><span><strong>Telebirr transfer</strong><small>Attach the customer's payment receipt</small></span></label><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="cbe_transfer" ${waiterPaymentMethod === 'cbe_transfer' ? 'checked' : ''} /><span><strong>Bank transfer</strong><small>Attach the customer's payment receipt</small></span></label></div><div class="waiter-transfer-account" id="waiter-transfer-account" ${requiresReceipt ? '' : 'hidden'}><span>${accountLabel}</span><strong>${esc(selectedAccount || 'Account details not configured')}</strong><small>Account name: ${esc(paymentDetails.account_name || 'Not configured')}</small></div><section class="waiter-receipt-section" id="waiter-receipt-section" ${requiresReceipt ? '' : 'hidden'}><label for="waiter-receipt-image">Customer payment screenshot <span>Required</span></label><input id="waiter-receipt-image" name="receipt_image" type="file" accept="image/jpeg,image/png,image/webp" /><small id="waiter-receipt-file-name">${waiterReceiptFile ? esc(waiterReceiptFile.name) : 'Attach the transfer receipt, up to 5 MB.'}</small></section><div class="waiter-dialog-total"><span>${cartCount(waiterCart)} items · Table ${esc(selectedTable)}</span><strong>${money(cartTotal(waiterCart))}</strong></div><button class="button button-primary waiter-submit-order" type="submit" ${requiresReceipt && !waiterReceiptFile ? 'disabled' : ''}>Send order to cashier</button></form></dialog>`;
}

function renderWaiterPaymentReview() {
    const requiresReceipt = ['telebirr_transfer', 'cbe_transfer'].includes(waiterPaymentMethod);
    const selectedAccount = waiterPaymentMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account;
    return `<dialog class="waiter-checkout-dialog" id="waiter-checkout-dialog"><form id="waiter-order-form"><header class="waiter-dialog-heading"><div><span class="eyebrow">TABLE ${esc(selectedTable)}</span><h2>Confirm customer order</h2></div><button type="button" class="waiter-dialog-close" data-action="close-waiter-checkout" aria-label="Close">×</button></header><p class="waiter-dialog-copy">Choose how the customer paid. The cashier will verify this order before it enters the kitchen.</p><div class="waiter-payment-options"><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="cash" ${waiterPaymentMethod === 'cash' ? 'checked' : ''} /><span><strong>Cash</strong><small>Cashier confirms payment</small></span></label><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="telebirr_transfer" ${waiterPaymentMethod === 'telebirr_transfer' ? 'checked' : ''} /><span><strong>Telebirr transfer</strong><small>Attach the customer's payment receipt</small></span></label><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="cbe_transfer" ${waiterPaymentMethod === 'cbe_transfer' ? 'checked' : ''} /><span><strong>Bank transfer</strong><small>Attach the customer's payment receipt</small></span></label></div><div class="waiter-transfer-account" id="waiter-transfer-account" ${requiresReceipt ? '' : 'hidden'}><span id="waiter-account-label">Telebirr account</span><strong id="waiter-account-number">${esc(selectedAccount || 'Account details not configured')}</strong><small id="waiter-account-name">Account name: ${esc(paymentDetails.account_name || 'Not configured')}</small></div><section class="waiter-receipt-section" id="waiter-receipt-section" ${requiresReceipt ? '' : 'hidden'}><label for="waiter-receipt-image">Customer payment screenshot <span>Required</span></label><input id="waiter-receipt-image" name="receipt_image" type="file" accept="image/*" /><small id="waiter-receipt-file-name">${waiterReceiptFile ? esc(waiterReceiptFile.name) : 'Attach the transfer receipt, up to 5 MB.'}</small></section><div class="waiter-dialog-total"><span>${cartCount(waiterCart)} items · Table ${esc(selectedTable)}</span><strong>${money(cartTotal(waiterCart))}</strong></div><button class="button button-primary waiter-submit-order" type="submit" ${requiresReceipt && (!waiterReceiptFile || !selectedAccount) ? 'disabled' : ''}>Send order to cashier</button></form></dialog>`;
}

function renderWaiter() {
    const rows = menuItems.map(item => `<div class="waiter-row"><div><strong>${esc(item.name)}</strong><small>${esc(statusName(item.status))}</small></div><span class="food-price">${money(item.price)}</span><div class="quantity-control"><button data-qty="waiter" data-id="${esc(item.id)}" data-delta="-1" aria-label="Remove one ${esc(item.name)}" ${!waiterCart[item.id] ? 'disabled' : ''}>−</button><span>${waiterCart[item.id] || 0}</span><button data-qty="waiter" data-id="${esc(item.id)}" data-delta="1" aria-label="Add one ${esc(item.name)}" ${available(item) ? '' : 'disabled'}>+</button></div></div>`).join('');
    return `${layout(`<div class="work-top"><div><span class="breadcrumb">Service / Waiter</span><h1>Build an order</h1><p>Take an order at the table and send it to the cashier for payment.</p></div><div class="work-top-right">${tableBadge()}</div></div><div class="waiter-layout"><section><div class="waiter-controls"><div class="field"><label for="waiter-table">Select table</label><select id="waiter-table" class="field-control">${Array.from({ length: 12 }, (_, index) => `<option value="${String(index + 1).padStart(2, '0')}" ${selectedTable === String(index + 1).padStart(2, '0') ? 'selected' : ''}>Table ${String(index + 1).padStart(2, '0')}</option>`).join('')}</select></div><span class="live-tag"><span class="network-dot"></span>Menu availability live</span></div><div class="waiter-menu">${rows}</div></section>${renderCart(waiterCart, true)}</div>`, 'waiter')}${renderWaiterPaymentReview()}`;
}

function renderWaiterPortal() {
    const menuRows = menuItems.map(item => `<article class="waiter-row"><div class="waiter-item-info"><strong>${esc(item.name)}</strong><small class="${available(item) ? 'waiter-stock' : 'waiter-out'}">${esc(statusName(item.status))}</small></div><span class="waiter-row-price">${money(item.price)}</span><div class="quantity-control"><button type="button" data-qty="waiter" data-id="${esc(item.id)}" data-delta="-1" aria-label="Remove one ${esc(item.name)}" ${!waiterCart[item.id] ? 'disabled' : ''}>−</button><span>${waiterCart[item.id] || 0}</span><button type="button" data-qty="waiter" data-id="${esc(item.id)}" data-delta="1" aria-label="Add one ${esc(item.name)}" ${available(item) ? '' : 'disabled'}>+</button></div></article>`).join('');
    const waiterName = esc(currentUser?.name || 'Waiter');
    return `<div class="admin-shell waiter-shell"><aside class="admin-sidebar waiter-sidebar"><a class="admin-brand" href="#/home" aria-label="Ember Kitchen home"><span class="admin-brand-mark">E</span><span><strong>EMBER KITCHEN</strong><small>FRESH FROM THE GRILL</small></span></a><div class="admin-role"><span>WORKSPACE</span><strong>Waiter</strong></div><nav class="admin-nav" aria-label="Waiter workspace"><a class="admin-nav-link active" href="#/waiter" aria-current="page"><span>＋</span>New order</a><a class="admin-nav-link" href="#/menu"><span>▣</span>Customer menu</a></nav><div class="admin-sidebar-footer"><button class="admin-utility-link" data-action="logout"><span>⌂</span><span><strong>Sign out</strong><small>Return to staff portal</small></span></button><a class="admin-utility-link" href="#/menu"><span>▣</span><span><strong>Customer app</strong><small>Preview customer menu</small></span></a><div class="admin-profile"><span class="admin-avatar">${waiterName.slice(0, 1).toUpperCase()}</span><span><strong>${waiterName}</strong><small>Waiter workspace</small></span></div></div></aside><div class="admin-main waiter-main"><header class="admin-topbar"><div><h1>Waiter portal</h1><p>Build customer orders and send payment receipts to the cashier.</p></div><span class="waiter-live-status"><i></i>Menu availability live</span></header><main class="admin-content waiter-content"><section class="waiter-greeting"><div><span class="admin-eyebrow">ORDER SERVICE</span><h2>Build a customer order</h2><p>Select the table, add the customer’s items, then record payment.</p></div><label class="waiter-table-control"><span>TABLE</span><select id="waiter-table" aria-label="Select table">${Array.from({ length: 14 }, (_, index) => `<option value="${String(index + 1).padStart(2, '0')}" ${selectedTable === String(index + 1).padStart(2, '0') ? 'selected' : ''}>Table ${String(index + 1).padStart(2, '0')}</option>`).join('')}</select></label></section><div class="waiter-builder-grid"><section class="waiter-catalog-panel"><header class="waiter-catalog-heading"><div><h3>Menu items</h3><p>Tap + to add items to the customer’s order.</p></div><span>${menuItems.length} items</span></header><div class="waiter-menu">${menuRows || '<p class="waiter-empty-menu">No menu items available.</p>'}</div></section>${renderCart(waiterCart, true)}</div></main></div>${renderWaiterPaymentReview()}</div>`;
}

function renderAdminLegacy() {
    const inStock = menuItems.filter(item => item.status === 'in_stock').length;
    const outCount = menuItems.length - inStock;
    const todayOrders = orders.length;
    const revenue = orders.filter(order => order.paymentStatus === 'paid').reduce((sum, order) => sum + order.total, 0);
    const rows = menuItems.map(item => `<tr><td><div class="item-cell"><span class="item-thumb">${item.image ? `<img src="${imageUrl(item)}" alt="" loading="lazy" />` : 'E'}</span><span><strong>${esc(item.name)}</strong><small>${esc(item.category)}</small></span></div></td><td>${money(item.price)}</td><td><span class="tiny-badge ${statusClass(item.status)}">${esc(statusName(item.status))}</span></td><td><select class="status-select" data-action="set-stock" data-id="${esc(item.id)}" aria-label="Set ${esc(item.name)} availability"><option value="in_stock" ${item.status === 'in_stock' ? 'selected' : ''}>In Stock</option><option value="out_of_stock" ${item.status === 'out_of_stock' ? 'selected' : ''}>Out of Stock</option><option value="out_of_order" ${item.status === 'out_of_order' ? 'selected' : ''}>Out of Order</option></select></td></tr>`).join('');
    return layout(`<div class="work-top"><div><span class="breadcrumb">Store / Admin</span><h1>Store overview</h1><p>Menu availability updates are shared with customer menus in this browser.</p></div><div class="work-top-right"><span class="live-tag"><span class="network-dot"></span>Live menu</span></div></div><section class="stat-grid"><div class="stat-card"><div class="stat-top"><span>Menu items</span><span>↗</span></div><div class="stat-value">${menuItems.length}</div><div class="stat-trend">${inStock} available to order</div></div><div class="stat-card"><div class="stat-top"><span>Unavailable</span><span>◌</span></div><div class="stat-value">${outCount}</div><div class="stat-trend" style="color:var(--muted)">Out of stock or order</div></div><div class="stat-card"><div class="stat-top"><span>Orders today</span><span>▤</span></div><div class="stat-value">${todayOrders}</div><div class="stat-trend">Across active service</div></div><div class="stat-card"><div class="stat-top"><span>Paid volume</span><span>ETB</span></div><div class="stat-value" style="font-size:24px">${money(revenue)}</div><div class="stat-trend">Confirmed payments</div></div></section><section class="panel"><div class="panel-head"><div><h2>Menu inventory</h2><p>Changes appear on customer and waiter menus immediately.</p></div><span class="live-tag"><span class="network-dot"></span>Synced</span></div><div class="table-scroll"><table class="inventory-table"><thead><tr><th>Item</th><th>Price</th><th>Availability</th><th>Update status</th></tr></thead><tbody>${rows}</tbody></table></div></section><div class="admin-lower"><section class="panel"><div class="panel-head"><div><h2>Add a menu item</h2><p>New items are added as available.</p></div></div><form class="add-item-form" id="add-item-form"><div class="field"><label for="item-name">Item name</label><input id="item-name" name="name" placeholder="e.g. Spicy chicken wrap" required maxlength="70" /></div><div class="field"><label for="item-category">Category</label><input id="item-category" name="category" placeholder="Burgers" required maxlength="35" /></div><div class="field"><label for="item-price">Price (ETB)</label><input id="item-price" name="price" type="number" min="1" step="1" placeholder="450" required /></div><button class="button button-dark" type="submit">Add item <span class="arrow">+</span></button></form></section><aside class="availability-note"><h3>Availability at a glance</h3><p>Out of stock and out of order items stay visible on the customer menu with a clear badge. Add-to-order controls are disabled until you mark them In Stock.</p></aside></div>`, 'admin');
}

function adminSidebar(activeView) {
    const navItems = [
        ['overview', '⊞', 'Overview'],
        ['menu', '≡', 'Menu items'],
        ['tables', '⌂', 'Tables'],
        ['reports', '▥', 'Reports']
    ];
    const firstName = esc((currentUser?.name || 'Store manager').split(' ')[0]);
    return `<aside class="admin-sidebar"><a class="admin-brand" href="#/admin"><span class="admin-brand-mark">E</span><span><strong>EMBER KITCHEN</strong><small>FRESH FROM THE GRILL</small></span></a><div class="admin-role"><span>WORKSPACE</span><strong>Administrator</strong></div><nav class="admin-nav" aria-label="Admin workspace">${navItems.map(([view, icon, label]) => `<a class="admin-nav-link ${activeView === view ? 'active' : ''}" href="#/admin${view === 'overview' ? '' : `?view=${view}`}" ${activeView === view ? 'aria-current="page"' : ''}><span>${icon}</span>${label}</a>`).join('')}</nav><div class="admin-sidebar-footer"><button class="admin-utility-link" data-action="logout"><span>⌂</span><span><strong>Sign out</strong><small>Return to staff portal</small></span></button><a class="admin-utility-link" href="#/cashier"><span>▤</span><span><strong>Cashier workspace</strong><small>Manage live orders</small></span></a><a class="admin-utility-link" href="#/menu"><span>▣</span><span><strong>Customer app</strong><small>Preview table menu</small></span></a><div class="admin-profile"><span class="admin-avatar">${firstName.slice(0, 1).toUpperCase()}</span><span><strong>${firstName} ${esc((currentUser?.name || '').split(' ').slice(1).join(' '))}</strong><small>Restaurant admin</small></span></div></div></aside>`;
}

function adminShell(content, activeView, title) {
    const paymentHealth = adminOverview.digital_payment_ready ? 'All systems healthy' : 'Payments need setup';
    return `<div class="admin-shell">${adminSidebar(activeView)}<div class="admin-main"><header class="admin-topbar"><div><h1>${esc(title)}</h1><p>EMBER KITCHEN · Live operations</p></div><div class="admin-top-actions"><span class="admin-health ${adminOverview.digital_payment_ready ? '' : 'needs-setup'}"><i></i>${paymentHealth}</span><button class="admin-bell" data-action="notifications" aria-label="Notifications" title="Notifications"><span></span></button></div></header><main class="admin-content">${content}</main></div></div>`;
}

function renderAdmin() {
    const activeView = routeQuery().get('view') || 'overview';
    const title = activeView === 'tables' ? 'Table management' : activeView === 'reports' ? 'Reports' : activeView === 'menu' ? 'Menu items' : 'Restaurant overview';
    if (activeView === 'tables') {
        return adminShell(`<div class="admin-greeting"><div><span class="admin-eyebrow">LIVE FLOOR</span><h2>Restaurant tables</h2></div><span class="admin-updated">${adminTables.length} tables configured</span></div><section class="admin-panel admin-table-panel"><div class="admin-panel-heading"><div><span class="admin-eyebrow">TABLES</span><h3>Current table status</h3></div></div><div class="admin-table-grid">${adminTables.map(table => `<article class="admin-table-card"><span class="admin-table-number">${esc(table.table_number)}</span><span class="admin-table-state ${table.status}"><i></i>${esc(table.status)}</span><small>${table.active_orders} active ${table.active_orders === 1 ? 'order' : 'orders'}</small></article>`).join('')}</div></section>`, activeView, title);
    }
    if (activeView === 'reports') {
        return adminShell(`<div class="admin-greeting"><div><span class="admin-eyebrow">TODAY AT A GLANCE</span><h2>Daily report</h2></div><span class="admin-updated">Live from order history</span></div><section class="admin-stats">${adminMetric('◫', 'Today’s revenue', money(adminOverview.today_revenue), 'Paid orders')}${adminMetric('▤', 'Completed orders', adminOverview.completed_orders, 'Today')}${adminMetric('⌁', 'Average order', money(adminOverview.average_order), 'Completed orders')}${adminMetric('⌂', 'Active tables', `${adminOverview.active_tables} / ${adminOverview.total_tables}`, 'Current occupancy')}</section><section class="admin-panel admin-report-note"><span class="admin-eyebrow">PAYMENT MIX</span><h3>Revenue only includes verified payments</h3><p>Digital orders enter revenue after Chapa transaction verification. Cash orders enter revenue after cashier approval.</p></section>`, activeView, title);
    }

    const rows = menuItems.map(item => `<tr><td><div class="admin-item-cell"><span class="admin-item-thumb">${item.image ? `<img src="${imageUrl(item)}" alt="" loading="lazy" />` : 'E'}</span><strong>${esc(item.name)}</strong></div></td><td>${esc(item.category)}</td><td class="admin-price">${money(item.price)}</td><td><span class="admin-status-wrap"><i class="admin-status-dot ${item.status === 'in_stock' ? 'is-stock' : 'is-out'}"></i><select class="admin-status-select" data-action="set-stock" data-id="${esc(item.id)}" aria-label="Set ${esc(item.name)} availability"><option value="in_stock" ${item.status === 'in_stock' ? 'selected' : ''}>In Stock</option><option value="out_of_stock" ${item.status === 'out_of_stock' ? 'selected' : ''}>Out of Stock</option><option value="out_of_order" ${item.status === 'out_of_order' ? 'selected' : ''}>Out of Order</option></select></span></td></tr>`).join('');
    const categories = [...new Set([...menuItems.map(item => item.category), 'Food', 'Juice', 'Drinks', 'Desserts'])];
    const greetingName = esc((currentUser?.name || 'Store manager').split(' ')[0]);
    const dashboard = `<div class="admin-greeting"><div><span class="admin-eyebrow">TODAY AT A GLANCE</span><h2>Good morning, ${greetingName}</h2></div><span class="admin-updated">Last updated just now</span></div><section class="admin-stats">${adminMetric('◫', 'Today’s revenue', money(adminOverview.today_revenue), 'Paid today')}${adminMetric('▤', 'Completed orders', adminOverview.completed_orders, 'Orders today')}${adminMetric('⌁', 'Average order', money(adminOverview.average_order), 'Completed orders')}${adminMetric('⌂', 'Active tables', `${adminOverview.active_tables} / ${adminOverview.total_tables}`, `${adminOverview.total_tables ? Math.round(adminOverview.active_tables / adminOverview.total_tables * 100) : 0}% occupied`)}</section><div class="admin-dashboard-grid"><section class="admin-panel admin-menu-panel" id="admin-menu"><div class="admin-panel-heading"><div><span class="admin-eyebrow">MENU MANAGEMENT</span><h3>Current items</h3></div><span class="admin-item-count">${menuItems.length}</span></div><div class="admin-table-scroll"><table class="admin-inventory"><thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="admin-empty">No menu items yet.</td></tr>'}</tbody></table></div></section><aside class="admin-panel admin-quick-panel"><div class="admin-panel-heading"><div><span class="admin-eyebrow">QUICK ACTION</span><h3>Add a food</h3><p>Create a new item for the customer menu.</p></div></div><form class="admin-add-form" id="add-item-form"><div class="field"><label for="item-name">Item name</label><input id="item-name" name="name" placeholder="e.g. Spicy chicken wrap" required maxlength="150" /></div><div class="admin-form-row"><div class="field"><label for="item-price">Price (ETB)</label><input id="item-price" name="price" type="number" min="1" step="0.01" placeholder="320" required /></div><div class="field"><label for="item-category">Category</label><select id="item-category" name="category" required>${categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('')}</select></div></div><div class="field"><label for="item-description">Description</label><input id="item-description" name="description" placeholder="Short menu description" maxlength="255" /></div><button class="button button-primary" type="submit">Add to menu</button></form></aside></div>`;
    return adminShell(dashboard, activeView === 'menu' ? 'menu' : 'overview', title);
}

function adminMetric(icon, label, value, note) {
    return `<article class="admin-metric"><div class="admin-metric-icon">${icon}</div><span class="admin-metric-note">${esc(note)}</span><div class="admin-metric-label">${esc(label)}</div><strong>${esc(value)}</strong></article>`;
}

function timeLabel(timestamp) { const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000)); return minutes < 1 ? 'Just now' : `${minutes} min ago`; }
function orderCard(order) {
    const isTransfer = ['telebirr_transfer', 'cbe_transfer'].includes(order.paymentMethod);
    const action = order.status === 'pending_approval' && isTransfer
        ? `<div class="cashier-actions"><button class="cashier-receipt" type="button" data-action="view-receipt" data-url="${esc(order.receiptUrl || '')}" aria-label="View receipt for order ${esc(order.id)}">${order.receiptUrl ? `<img src="${esc(order.receiptUrl)}" alt="" loading="lazy" />` : 'Receipt'}</button><button class="cashier-action-primary" data-action="verify-transfer" data-id="${esc(order.id)}" data-verification="approve">Approve &amp; send</button><button class="cashier-action-reject" data-action="verify-transfer" data-id="${esc(order.id)}" data-verification="reject">Reject</button></div>`
        : order.status === 'pending_approval' ? `<button class="cashier-action-primary" data-action="advance-order" data-id="${esc(order.id)}">Approve &amp; pay</button>`
            : order.status === 'in_kitchen' ? `<button class="cashier-action-secondary" data-action="advance-order" data-id="${esc(order.id)}">Mark ready</button>`
                : `<button class="cashier-action-complete" data-action="advance-order" data-id="${esc(order.id)}">Complete ✓</button>`;
    const paymentLabel = order.paymentMethod === 'telebirr_transfer' ? 'Telebirr transfer' : order.paymentMethod === 'cbe_transfer' ? 'Bank transfer' : order.payment === 'cash' ? 'Cash' : 'Digital';
    const lines = order.lines.map(line => `<span>${line.quantity} × ${esc(line.name)}</span>`).join('');
    return `<article class="cashier-order-card"><div class="cashier-order-top"><div><small>ORDER</small><strong>#${esc(order.id)}</strong></div><span class="cashier-table-tag">T${esc(order.table)}</span></div><div class="cashier-order-time"><span>◷ ${timeLabel(order.createdAt)}</span><span>${paymentLabel}</span></div><div class="cashier-order-lines">${lines || '<span>No items listed</span>'}</div>${order.receiptUrl && isTransfer ? `<span class="cashier-payment-status">Receipt submitted · ${esc(order.paymentStatus)}</span>` : ''}<div class="cashier-order-bottom"><strong>${money(order.total)}</strong><div class="cashier-actions-wrap">${action}</div></div></article>`;
}
function renderCashier() {
    const isAdmin = currentUser?.role === 'admin';
    const navItems = [['cashier', '▦', 'Orders', orders.filter(order => order.status === 'pending_approval').length]];
    if (isAdmin) navItems.push(['admin?view=menu', '☷', 'Menu management'], ['admin?view=tables', '⌂', 'Tables'], ['admin?view=reports', '▥', 'Reports']);
    const openOrders = orders.filter(order => ['pending_approval', 'in_kitchen', 'ready'].includes(order.status));
    const averageMinutes = openOrders.length ? Math.round(openOrders.reduce((sum, order) => sum + Math.max(0, (Date.now() - order.createdAt) / 60000), 0) / openOrders.length) : 0;
    const columns = [
        ['pending_approval', 'Pending cash', 'Needs payment approval', 'cashier-dot-pending'],
        ['in_kitchen', 'In kitchen', 'Actively being prepared', 'cashier-dot-kitchen'],
        ['ready', 'Ready to serve', 'Waiting for pickup', 'cashier-dot-ready']
    ];
    const orderColumns = columns.map(([status, title, subtitle, dotClass]) => {
        const list = orders.filter(order => order.status === status).sort((a, b) => b.createdAt - a.createdAt);
        return `<section class="cashier-column"><header class="cashier-column-heading"><span class="cashier-column-dot ${dotClass}"></span><div><h3>${title}</h3><small>${subtitle}</small></div><span class="cashier-column-count">${list.length}</span></header><div class="cashier-column-stack">${list.length ? list.map(orderCard).join('') : '<p class="cashier-empty">No orders here</p>'}</div></section>`;
    }).join('');
    const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });
    const staffName = esc(currentUser?.name || 'Cashier');
    return `<div class="cashier-dashboard"><aside class="cashier-sidebar"><a class="cashier-brand" href="#/home"><span class="brand-mark">E</span><span><strong>EMBER KITCHEN</strong><small>FRESH FROM THE GRILL</small></span></a><nav class="cashier-nav" aria-label="Cashier navigation">${navItems.map(([path, icon, label, badge]) => `<a class="cashier-nav-link ${path === 'cashier' ? 'active' : ''}" href="#/${path}"><span class="cashier-nav-icon">${icon}</span><span>${label}</span>${badge ? `<small>${badge}</small>` : ''}</a>`).join('')}</nav><div class="cashier-sidebar-bottom"><button class="cashier-utility-link" data-action="logout"><span>⌂</span><span><strong>Sign out</strong><small>Return to staff portal</small></span></button>${!isAdmin ? '<a class="cashier-utility-link" href="#/menu"><span>▣</span><span><strong>Customer menu</strong><small>Open the ordering page</small></span></a>' : ''}<div class="cashier-profile"><span class="cashier-avatar">${staffName.slice(0, 1).toUpperCase()}</span><span><strong>${staffName}</strong><small>${isAdmin ? 'Administrator' : 'Cashier workspace'}</small></span></div></div></aside><main class="cashier-main"><header class="cashier-topbar"><div><h1>Live orders</h1><p>${dateLabel}</p></div><div class="cashier-top-actions"><span class="cashier-live"><i></i>Live · Connected</span><button class="cashier-notification" data-action="notifications" aria-label="Notifications" title="Notifications">♧<i></i></button></div></header><div class="cashier-content"><div class="cashier-page-heading"><div><span>ORDER MANAGEMENT</span><h2>Kitchen overview</h2></div><div class="cashier-summary"><span>Open orders <strong>${openOrders.length}</strong></span><span>Avg. time <strong>${averageMinutes}m</strong></span></div></div><div class="cashier-columns">${orderColumns}</div></div></main><dialog class="receipt-modal" id="receipt-modal"><form method="dialog"><button class="button button-outline" aria-label="Close receipt preview">Close</button></form><img id="receipt-preview" alt="Payment receipt full-screen preview" /></dialog></div>`;
}

function renderUnavailable(message) {
    return `${header()}<main class="confirmation"><span class="eyebrow">Portal unavailable</span><h1>Could not reach the restaurant server.</h1><p>${esc(message)}</p><button class="button button-primary" data-action="retry">Try again</button></main>`;
}

async function render() {
    const current = route();
    const version = ++renderVersion;
    const app = document.getElementById('app');
    clearTimeout(paymentPollTimer);
    try {
        if (current === 'login') {
            app.innerHTML = renderLoginScreen(routeQuery().get('role') || 'cashier');
            return;
        }
        if (['admin', 'cashier', 'waiter'].includes(current)) {
            const { user } = await api('/api/auth/session');
            currentUser = user;
            if (user.role !== current && !(current === 'cashier' && user.role === 'admin')) {
                app.innerHTML = renderLoginScreen(current);
                return;
            }
        }
        if (['menu', 'checkout', 'waiter'].includes(current)) {
            const data = await api('/api/menu-items');
            menuItems = data.items;
        }
        if (current === 'checkout' || current === 'waiter') paymentDetails = await api('/api/payment-details');
        if (current === 'admin') {
            const [menuData, overviewData] = await Promise.all([
                api('/api/admin/menu-items'),
                api('/api/admin/overview')
            ]);
            menuItems = menuData.items;
            adminOverview = overviewData;
            adminTables = routeQuery().get('view') === 'tables' ? (await api('/api/admin/tables')).tables : [];
        }
        if (current === 'cashier') {
            const data = await api('/api/cashier/orders');
            orders = data.orders.map(normalizeOrder);
        }
        if (['confirmation', 'payment-return'].includes(current)) {
            const token = routeQuery().get('token');
            if (!token) throw new Error('This order link is incomplete.');
            const order = await api(`/api/orders/public/${encodeURIComponent(token)}`);
            if (version !== renderVersion) return;
            app.innerHTML = current === 'confirmation' ? renderConfirmation(order) : renderPaymentReturn(order);
            return;
        }
        if (version !== renderVersion) return;
        if (current === 'menu') app.innerHTML = renderCustomerMenu();
        else if (current === 'checkout') app.innerHTML = renderReviewOrder();
        else if (current === 'waiter') {
            app.innerHTML = renderWaiterPortal();
            document.getElementById('waiter-receipt-image')?.setAttribute('capture', 'environment');
            const receiptLabel = document.querySelector('label[for="waiter-receipt-image"]');
            if (receiptLabel?.firstChild) receiptLabel.firstChild.nodeValue = 'Take photo of customer payment receipt ';
            const fileNote = document.getElementById('waiter-receipt-file-name');
            if (fileNote && !waiterReceiptFile) fileNote.textContent = 'Use the camera or choose a saved screenshot (JPG, PNG or WebP).';
            const dialogCopy = document.querySelector('.waiter-dialog-copy');
            if (dialogCopy) dialogCopy.textContent = 'Add the customer’s items, confirm how they paid, take a photo of the receipt, then send everything to the cashier.';
            const steps = document.createElement('ol');
            steps.className = 'waiter-order-steps';
            steps.innerHTML = '<li>Choose the customer’s table and items.</li><li>After payment, take a photo of the receipt.</li><li>Send the order and photo to the cashier.</li>';
            dialogCopy?.after(steps);
            const waiterSubmitButton = document.querySelector('#waiter-order-form button[type="submit"]');
            if (waiterSubmitButton) waiterSubmitButton.textContent = ['telebirr_transfer', 'cbe_transfer'].includes(waiterPaymentMethod) ? (waiterReceiptFile ? 'Send order and receipt to cashier' : 'Take receipt photo to continue') : 'Send order to cashier';
        }
        else if (current === 'admin') app.innerHTML = renderAdmin();
        else if (current === 'cashier') {
            app.innerHTML = renderCashier();
            document.querySelector('.cashier-brand')?.insertAdjacentHTML('afterend', `<div class="cashier-role"><span>WORKSPACE</span><strong>${currentUser?.role === 'admin' ? 'Administrator' : 'Cashier'}</strong></div>`);
            if (currentUser?.role === 'admin') {
                document.querySelector('.cashier-profile')?.insertAdjacentHTML('beforebegin', '<a class="cashier-utility-link" href="#/admin"><span>▥</span><span><strong>Admin overview</strong><small>Reports and menu controls</small></span></a><a class="cashier-utility-link" href="#/menu"><span>▣</span><span><strong>Customer app</strong><small>Open mobile menu</small></span></a>');
            }
        }
        else app.innerHTML = renderHomePortal();
    } catch (error) {
        if (version !== renderVersion) return;
        if (error.status === 404) {
            location.hash = '/home';
            return;
        }
        if (error.status === 401 && ['admin', 'cashier', 'waiter'].includes(current)) {
            location.hash = `/login?role=${current}&next=${current}`;
            app.innerHTML = renderLoginScreen(current);
            return;
        }
        app.innerHTML = renderUnavailable(error.message);
    }
}

function changeQuantity(target, id, delta) {
    const item = menuItems.find(entry => entry.id === id);
    if (!item) return;
    if (delta > 0 && !available(item)) { showToast(`${item.name} is currently unavailable.`, true); return; }
    const next = Math.max(0, (target[id] || 0) + delta);
    if (next) target[id] = next; else delete target[id];
    render();
}
async function submitOrder(paymentMethod, orderType, targetCart, imageFile = null) {
    const items = Object.entries(targetCart).filter(([, quantity]) => quantity > 0).map(([menuItemId, quantity]) => ({ menu_item_id: menuItemId, quantity }));
    if (!items.length) throw new Error('Add at least one item before placing the order.');
    if (imageFile) {
        const body = new FormData();
        body.set('table_number', selectedTable);
        body.set('order_type', orderType);
        body.set('payment_method', paymentMethod);
        body.set('items', JSON.stringify(items));
        body.set('receipt_image', imageFile);
        return api('/api/orders', { method: 'POST', body });
    }
    return api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ table_number: selectedTable, order_type: orderType, payment_method: paymentMethod, items })
    });
}

async function advanceOrder(id) {
    const order = orders.find(entry => entry.id === id);
    if (!order) return;
    const endpoint = order.status === 'pending_approval' ? 'approve' : 'advance';
    try {
        await api(`/api/cashier/orders/${encodeURIComponent(id)}/${endpoint}`, { method: 'PATCH' });
        showToast(order.status === 'pending_approval' ? `Cash confirmed for order ${id}. Sent to kitchen.` : `Order ${id} advanced.`);
        await render();
    } catch (error) { showToast(error.message, true); }
}

async function verifyTransfer(id, action) {
    const response = action === 'reject' ? window.prompt('Reason for rejecting this transfer (optional):') : null;
    if (action === 'reject' && response === null) return;
    const rejectionReason = response || null;
    try {
        await api(`/api/cashier/orders/${encodeURIComponent(id)}/verify-payment`, {
            method: 'PATCH',
            body: JSON.stringify({ action, rejection_reason: rejectionReason })
        });
        showToast(action === 'approve' ? `Order ${id} approved and sent to kitchen.` : `Transfer for order ${id} rejected.`);
        await render();
    } catch (error) { showToast(error.message, true); }
}

document.addEventListener('click', event => {
    const control = event.target.closest('[data-action]');
    if (!control) return;
    const { action, id } = control.dataset;
    if (action === 'category') { activeCategory = control.dataset.category; render(); }
    else if (action === 'toggle-menu-search') {
        menuSearchOpen = !menuSearchOpen;
        if (!menuSearchOpen) menuSearch = '';
        render();
        if (menuSearchOpen) setTimeout(() => document.getElementById('menu-search')?.focus(), 50);
    }
    else if (action === 'login-role') {
        const role = ['cashier', 'admin', 'waiter'].includes(control.dataset.role) ? control.dataset.role : 'cashier';
        const form = document.getElementById('staff-login-form');
        if (form) {
            form.elements.role.value = role;
            form.querySelectorAll('.login-role-button').forEach(button => {
                const selected = button.dataset.role === role;
                button.classList.toggle('active', selected);
                button.setAttribute('aria-pressed', String(selected));
            });
            const email = document.getElementById('staff-email');
            if (email) email.value = role === 'admin' ? 'admin@ember.et' : role === 'cashier' ? 'cashier@ember.et' : 'waiter@ember.et';
            const label = document.getElementById('login-submit-label');
            if (label) label.textContent = `Sign in as ${role}`;
            document.querySelector('.login-waiter-link')?.classList.toggle('active', role === 'waiter');
        }
    }
    else if (action === 'submit-waiter') document.getElementById('waiter-checkout-dialog')?.showModal();
    else if (action === 'close-waiter-checkout') document.getElementById('waiter-checkout-dialog')?.close();
    else if (action === 'add-cart') changeQuantity(cart, id, 1);
    else if (action === 'toggle-cart') { mobileCartOpen = !mobileCartOpen; document.getElementById('cart-panel')?.classList.toggle('open', mobileCartOpen); }
    else if (action === 'checkout') go('checkout');
    else if (action === 'payment-channel') {
        paymentChannel = control.dataset.channel === 'cbebirr' ? 'cbebirr' : 'telebirr';
        document.querySelectorAll('[data-action="payment-channel"]').forEach(button => {
            const selected = button.dataset.channel === paymentChannel;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        const submitButton = document.querySelector('#checkout-form button[type="submit"]');
        if (submitButton?.firstChild) submitButton.firstChild.nodeValue = `Send ${paymentChannel === 'cbebirr' ? 'CBE Birr' : 'Telebirr'} prompt `;
    }
    else if (action === 'copy-account') {
        if (!navigator.clipboard?.writeText) showToast('Clipboard access is unavailable in this browser.', true);
        else navigator.clipboard.writeText(control.dataset.account).then(() => showToast('Account number copied.')).catch(() => showToast('Could not copy the account number.', true));
    }
    else if (action === 'use-phone-payment') { checkoutMethod = 'digital'; render(); }
    else if (action === 'view-receipt') {
        const modal = document.getElementById('receipt-modal');
        const image = document.getElementById('receipt-preview');
        if (modal && image && control.dataset.url) { image.src = control.dataset.url; modal.showModal(); }
    }
    else if (action === 'verify-transfer') verifyTransfer(id, control.dataset.verification);
    else if (action === 'advance-order') advanceOrder(id);
    else if (action === 'retry') render();
    else if (action === 'notifications') showToast('No new system alerts.');
    else if (action === 'logout') {
        api('/api/auth/logout', { method: 'POST' }).catch(() => { }).finally(() => {
            socket?.disconnect();
            socket = window.io ? window.io() : null;
            location.hash = '/home';
        });
    }
});

document.addEventListener('click', event => {
    const quantityButton = event.target.closest('[data-qty]');
    if (quantityButton) changeQuantity(quantityButton.dataset.qty === 'waiter' ? waiterCart : cart, quantityButton.dataset.id, Number(quantityButton.dataset.delta));
});

document.addEventListener('input', event => {
    if (event.target.id !== 'menu-search') return;
    menuSearch = event.target.value;
    const visible = filteredMenuItems();
    const grid = document.getElementById('menu-grid');
    const count = document.getElementById('menu-count');
    if (grid) grid.innerHTML = renderMenuCards(visible);
    if (count) count.textContent = `${visible.length} ${visible.length === 1 ? 'item' : 'items'}`;
});

document.addEventListener('change', event => {
    const target = event.target;
    if (target.id === 'qr-table' || target.id === 'waiter-table') {
        selectedTable = target.value;
        if (target.id === 'waiter-table') render();
        else { const menuLink = document.querySelector('.hero-actions a[href="#/menu"]'); if (menuLink) menuLink.href = `?table=${selectedTable}#/menu`; render(); }
    } else if (target.name === 'waiter_payment') {
        waiterPaymentMethod = target.value;
        const requiresReceipt = ['telebirr_transfer', 'cbe_transfer'].includes(waiterPaymentMethod);
        const accountPanel = document.getElementById('waiter-transfer-account');
        const receiptPanel = document.getElementById('waiter-receipt-section');
        const accountLabel = document.getElementById('waiter-account-label');
        const accountNumber = document.getElementById('waiter-account-number');
        const submitButton = document.querySelector('#waiter-order-form button[type="submit"]');
        if (accountPanel) accountPanel.hidden = !requiresReceipt;
        if (receiptPanel) receiptPanel.hidden = !requiresReceipt;
        if (accountLabel) accountLabel.textContent = waiterPaymentMethod === 'cbe_transfer' ? 'CBE account number' : 'Telebirr account';
        if (accountNumber) accountNumber.textContent = (waiterPaymentMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account) || 'Account details not configured';
        if (submitButton) {
            const account = waiterPaymentMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account;
            submitButton.disabled = requiresReceipt && (!waiterReceiptFile || !account);
            submitButton.textContent = requiresReceipt ? (waiterReceiptFile ? 'Send order and receipt to cashier' : 'Take receipt photo to continue') : 'Send order to cashier';
        }
    } else if (target.id === 'waiter-receipt-image') {
        const file = target.files?.[0] || null;
        waiterReceiptFile = file && file.size <= 5 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file : null;
        const fileName = document.getElementById('waiter-receipt-file-name');
        const submitButton = document.querySelector('#waiter-order-form button[type="submit"]');
        const requiresReceipt = ['telebirr_transfer', 'cbe_transfer'].includes(waiterPaymentMethod);
        if (fileName) fileName.textContent = waiterReceiptFile ? waiterReceiptFile.name : file ? 'Choose a JPG, PNG, or WebP image up to 5 MB' : 'Attach the transfer receipt, up to 5 MB.';
        if (submitButton) {
            const account = waiterPaymentMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account;
            submitButton.disabled = requiresReceipt && (!waiterReceiptFile || !account);
            submitButton.textContent = requiresReceipt ? (waiterReceiptFile ? 'Send order and receipt to cashier' : 'Take receipt photo to continue') : 'Send order to cashier';
        }
        if (file && !waiterReceiptFile) showToast('Choose a JPG, PNG, or WebP image up to 5 MB.', true);
    } else if (target.name === 'payment') { checkoutMethod = target.value; render(); }
    else if (target.id === 'receipt-image') {
        const file = target.files?.[0] || null;
        const valid = file && file.size <= 5 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
        receiptFile = valid ? file : null;
        const name = document.getElementById('receipt-file-name');
        const button = document.querySelector('#checkout-form button[type="submit"]');
        const buttonLabel = document.getElementById('checkout-submit-label');
        if (name) name.textContent = receiptFile ? receiptFile.name : file ? 'Choose a JPG, PNG, or WebP image up to 5 MB' : 'JPG, PNG, or WebP, up to 5 MB';
        if (button) button.disabled = ['telebirr_transfer', 'cbe_transfer'].includes(checkoutMethod) && (!receiptFile || !(checkoutMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account));
        if (buttonLabel && ['telebirr_transfer', 'cbe_transfer'].includes(checkoutMethod)) buttonLabel.textContent = receiptFile ? 'Submit order for review' : 'Upload screenshot to continue';
        if (file && !valid) showToast('Choose a JPG, PNG, or WebP image up to 5 MB.', true);
    }
    else if (target.matches('[data-action="set-stock"]')) {
        api(`/api/admin/menu-items/${encodeURIComponent(target.dataset.id)}/availability`, {
            method: 'PATCH',
            body: JSON.stringify({ status: target.value })
        }).then(() => render()).then(() => showToast(`${statusName(target.value)} status shared with active menus.`)).catch(error => showToast(error.message, true));
    }
});

document.addEventListener('submit', event => {
    if (event.target.id === 'waiter-order-form') {
        event.preventDefault();
        const requiresReceipt = ['telebirr_transfer', 'cbe_transfer'].includes(waiterPaymentMethod);
        const selectedAccount = waiterPaymentMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account;
        if (requiresReceipt && !waiterReceiptFile) {
            showToast('Attach the customer payment screenshot before sending the order.', true);
            return;
        }
        if (requiresReceipt && !selectedAccount) {
            showToast('Restaurant transfer account details are not configured.', true);
            return;
        }
        const button = event.target.querySelector('button[type="submit"]');
        button.disabled = true;
        submitOrder(waiterPaymentMethod, 'waiter_assisted', waiterCart, requiresReceipt ? waiterReceiptFile : null).then(order => {
            waiterCart = {};
            waiterReceiptFile = null;
            document.getElementById('waiter-checkout-dialog')?.close();
            showToast(`Order #${order.order_id} sent to cashier for review.`);
            location.hash = `/confirmation?token=${encodeURIComponent(order.public_token)}&source=waiter`;
        }).catch(error => {
            showToast(error.message, true);
            button.disabled = requiresReceipt && (!waiterReceiptFile || !selectedAccount);
        });
        return;
    }
    if (event.target.id === 'checkout-form') {
        event.preventDefault();
        const form = event.target;
        const data = new FormData(form);
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        (async () => {
            if (['telebirr_transfer', 'cbe_transfer'].includes(checkoutMethod)) {
                if (!receiptFile) throw new Error('Attach your transfer receipt screenshot.');
                const account = checkoutMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account;
                if (!account) throw new Error('Restaurant transfer details are not configured.');
                const order = await submitOrder(checkoutMethod, 'qr_self_service', cart, receiptFile);
                cart = {};
                receiptFile = null;
                location.hash = `/confirmation?token=${encodeURIComponent(order.public_token)}`;
                return;
            }
            const order = await submitOrder(checkoutMethod === 'cash' ? 'cash' : 'digital_aggregator', 'qr_self_service', cart);
            if (checkoutMethod === 'cash') {
                cart = {};
                location.hash = `/confirmation?token=${encodeURIComponent(order.public_token)}`;
                return;
            }
            const payment = await api('/api/payments/initialize', {
                method: 'POST',
                body: JSON.stringify({
                    order_id: order.order_id,
                    public_token: order.public_token,
                    first_name: data.get('first_name'),
                    last_name: data.get('last_name'),
                    email: data.get('email'),
                    phone_number: data.get('phone_number'),
                    payment_channel: paymentChannel
                })
            });
            cart = {};
            location.hash = `/payment-return?token=${encodeURIComponent(payment.public_token || order.public_token)}`;
        })().catch(error => {
            showToast(error.message, true);
            button.disabled = false;
        });
        return;
    }
    if (event.target.id === 'staff-login-form') {
        event.preventDefault();
        const form = event.target;
        const data = new FormData(form);
        const error = document.getElementById('login-error');
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ role: data.get('role'), email: data.get('email'), password: data.get('password') })
        }).then(() => {
            socket?.disconnect();
            socket = window.io ? window.io() : null;
            location.hash = `/${data.get('role')}`;
        }).catch(failure => {
            error.textContent = failure.message;
            button.disabled = false;
        });
        return;
    }
    if (event.target.id !== 'add-item-form') return;
    event.preventDefault();
    const data = new FormData(event.target);
    api('/api/admin/menu-items', {
        method: 'POST',
        body: JSON.stringify({ name: data.get('name'), category: data.get('category'), price: data.get('price'), description: data.get('description') })
    }).then(() => render()).then(() => showToast('Menu item added and available to order.')).catch(error => showToast(error.message, true));
});

window.addEventListener('hashchange', () => { mobileCartOpen = false; clearTimeout(paymentPollTimer); render(); });
window.addEventListener('popstate', render);
if (socket) {
    socket.on('menu_item_updated', () => { if (['menu', 'checkout', 'waiter', 'admin'].includes(route())) render(); });
    socket.on('new_order', () => { if (['cashier', 'admin'].includes(route())) render(); });
    socket.on('order_paid', () => { if (['cashier', 'admin'].includes(route())) render(); });
    socket.on('order_status_updated', () => { if (['cashier', 'admin'].includes(route())) render(); });
}
render();