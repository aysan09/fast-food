const money = amount => `ETB ${Number(amount).toLocaleString('en-ET')}`;
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let menuItems = [];
let orders = [];
let adminOverview = { today_revenue: 0, completed_orders: 0, open_orders: 0, average_order: 0, active_tables: 0, total_tables: 0 };
let cashierReport = { mode: 'range', range: 'week', date: '', today: '', month: null, completed_count: 0, paid_count: 0, total_amount: 0, average_amount: 0, by_method: {}, group_count: 0, groups: [], available_days: [], orders: [] };
let adminTables = [];
let currentUser = null;
let cart = {};
let waiterCart = {};
let waiterPaymentMethod = 'cash';

let activeCategory = 'All items';
let menuSearch = '';
let menuSearchOpen = false;
const TABLE_COUNT = 36;
const TABLE_NUMBERS = Array.from({ length: TABLE_COUNT }, (_, index) => String(index + 1).padStart(2, '0'));
function tableOptions(selected) {
    return TABLE_NUMBERS.map(table => `<option value="${table}" ${selected === table ? 'selected' : ''}>Table ${table}</option>`).join('');
}
const requestedTable = new URLSearchParams(location.search).get('table') || new URLSearchParams(location.hash.split('?')[1] || '').get('table') || '05';
let selectedTable = /^\d{1,2}$/.test(requestedTable) && Number(requestedTable) >= 1 && Number(requestedTable) <= TABLE_COUNT ? requestedTable.padStart(2, '0') : '05';
let checkoutMethod = 'cbe_transfer';
let paymentChannel = 'telebirr';
// Chapa v2 only offers hosted checkout, so every channel pre-selects a wallet on Chapa's
// own secure page instead of triggering a phone prompt from this server.
const PAYMENT_CHANNELS = [
    { id: 'telebirr', label: 'Telebirr', direct: true },
    { id: 'cbebirr', label: 'CBE Birr', direct: true },
    { id: 'ebirr', label: 'Coopay-Ebirr', direct: true },
    { id: 'mpesa', label: 'M-Pesa', direct: true },
    { id: 'awashbirr', label: 'Awash Birr', direct: true },
    { id: 'chapa', label: 'Bank, card & more', direct: false }
];
const channelInfo = id => PAYMENT_CHANNELS.find(channel => channel.id === id) || PAYMENT_CHANNELS[0];
const payActionLabel = () => 'Continue to secure payment';
function paymentFields() {
    const chips = PAYMENT_CHANNELS.map(channel => `<button class="gateway-chip ${paymentChannel === channel.id ? 'active' : ''}" type="button" data-action="payment-channel" data-channel="${channel.id}" aria-pressed="${paymentChannel === channel.id}">${channel.label}</button>`).join('');
    const phone = `<div class="field review-phone"><label for="checkout-phone">Mobile money phone number <small>(optional)</small></label><input id="checkout-phone" name="phone_number" type="tel" autocomplete="tel" placeholder="0912345678" pattern="(\\+251|251|0)[79][0-9]{8}" /></div><p class="demo-note">You’ll continue to Chapa’s secure page to pay with ${channelInfo(paymentChannel).label === 'Bank, card & more' ? 'your bank, card, or another Ethiopian wallet' : channelInfo(paymentChannel).label}.</p>`;
    return `<div class="gateway-options" role="group" aria-label="Choose payment provider">${chips}</div>${phone}`;
}
function paymentSubmitBody(data, order) {
    return JSON.stringify({ order_id: order.order_id, public_token: order.public_token, first_name: data.get('first_name'), last_name: data.get('last_name'), email: data.get('email'), phone_number: data.get('phone_number'), payment_channel: paymentChannel });
}
function continuePayment(payment, fallbackToken) {
    if (payment.checkout_url && /^https:\/\//.test(payment.checkout_url)) { location.href = payment.checkout_url; return; }
    location.hash = `/payment-return?token=${encodeURIComponent(payment.public_token || fallbackToken)}`;
}
let paymentDetails = { account_name: '', telebirr_account: '', cbe_account: '' };

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
        tableStatus: order.table_status || 'occupied',
        source: order.source || (order.order_type === 'waiter_assisted' ? 'Waiter' : 'QR menu'),
        payment: order.payment || (order.payment_method === 'cash' ? 'cash' : 'digital'),
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status || order.paymentStatus,

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
function imageUrl(item) {
    const image = item.image || item.image_url;
    if (!image) return '';
    if (/^https?:\/\//.test(image) || /^\//.test(image)) return image;
    return `https://images.unsplash.com/${image}?auto=format&fit=crop&w=720&q=82`;
}
function tableBadge() { return `<span class="table-pill">Table ${esc(selectedTable)}</span>`; }
function brand() { return `<a class="brand" href="#/home" aria-label="Seba Cafe home"><span class="brand-mark">S</span><span><span class="brand-name">SEBA CAFE</span><span class="brand-tag">FRESH · LOCAL · EVERY DAY</span></span></a>`; }
function header(extra = '') { return `<header class="topbar">${brand()}<div class="top-actions"><span class="network-pill"><span class="network-dot"></span>Service live</span>${extra}</div></header>`; }
function staffSidebar(active) {
    const links = [['home', '⌂', 'Portal'], ['cashier', '▤', 'Cashier'], ['waiter', '＋', 'Waiter'], ['admin', '◈', 'Admin']];
    return `<aside class="sidebar"><p class="sidebar-label">Workspaces</p><nav class="side-nav" aria-label="Staff workspaces">${links.map(([path, glyph, label]) => `<a class="side-link ${active === path ? 'active' : ''}" href="#/${path}" aria-label="${label}" title="${label}"><span class="side-glyph">${glyph}</span><span>${label}</span></a>`).join('')}</nav><div class="sidebar-bottom"><strong>SEBA CAFE</strong><small>Cafe ordering & POS</small></div></aside>`;
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
    return `${header('<a class="top-link" href="#/menu">Customer menu <span class="arrow">↗</span></a>')}<main class="page home-page"><section class="home-intro"><div><span class="eyebrow">Cafe ordering & POS</span><h1>Good food.<br /><em>Clear orders.</em></h1><p class="intro-copy">A simpler way to run the rush. Take orders at the table, keep the menu in sync, and move every ticket forward.</p><div class="hero-actions"><a class="button button-primary" href="#/menu">Open customer menu <span class="arrow">→</span></a><a class="button button-outline" href="#/cashier">Go to cashier</a></div></div><section class="qr-panel" aria-label="Table QR code"><div class="qr-head"><div><span class="qr-label">Scan to order</span><h2>Table ${esc(selectedTable)}</h2></div><span class="active-tag">Active</span></div><div class="qr-main"><img class="qr-image" src="${qrUrl}" alt="QR code for the Table ${esc(selectedTable)} customer menu" /><div class="qr-info"><p>Menu, right at the table.</p><small>Customers land directly on the menu, with their table already selected.</small></div></div><div class="qr-controls"><label for="qr-table">Preview table</label><select id="qr-table" aria-label="Choose QR table">${tableOptions(selectedTable)}</select><a class="top-link" href="${qrUrl}" target="_blank" rel="noreferrer">Print QR ↗</a></div></section></section><section class="portal-section"><div class="section-heading"><div><span class="eyebrow">Staff access</span><h2>Choose your workspace</h2></div><p>Jump into the right part of service.</p></div><div class="role-grid"><a class="role-card" href="#/cashier"><span class="role-icon">▤</span><span class="role-content"><strong>Cashier</strong><span>Orders, payments & kitchen queue</span></span><span class="role-arrow">→</span></a><a class="role-card" href="#/waiter"><span class="role-icon">＋</span><span class="role-content"><strong>Waiter</strong><span>Build an order for any table</span></span><span class="role-arrow">→</span></a><a class="role-card" href="#/admin"><span class="role-icon">◈</span><span class="role-content"><strong>Admin</strong><span>Menu, availability & store pulse</span></span><span class="role-arrow">→</span></a></div></section><footer class="page-footer">SEBA CAFE · Cafe ordering & POS · Arba Minch, Ethiopia</footer></main>`;
}

function renderHomePortal() {
    const base = location.href.split('#')[0];
    const qrTarget = `${base}?table=${encodeURIComponent(selectedTable)}#/menu`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=12&data=${encodeURIComponent(qrTarget)}`;
    const tables = TABLE_NUMBERS;
    return `<div class="home-portal"><header class="home-portal-header"><a class="brand" href="#/home" aria-label="Seba Cafe home"><span class="brand-mark">S</span><span><span class="brand-name">SEBA CAFE</span><span class="brand-tag">FRESH · LOCAL · EVERY DAY</span></span></a><span class="home-online"><i></i>Cafe online</span></header><main class="home-portal-main"><section class="home-portal-copy"><span class="home-portal-eyebrow">STAFF ACCESS PORTAL</span><h1>Run service.<br /><em>Keep it simple.</em></h1><p>Staff workspaces are private. Choose your role and sign in with your assigned Seba Cafe account.</p><div class="home-access-links"><a class="home-access-card primary" href="#/login?role=cashier"><span class="home-access-icon">▤</span><span><strong>Cashier login</strong><small>Orders &amp; payments</small></span><span class="home-access-arrow">‹</span></a><a class="home-access-card" href="#/login?role=admin"><span class="home-access-icon">▥</span><span><strong>Admin login</strong><small>Reports &amp; menu</small></span><span class="home-access-arrow">‹</span></a></div><a class="home-waiter-link" href="#/login?role=waiter">Waiter sign in</a></section><section class="home-qr-card" aria-label="Customer menu QR code"><header class="home-qr-heading"><div><span>TABLE ${esc(selectedTable)}</span><h2>Customer menu QR</h2></div><span class="home-qr-active">Active</span></header><img class="home-qr-image" src="${qrUrl}" alt="QR code linking customers to the Table ${esc(selectedTable)} menu" /><h3>Scan to order from Table ${esc(selectedTable)}</h3><p>Customers go directly to the menu. Staff dashboards and login links are not shown in their experience.</p><div class="home-qr-actions"><label class="home-table-select"><span class="sr-only">Preview table</span><select id="qr-table" aria-label="Choose QR table">${tables.map(table => `<option value="${table}" ${selectedTable === table ? 'selected' : ''}>Table ${table}</option>`).join('')}</select></label><a href="${qrUrl}" target="_blank" rel="noreferrer" class="home-print-link"><span aria-hidden="true">▦</span>Open printable QR code</a></div></section></main><footer class="home-portal-footer">SEBA CAFE · CAFE ORDERING & POS</footer></div>`;
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
    return `<div class="customer-menu"><header class="customer-menu-header"><a class="brand" href="#/home" aria-label="Seba Cafe home"><span class="brand-mark">S</span><span><span class="brand-name">SEBA CAFE</span><span class="brand-tag">FRESH · LOCAL · EVERY DAY</span></span></a><span class="customer-table"><i></i>Table ${esc(selectedTable)}</span></header><main class="customer-menu-main"><section class="menu-welcome"><span class="eyebrow">Fresh from our kitchen</span><div class="menu-welcome-row"><h1>Find your next<br />favourite.</h1><button class="menu-search-toggle" type="button" data-action="toggle-menu-search" aria-label="Search menu" title="Search menu">⌕</button></div>${menuSearchOpen ? `<input class="menu-search-input" id="menu-search" type="search" placeholder="Search dishes" value="${esc(menuSearch)}" aria-label="Search dishes" />` : ''}</section><nav class="menu-category-strip" role="tablist" aria-label="Menu categories">${categories.map(category => `<button class="menu-category-chip ${activeCategory === category ? 'active' : ''}" role="tab" aria-selected="${activeCategory === category}" data-action="category" data-category="${esc(category)}">${esc(category)}</button>`).join('')}</nav><div class="menu-toolbar"><h2 id="menu-heading">${esc(activeCategory)}</h2><span class="menu-count" id="menu-count">${visible.length} ${visible.length === 1 ? 'item' : 'items'}</span></div><div class="customer-menu-layout"><section class="menu-food-grid" id="menu-grid" aria-label="Menu items">${renderMenuCards(visible)}</section>${renderCart()}</div></main><button class="customer-cartbar" data-action="checkout" ${cartCount() ? '' : 'disabled'}><span class="customer-cart-icon" aria-hidden="true">▣</span><span class="customer-cart-summary"><small>${cartCount()} ${cartCount() === 1 ? 'item' : 'items'}</small><strong>${money(cartTotal())}</strong></span><span class="customer-cart-checkout">Checkout</span><span class="customer-cart-arrow" aria-hidden="true">‹</span></button></div>`;
}

function renderCheckout() {
    const lines = Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => { const item = menuItems.find(entry => entry.id === id); return item ? `<div class="checkout-line"><span>${quantity} × ${esc(item.name)}</span><strong>${money(item.price * quantity)}</strong></div>` : ''; }).join('');
    return `${header(tableBadge())}<main class="checkout-wrap"><a class="back-link" href="#/menu">← Back to menu</a><span class="eyebrow">Nearly there</span><h1>Review your order</h1><p class="checkout-sub">Table ${esc(selectedTable)} · Your order is prepared fresh.</p>${cartCount() ? `<form class="checkout-layout" id="checkout-form"><section class="checkout-panel"><h2>How would you like to pay?</h2><div class="payment-options"><label class="payment-option"><input type="radio" name="payment" value="digital" ${checkoutMethod === 'digital' ? 'checked' : ''} /><span><strong>Pay online</strong><small>Continue to Chapa’s secure page</small></span></label>${checkoutMethod === 'digital' ? `<div class="gateway-options" role="group" aria-label="Choose mobile money provider"><button class="gateway-chip ${paymentChannel === 'telebirr' ? 'active' : ''}" type="button" data-action="payment-channel" data-channel="telebirr" aria-pressed="${paymentChannel === 'telebirr'}">Telebirr</button><button class="gateway-chip ${paymentChannel === 'cbebirr' ? 'active' : ''}" type="button" data-action="payment-channel" data-channel="cbebirr" aria-pressed="${paymentChannel === 'cbebirr'}">CBE Birr</button></div><div class="checkout-contact"><div class="field"><label for="checkout-phone">Mobile money phone number</label><input id="checkout-phone" name="phone_number" type="tel" autocomplete="tel" placeholder="0912345678" pattern="(\\+251|251|0)[79][0-9]{8}" /></div><p class="demo-note">You’ll be taken to Chapa’s secure page to approve the payment. Your order goes to the kitchen once payment is confirmed.</p></div>` : ''}<label class="payment-option"><input type="radio" name="payment" value="cash" ${checkoutMethod === 'cash' ? 'checked' : ''} /><span><strong>Cash at counter</strong><small>Pay the cashier before we start your order</small></span></label>${checkoutMethod === 'cash' ? '<p class="demo-note">Cash orders stay pending until a cashier confirms receipt.</p>' : ''}</section><section class="checkout-panel"><h2>Order summary</h2>${lines}<div class="checkout-total"><span>Total due</span><span>${money(cartTotal())}</span></div><button class="button button-primary" style="width:100%" type="submit">${checkoutMethod === 'cash' ? 'Request cash approval' : `Continue to secure payment`} <span class="arrow">→</span></button></section></form>` : `<section class="checkout-panel"><p>Your cart is empty.</p><a class="button button-primary" href="#/menu">Back to menu</a></section>`}</main>`;
}

function renderTransferCheckout() {
    const lines = Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => {
        const item = menuItems.find(entry => entry.id === id);
        return item ? `<div class="checkout-line"><span>${quantity} × ${esc(item.name)}</span><strong>${money(item.price * quantity)}</strong></div>` : '';
    }).join('');
    const isTransfer = ['telebirr_transfer', 'cbe_transfer'].includes(checkoutMethod);
    const account = checkoutMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account;
    const accountLabel = checkoutMethod === 'cbe_transfer' ? 'CBE account number' : 'Telebirr account';
    const submitDisabled = false;
    const paymentChoices = [
        ['telebirr_transfer', 'Telebirr transfer', 'Transfer to the restaurant account before placing your order.'],
        ['cbe_transfer', 'CBE transfer', 'Transfer to the restaurant account before placing your order.'],
        ['digital', 'Pay online', 'Continue to Chapa’s secure page.'],
        ['cash', 'Cash at counter', 'Pay the cashier before we start your order.']
    ];
    return `${header(tableBadge())}<main class="checkout-wrap"><a class="back-link" href="#/menu">← Back to menu</a><span class="eyebrow">Nearly there</span><h1>Review your order</h1><p class="checkout-sub">Table ${esc(selectedTable)} · Your order is prepared fresh.</p>${cartCount() ? `<form class="checkout-layout" id="checkout-form"><section class="checkout-panel"><h2>How would you like to pay?</h2><div class="payment-options">${paymentChoices.map(([value, title, description]) => `<label class="payment-option"><input type="radio" name="payment" value="${value}" ${checkoutMethod === value ? 'checked' : ''} /><span><strong>${title}</strong><small>${description}</small></span></label>`).join('')}
        ${isTransfer ? `<section class="transfer-details"><div><span class="eyebrow">TRANSFER TO</span><h3>${checkoutMethod === 'cbe_transfer' ? 'CBE' : 'Telebirr'}</h3></div><div class="account-row"><span><small>${accountLabel}</small><strong>${esc(account || 'Account details not configured')}</strong></span>${account ? `<button class="button button-outline copy-account" type="button" data-action="copy-account" data-account="${esc(account)}">Copy</button>` : ''}</div>${paymentDetails.account_name ? `<p class="account-owner">Account name: <strong>${esc(paymentDetails.account_name)}</strong></p>` : ''}${!account ? '<p class="demo-note">Restaurant transfer details are not configured. Please contact the restaurant.</p>' : ''}</section>` : ''}
        ${checkoutMethod === 'digital' ? `<div class="gateway-options" role="group" aria-label="Choose mobile money provider"><button class="gateway-chip ${paymentChannel === 'telebirr' ? 'active' : ''}" type="button" data-action="payment-channel" data-channel="telebirr" aria-pressed="${paymentChannel === 'telebirr'}">Telebirr</button><button class="gateway-chip ${paymentChannel === 'cbebirr' ? 'active' : ''}" type="button" data-action="payment-channel" data-channel="cbebirr" aria-pressed="${paymentChannel === 'cbebirr'}">CBE Birr</button></div><div class="field"><label for="checkout-phone">Mobile money phone number</label><input id="checkout-phone" name="phone_number" type="tel" autocomplete="tel" placeholder="0912345678" pattern="(\\+251|251|0)[79][0-9]{8}" required /></div>` : ''}
        ${checkoutMethod === 'cash' ? '<p class="demo-note">Cash orders stay pending until a cashier confirms receipt.</p>' : ''}</div></section><aside class="checkout-panel"><h2>Your order</h2>${lines}<div class="checkout-total"><span>Total</span><span>${money(cartTotal())}</span></div><button class="button button-primary" type="submit" ${submitDisabled ? 'disabled' : ''}>${checkoutMethod === 'digital' ? payActionLabel() : 'Place cash order'} <span class="arrow">→</span></button></aside></form>` : '<p>Your cart is empty.</p>'}</main>`;
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
        ['digital', '▣', 'Pay online', 'Continue to Chapa’s secure page.'],
        ['telebirr_transfer', '▣', 'Telebirr transfer', 'Send payment from your Telebirr wallet'],
        ['cbe_transfer', '⌂', 'Bank account transfer', 'Transfer from CBE or another banking app'],
        ['cash', '▤', 'Cash at counter', 'Pay after confirming your order']
    ];
    const disabled = false;
    const actionLabel = isTransfer ? 'Submit order' : checkoutMethod === 'digital' ? 'Continue to Chapa’s secure page' : 'Place cash order';
    return `<div class="review-page"><header class="review-header"><a class="review-back" href="#/menu" aria-label="Back to menu">‹</a><div><small>TABLE ${esc(selectedTable)}</small><strong>Checkout</strong></div></header><form class="review-form" id="checkout-form"><main class="review-content"><section class="review-section"><div class="review-section-heading"><div><span>YOUR ORDER</span><h1>Order summary</h1></div><small>${cartCount()} ${cartCount() === 1 ? 'item' : 'items'}</small></div><div class="review-order-card">${lines}<div class="review-total"><strong>Total</strong><strong>${money(cartTotal())}</strong></div></div></section><section class="review-section payment-review"><div class="review-section-heading"><div><span>SECURE PAYMENT</span><h2>Choose payment method</h2></div></div><div class="review-methods">${paymentChoices.map(([value, icon, title, description]) => `<label class="review-method ${checkoutMethod === value ? 'selected' : ''}"><span class="review-method-icon" aria-hidden="true">${icon}</span><span class="review-method-copy"><strong>${title}</strong><small>${description}</small></span><input type="radio" name="payment" value="${value}" ${checkoutMethod === value ? 'checked' : ''} /></label>`).join('')}</div>${checkoutMethod === 'digital' ? `${paymentFields()}` : ''}</section></main><footer class="review-submitbar"><button class="review-submit" type="submit" ${disabled ? 'disabled' : ''}><span id="checkout-submit-label">${actionLabel}</span><strong>${money(cartTotal())}</strong></button></footer></form></div>`;
}

function renderConfirmation(order) {
    const isCash = order.payment_method === 'cash';
    const isTransfer = ['telebirr_transfer', 'cbe_transfer'].includes(order.payment_method);
    const paid = order.payment_status === 'paid';
    const heading = isTransfer ? 'Transfer received for review.' : paid ? 'Thanks, we’ve got it.' : 'Pay at the counter.';
    const status = isTransfer ? 'Awaiting cashier verification' : paid ? 'Payment confirmed' : 'Cash order received';
    const message = isTransfer ? 'The cashier will confirm your transfer with the bank notification. Your order goes to the kitchen after approval.' : isCash ? 'Show this order to the cashier. It will enter the kitchen once cash is confirmed.' : 'Your verified payment is confirmed. The kitchen has received your order.';
    const waiterSubmitted = routeQuery().get('source') === 'waiter';
    const confirmationHeading = waiterSubmitted ? 'Order sent to cashier.' : heading;
    const confirmationStatus = waiterSubmitted ? 'Waiting for cashier' : status;
    const confirmationMessage = waiterSubmitted
        ? isTransfer ? 'The cashier will verify the transfer and send the order to the kitchen.' : 'The cashier received the order and will confirm the customer’s cash payment before sending it to the kitchen.'
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
    if (order.payment_method === 'cash') { location.hash = `/confirmation?token=${encodeURIComponent(routeQuery().get('token'))}`; return '<main class="confirmation"><p>Returning to your order…</p></main>'; }
    clearTimeout(paymentPollTimer);
    paymentPollTimer = setTimeout(() => { if (route() === 'payment-return') render(); }, 2500);
    const payMessage = `Finish paying ${money(order.total_amount)} on Chapa’s secure page. We’ll confirm it here automatically and send your order to the kitchen once payment is verified.`;
    return `${header()}<main class="confirmation"><div class="confirmation-mark">…</div><span class="eyebrow">Secure payment</span><h1>Confirming your payment.</h1><p>${payMessage}</p><span class="network-pill"><span class="network-dot"></span>Checking payment status</span></main>`;
}

function renderLogin(role) {
    const selectedRole = ['cashier', 'admin', 'waiter'].includes(role) ? role : 'cashier';
    const email = selectedRole === 'admin' ? 'admin@sebacafe.et' : selectedRole === 'cashier' ? 'cashier@sebacafe.et' : 'waiter@sebacafe.et';
    return `<main class="login-page"><section class="login-shell"><a class="login-back" href="#/home"><span aria-hidden="true">‹</span> Back to home</a><a class="login-brand" href="#/home" aria-label="Seba Cafe home"><span class="brand-mark">S</span><span><strong>SEBA CAFE</strong><small>FRESH · LOCAL · EVERY DAY</small></span></a><div class="login-intro"><span class="login-eyebrow">STAFF SIGN IN</span><h1>Welcome back</h1><p>Select your role and enter your credentials.</p></div><form class="login-form" id="staff-login-form"><div class="login-role-switch" role="group" aria-label="Choose staff role"><button type="button" class="login-role-button ${selectedRole === 'cashier' ? 'active' : ''}" data-action="login-role" data-role="cashier" aria-pressed="${selectedRole === 'cashier'}"><span aria-hidden="true">▤</span>Cashier</button><button type="button" class="login-role-button ${selectedRole === 'admin' ? 'active' : ''}" data-action="login-role" data-role="admin" aria-pressed="${selectedRole === 'admin'}"><span aria-hidden="true">▥</span>Admin</button></div><input id="staff-role" name="role" type="hidden" value="${selectedRole}" /><div class="login-fields"><div class="login-field"><label for="staff-email">Email address</label><input id="staff-email" name="email" type="email" autocomplete="username" value="${email}" required /></div><div class="login-field"><label for="staff-password">Password</label><input id="staff-password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required /></div></div><p class="login-error" id="login-error" role="alert"></p><button class="login-submit" type="submit"><span id="login-submit-label">Sign in as ${selectedRole}</span><span aria-hidden="true">‹</span></button></form><aside class="login-account-note"><span>ACCOUNT ACCESS</span><p>Staff credentials are configured by your restaurant administrator.</p></aside><button type="button" class="login-waiter-link" data-action="login-role" data-role="waiter">Waiter sign in</button></section></main>`;
}

function renderLoginScreen(role) {
    return `<div class="login-split"><aside class="login-story"><a class="login-story-brand" href="#/home" aria-label="Seba Cafe home"><span class="brand-mark">S</span><span><strong>SEBA CAFE</strong><small>FRESH · LOCAL · EVERY DAY</small></span></a><div class="login-story-copy"><span class="login-eyebrow">PRIVATE STAFF ACCESS</span><h2>Great service starts<br />with a clear view.</h2><p>Sign in to manage orders, payments, menus, and restaurant performance.</p></div><small class="login-story-footer">SEBA CAFE · SECURE WORKSPACE</small></aside><section class="login-panel">${renderLogin(role)}</section></div>`;
}

function renderWaiterPaymentDialog() {
    const selectedAccount = waiterPaymentMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account;
    const accountLabel = waiterPaymentMethod === 'cbe_transfer' ? 'CBE account number' : 'Telebirr account';
    return `<dialog class="waiter-checkout-dialog" id="waiter-checkout-dialog"><form id="waiter-order-form"><header class="waiter-dialog-heading"><div><span class="eyebrow">TABLE ${esc(selectedTable)}</span><h2>Confirm customer order</h2></div><button type="button" class="waiter-dialog-close" data-action="close-waiter-checkout" aria-label="Close">×</button></header><p class="waiter-dialog-copy">Choose how the customer paid. The order is sent to the cashier.</p><div class="waiter-payment-options"><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="cash" ${waiterPaymentMethod === 'cash' ? 'checked' : ''} /><span><strong>Cash</strong><small>Cashier confirms payment</small></span></label><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="telebirr_transfer" ${waiterPaymentMethod === 'telebirr_transfer' ? 'checked' : ''} /><span><strong>Telebirr transfer</strong></span></label><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="cbe_transfer" ${waiterPaymentMethod === 'cbe_transfer' ? 'checked' : ''} /><span><strong>Bank transfer</strong></span></label></div><div class="waiter-dialog-total"><span>${cartCount(waiterCart)} items · Table ${esc(selectedTable)}</span><strong>${money(cartTotal(waiterCart))}</strong></div><button class="button button-primary waiter-submit-order" type="submit">Send order to cashier</button></form></dialog>`;
}

function renderWaiterPaymentReview() {
    const selectedAccount = waiterPaymentMethod === 'cbe_transfer' ? paymentDetails.cbe_account : paymentDetails.telebirr_account;
    return `<dialog class="waiter-checkout-dialog" id="waiter-checkout-dialog"><form id="waiter-order-form"><header class="waiter-dialog-heading"><div><span class="eyebrow">TABLE ${esc(selectedTable)}</span><h2>Confirm customer order</h2></div><button type="button" class="waiter-dialog-close" data-action="close-waiter-checkout" aria-label="Close">×</button></header><p class="waiter-dialog-copy">Choose how the customer paid. The order is sent to the cashier.</p><div class="waiter-payment-options"><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="cash" ${waiterPaymentMethod === 'cash' ? 'checked' : ''} /><span><strong>Cash</strong><small>Cashier confirms payment</small></span></label><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="telebirr_transfer" ${waiterPaymentMethod === 'telebirr_transfer' ? 'checked' : ''} /><span><strong>Telebirr transfer</strong></span></label><label class="waiter-payment-option"><input type="radio" name="waiter_payment" value="cbe_transfer" ${waiterPaymentMethod === 'cbe_transfer' ? 'checked' : ''} /><span><strong>Bank transfer</strong></span></label></div><div class="waiter-dialog-total"><span>${cartCount(waiterCart)} items · Table ${esc(selectedTable)}</span><strong>${money(cartTotal(waiterCart))}</strong></div><button class="button button-primary waiter-submit-order" type="submit">Send order to cashier</button></form></dialog>`;
}

function renderWaiter() {
    const rows = menuItems.map(item => `<div class="waiter-row"><div><strong>${esc(item.name)}</strong><small>${esc(statusName(item.status))}</small></div><span class="food-price">${money(item.price)}</span><div class="quantity-control"><button data-qty="waiter" data-id="${esc(item.id)}" data-delta="-1" aria-label="Remove one ${esc(item.name)}" ${!waiterCart[item.id] ? 'disabled' : ''}>−</button><span>${waiterCart[item.id] || 0}</span><button data-qty="waiter" data-id="${esc(item.id)}" data-delta="1" aria-label="Add one ${esc(item.name)}" ${available(item) ? '' : 'disabled'}>+</button></div></div>`).join('');
    return `${layout(`<div class="work-top"><div><span class="breadcrumb">Service / Waiter</span><h1>Build an order</h1><p>Take an order at the table and send it to the cashier for payment.</p></div><div class="work-top-right">${tableBadge()}</div></div><div class="waiter-layout"><section><div class="waiter-controls"><div class="field"><label for="waiter-table">Select table</label><select id="waiter-table" class="field-control">${tableOptions(selectedTable)}</select></div><span class="live-tag"><span class="network-dot"></span>Menu availability live</span></div><div class="waiter-menu">${rows}</div></section>${renderCart(waiterCart, true)}</div>`, 'waiter')}${renderWaiterPaymentReview()}`;
}

function renderWaiterPortal() {
    const menuRows = menuItems.map(item => `<article class="waiter-row"><div class="waiter-item-info"><strong>${esc(item.name)}</strong><small class="${available(item) ? 'waiter-stock' : 'waiter-out'}">${esc(statusName(item.status))}</small></div><span class="waiter-row-price">${money(item.price)}</span><div class="quantity-control"><button type="button" data-qty="waiter" data-id="${esc(item.id)}" data-delta="-1" aria-label="Remove one ${esc(item.name)}" ${!waiterCart[item.id] ? 'disabled' : ''}>−</button><span>${waiterCart[item.id] || 0}</span><button type="button" data-qty="waiter" data-id="${esc(item.id)}" data-delta="1" aria-label="Add one ${esc(item.name)}" ${available(item) ? '' : 'disabled'}>+</button></div></article>`).join('');
    const waiterName = esc(currentUser?.name || 'Waiter');
    return `<div class="admin-shell waiter-shell"><aside class="admin-sidebar waiter-sidebar"><a class="admin-brand" href="#/home" aria-label="Seba Cafe home"><span class="admin-brand-mark">S</span><span><strong>SEBA CAFE</strong><small>FRESH · LOCAL · EVERY DAY</small></span></a><div class="admin-role"><span>WORKSPACE</span><strong>Waiter</strong></div><nav class="admin-nav" aria-label="Waiter workspace"><a class="admin-nav-link active" href="#/waiter" aria-current="page"><span>＋</span>New order</a><a class="admin-nav-link" href="#/menu"><span>▣</span>Customer menu</a></nav><div class="admin-sidebar-footer"><button class="admin-utility-link" data-action="logout"><span>⌂</span><span><strong>Sign out</strong><small>Return to staff portal</small></span></button><a class="admin-utility-link" href="#/menu"><span>▣</span><span><strong>Customer app</strong><small>Preview customer menu</small></span></a><div class="admin-profile"><span class="admin-avatar">${waiterName.slice(0, 1).toUpperCase()}</span><span><strong>${waiterName}</strong><small>Waiter workspace</small></span></div></div></aside><div class="admin-main waiter-main"><header class="admin-topbar"><div><h1>Waiter portal</h1><p>Build customer orders and send them to the cashier.</p></div><span class="waiter-live-status"><i></i>Menu availability live</span></header><main class="admin-content waiter-content"><section class="waiter-greeting"><div><span class="admin-eyebrow">ORDER SERVICE</span><h2>Build a customer order</h2><p>Select the table, add the customer’s items, then record payment.</p></div><label class="waiter-table-control"><span>TABLE</span><select id="waiter-table" aria-label="Select table">${tableOptions(selectedTable)}</select></label></section><div class="waiter-builder-grid"><section class="waiter-catalog-panel"><header class="waiter-catalog-heading"><div><h3>Menu items</h3><p>Tap + to add items to the customer’s order.</p></div><span>${menuItems.length} items</span></header><div class="waiter-menu">${menuRows || '<p class="waiter-empty-menu">No menu items available.</p>'}</div></section>${renderCart(waiterCart, true)}</div></main></div>${renderWaiterPaymentReview()}</div>`;
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
    return `<aside class="admin-sidebar"><a class="admin-brand" href="#/admin"><span class="admin-brand-mark">S</span><span><strong>SEBA CAFE</strong><small>FRESH · LOCAL · EVERY DAY</small></span></a><div class="admin-role"><span>WORKSPACE</span><strong>Administrator</strong></div><nav class="admin-nav" aria-label="Admin workspace">${navItems.map(([view, icon, label]) => `<a class="admin-nav-link ${activeView === view ? 'active' : ''}" href="#/admin${view === 'overview' ? '' : `?view=${view}`}" ${activeView === view ? 'aria-current="page"' : ''}><span>${icon}</span>${label}</a>`).join('')}</nav><div class="admin-sidebar-footer"><button class="admin-utility-link" data-action="logout"><span>⌂</span><span><strong>Sign out</strong><small>Return to staff portal</small></span></button><a class="admin-utility-link" href="#/cashier"><span>▤</span><span><strong>Cashier workspace</strong><small>Manage live orders</small></span></a><a class="admin-utility-link" href="#/menu"><span>▣</span><span><strong>Customer app</strong><small>Preview table menu</small></span></a><div class="admin-profile"><span class="admin-avatar">${firstName.slice(0, 1).toUpperCase()}</span><span><strong>${firstName} ${esc((currentUser?.name || '').split(' ').slice(1).join(' '))}</strong><small>Restaurant admin</small></span></div></div></aside>`;
}

function adminShell(content, activeView, title) {
    const paymentHealth = adminOverview.digital_payment_ready ? 'All systems healthy' : 'Payments need setup';
    return `<div class="admin-shell">${adminSidebar(activeView)}<div class="admin-main"><header class="admin-topbar"><div><h1>${esc(title)}</h1><p>SEBA CAFE · Live operations</p></div><div class="admin-top-actions"><span class="admin-health ${adminOverview.digital_payment_ready ? '' : 'needs-setup'}"><i></i>${paymentHealth}</span><button class="admin-bell" data-action="notifications" aria-label="Notifications" title="Notifications"><span></span></button></div></header><main class="admin-content">${content}</main></div></div>`;
}

function renderAdmin() {
    const activeView = routeQuery().get('view') || 'overview';
    const title = activeView === 'tables' ? 'Table management' : activeView === 'reports' ? 'Reports' : activeView === 'menu' ? 'Menu items' : 'Restaurant overview';
    if (activeView === 'tables') {
        return adminShell(`<div class="admin-greeting"><div><span class="admin-eyebrow">LIVE FLOOR</span><h2>Restaurant tables</h2></div><span class="admin-updated">${adminTables.length} tables configured</span></div><section class="admin-panel admin-table-panel"><div class="admin-panel-heading"><div><span class="admin-eyebrow">TABLES</span><h3>Current table status</h3></div></div><div class="admin-table-grid">${adminTables.map(table => `<article class="admin-table-card"><span class="admin-table-number">${esc(table.table_number)}</span><span class="admin-table-state ${table.status}"><i></i>${esc(table.status)}</span><small>${table.active_orders} active ${table.active_orders === 1 ? 'order' : 'orders'}</small></article>`).join('')}</div></section>`, activeView, title);
    }
    if (activeView === 'reports') {
        return adminShell(`<div class="admin-greeting"><div><span class="admin-eyebrow">TODAY AT A GLANCE</span><h2>Daily report</h2></div><span class="admin-updated">Live from order history</span></div><section class="admin-stats">${adminMetric('◫', 'Today’s revenue', money(adminOverview.today_revenue), 'Completed & paid')}${adminMetric('▤', 'Completed orders', adminOverview.completed_orders, 'Finished today')}${adminMetric('⌁', 'Average order', money(adminOverview.average_order), 'Completed orders')}${adminMetric('◷', 'In service now', adminOverview.open_orders, 'Kitchen & ready')}</section><section class="admin-panel admin-report-note"><span class="admin-eyebrow">HOW THESE NUMBERS WORK</span><h3>Completed orders only count finished tickets</h3><p><strong>Completed orders</strong> increases by one each time a cashier taps <em>Complete</em> on an order, so an order is only counted after it leaves the kitchen and is served. Orders still waiting for payment, in the kitchen, or ready to serve are excluded and shown separately as <strong>In service now</strong>. Orders rejected or cancelled are never counted.</p></section><section class="admin-panel admin-report-note"><span class="admin-eyebrow">PAYMENT MIX</span><h3>Revenue only includes verified payments</h3><p>Digital orders enter revenue after Chapa transaction verification. Cash and transfer orders enter revenue after cashier approval. Transfers must be approved before the order can reach the kitchen, so an unapproved transfer never counts as revenue or as a completed order.</p></section>`, activeView, title);
    }

    const rows = menuItems.map(item => `<tr><td><div class="admin-item-cell"><span class="admin-item-thumb">${item.image ? `<img src="${imageUrl(item)}" alt="" loading="lazy" />` : 'E'}</span><strong>${esc(item.name)}</strong></div></td><td>${esc(item.category)}</td><td class="admin-price">${money(item.price)}</td><td><span class="admin-status-wrap"><i class="admin-status-dot ${item.status === 'in_stock' ? 'is-stock' : 'is-out'}"></i><select class="admin-status-select" data-action="set-stock" data-id="${esc(item.id)}" aria-label="Set ${esc(item.name)} availability"><option value="in_stock" ${item.status === 'in_stock' ? 'selected' : ''}>In Stock</option><option value="out_of_stock" ${item.status === 'out_of_stock' ? 'selected' : ''}>Out of Stock</option><option value="out_of_order" ${item.status === 'out_of_order' ? 'selected' : ''}>Out of Order</option></select></span></td></tr>`).join('');
    const categories = [...new Set([...menuItems.map(item => item.category), 'Food', 'Juice', 'Drinks', 'Desserts'])];
    const greetingName = esc((currentUser?.name || 'Store manager').split(' ')[0]);
    const dashboard = `<div class="admin-greeting"><div><span class="admin-eyebrow">TODAY AT A GLANCE</span><h2>Good morning, ${greetingName}</h2></div><span class="admin-updated">Last updated just now</span></div><section class="admin-stats">${adminMetric('◫', 'Today’s revenue', money(adminOverview.today_revenue), 'Completed & paid')}${adminMetric('▤', 'Completed orders', adminOverview.completed_orders, 'Finished today')}${adminMetric('⌁', 'Average order', money(adminOverview.average_order), 'Completed orders')}${adminMetric('⌂', 'Active tables', `${adminOverview.active_tables} / ${adminOverview.total_tables}`, `${adminOverview.total_tables ? Math.round(adminOverview.active_tables / adminOverview.total_tables * 100) : 0}% occupied`)}</section><div class="admin-dashboard-grid"><section class="admin-panel admin-menu-panel" id="admin-menu"><div class="admin-panel-heading"><div><span class="admin-eyebrow">MENU MANAGEMENT</span><h3>Current items</h3></div><span class="admin-item-count">${menuItems.length}</span></div><div class="admin-table-scroll"><table class="admin-inventory"><thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="admin-empty">No menu items yet.</td></tr>'}</tbody></table></div></section><aside class="admin-panel admin-quick-panel"><div class="admin-panel-heading"><div><span class="admin-eyebrow">QUICK ACTION</span><h3>Add a food</h3><p>Create a new item for the customer menu.</p></div></div><form class="admin-add-form" id="add-item-form"><div class="field"><label for="item-name">Item name</label><input id="item-name" name="name" placeholder="e.g. Spicy chicken wrap" required maxlength="150" /></div><div class="admin-form-row"><div class="field"><label for="item-price">Price (ETB)</label><input id="item-price" name="price" type="number" min="1" step="0.01" placeholder="320" required /></div><div class="field"><label for="item-category">Category</label><select id="item-category" name="category" required>${categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('')}</select></div></div><div class="field"><label for="item-description">Description</label><input id="item-description" name="description" placeholder="Short menu description" maxlength="255" /></div><div class="field admin-upload-field"><label for="item-image">Menu photo <small>(optional · JPG, PNG or WebP · up to 5 MB)</small></label><label class="admin-upload" for="item-image" id="item-image-drop"><span class="admin-upload-thumb" id="item-image-preview" aria-hidden="true">▣</span><span class="admin-upload-copy"><strong id="item-image-file-name">Click to choose a photo</strong><small>Or drag an image here. Without a photo, the item shows a placeholder tile.</small></span><span class="admin-upload-action">Browse</span><input id="item-image" name="image" type="file" accept="image/jpeg,image/png,image/webp" /></label></div><button class="button button-primary" type="submit">Add to menu</button></form></aside></div>`;
    return adminShell(dashboard, activeView === 'menu' ? 'menu' : 'overview', title);
}

function adminMetric(icon, label, value, note) {
    return `<article class="admin-metric"><div class="admin-metric-icon">${icon}</div><span class="admin-metric-note">${esc(note)}</span><div class="admin-metric-label">${esc(label)}</div><strong>${esc(value)}</strong></article>`;
}

function timeLabel(timestamp) { const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000)); return minutes < 1 ? 'Just now' : `${minutes} min ago`; }
function paymentStateLabel(order) {
    const status = order.paymentStatus;
    if (status === 'paid' || status === 'verified') return 'Paid';
    if (status === 'processing') return 'Confirming online payment';
    if (status === 'rejected' || status === 'failed') return 'Payment failed';
    if (order.paymentMethod === 'cash') return 'Awaiting cash';
    if (['telebirr_transfer', 'cbe_transfer'].includes(order.paymentMethod)) return 'Awaiting verification';
    return 'Awaiting payment';
}
function orderCard(order) {
    const isTransfer = ['telebirr_transfer', 'cbe_transfer'].includes(order.paymentMethod);
    const awaitingOnline = order.paymentMethod === 'digital_aggregator' && ['processing', 'unpaid'].includes(order.paymentStatus);
    const action = order.status === 'pending_approval' && awaitingOnline
        ? '<span class="cashier-waiting-pill">Waiting for Chapa confirmation</span>'
        : order.status === 'pending_approval' && isTransfer
        ? `<div class="cashier-actions"><button class="cashier-action-primary" data-action="verify-transfer" data-id="${esc(order.id)}" data-verification="approve">Approve &amp; send</button><button class="cashier-action-reject" data-action="verify-transfer" data-id="${esc(order.id)}" data-verification="reject">Reject</button></div>`
        : order.status === 'pending_approval' ? `<button class="cashier-action-primary" data-action="advance-order" data-id="${esc(order.id)}">Approve &amp; pay</button>`
            : order.status === 'in_kitchen' ? `<button class="cashier-action-secondary" data-action="advance-order" data-id="${esc(order.id)}">Mark ready</button>`
                : `<button class="cashier-action-complete" data-action="advance-order" data-id="${esc(order.id)}">Complete ✓</button>`;
    const paymentLabel = order.paymentMethod === 'telebirr_transfer' ? 'Telebirr transfer' : order.paymentMethod === 'cbe_transfer' ? 'Bank transfer' : order.paymentMethod === 'cash' ? 'Cash' : 'Online';
    const paidClass = ['paid', 'verified'].includes(order.paymentStatus) ? 'is-paid' : order.paymentStatus === 'processing' ? 'is-pending' : 'is-unpaid';
    const lines = order.lines.map(line => `<span>${line.quantity} × ${esc(line.name)}</span>`).join('');
    return `<article class="cashier-order-card"><div class="cashier-order-top"><div><small>ORDER</small><strong>#${esc(order.id)}</strong></div><span class="cashier-table-tag" title="Table status: ${esc(order.tableStatus || 'available')}">T${esc(order.table)}<i class="cashier-table-state ${esc(order.tableStatus || 'available')}"></i></span></div><div class="cashier-order-time"><span>◷ ${timeLabel(order.createdAt)}</span><span>${paymentLabel}</span><span class="cashier-pay-state ${paidClass}">${esc(paymentStateLabel(order))}</span></div><div class="cashier-order-lines">${lines || '<span>No items listed</span>'}</div><div class="cashier-order-bottom"><strong>${money(order.total)}</strong><div class="cashier-actions-wrap">${action}</div></div></article>`;
}
function cashierSidebar(activeView) {
    const isAdmin = currentUser?.role === 'admin';
    const navItems = [
        ['cashier', '▦', 'Orders', orders.filter(order => order.status === 'pending_approval').length],
        ['cashier/report', '▥', 'Completed report', 0]
    ];
    if (isAdmin) navItems.push(['admin?view=menu', '☷', 'Menu management'], ['admin?view=tables', '⌂', 'Tables'], ['admin?view=reports', '▥', 'Reports']);
    const staffName = esc(currentUser?.name || 'Cashier');
    return `<aside class="cashier-sidebar"><a class="cashier-brand" href="#/home"><span class="brand-mark">S</span><span><strong>SEBA CAFE</strong><small>FRESH · LOCAL · EVERY DAY</small></span></a><nav class="cashier-nav" aria-label="Cashier navigation">${navItems.map(([path, icon, label, badge]) => `<a class="cashier-nav-link ${path === activeView ? 'active' : ''}" href="#/${path}"${path === activeView ? ' aria-current="page"' : ''}><span class="cashier-nav-icon">${icon}</span><span>${label}</span>${badge ? `<small>${badge}</small>` : ''}</a>`).join('')}</nav><div class="cashier-sidebar-bottom"><button class="cashier-utility-link" data-action="logout"><span>⌂</span><span><strong>Sign out</strong><small>Return to staff portal</small></span></button>${!isAdmin ? '<a class="cashier-utility-link" href="#/menu"><span>▣</span><span><strong>Customer menu</strong><small>Open the ordering page</small></span></a>' : ''}<div class="cashier-profile"><span class="cashier-avatar">${staffName.slice(0, 1).toUpperCase()}</span><span><strong>${staffName}</strong><small>${isAdmin ? 'Administrator' : 'Cashier workspace'}</small></span></div></div></aside>`;
}

function formatReportDate(value, options = {}) {
    const [year, month, day] = String(value || '').split('-').map(Number);
    if (!year || (!month && !day)) return value || '';
    if (!month) return new Date(year, 0, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    if (!day) return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const date = new Date(year, month - 1, day);
    if (options.short) return date.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
    return date.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function dayLabel(value) {
    const today = cashierReport.today;
    const [year, month, day] = String(value || '').split('-').map(Number);
    if (!year || !month || !day) return value || '';
    const weekday = new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'long' });
    const pretty = new Date(year, month - 1, day).toLocaleDateString('en-US', { day: 'numeric', month: 'long' });
    return value === today ? `Today · ${weekday}` : `${weekday} · ${pretty}`;
}
function reportMethodLabel(method) {
    return method === 'telebirr_transfer' ? 'Telebirr transfer' : method === 'cbe_transfer' ? 'Bank transfer' : method === 'cash' ? 'Cash' : 'Pay online';
}
function reportOrderTable(orders) {
    const rows = orders.map(order => `<tr><td><strong>#${esc(order.id)}</strong><small>${esc(order.source)}</small></td><td>T${esc(order.table_number)}</td><td>${reportMethodLabel(order.payment_method)}</td><td class="cashier-report-amount">${money(order.total_amount)}</td><td>${new Date(order.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</td></tr>`).join('');
    return `<div class="cashier-report-table-wrap"><table class="cashier-report-table"><thead><tr><th>Order</th><th>Table</th><th>Payment</th><th>Amount</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderCashierReport() {
    const report = cashierReport;
    const isDay = report.mode === 'day';
    const methodRows = ['cash', 'telebirr_transfer', 'cbe_transfer', 'digital_aggregator'].map(method => {
        const cents = report.by_method?.[method] || 0;
        return `<div class="cashier-report-line"><span>${reportMethodLabel(method)}</span><strong>${money(cents / 100)}</strong></div>`;
    }).join('');

    // Date pickers: a single day, or a whole month.
    const dateField = isDay
        ? `<input type="date" id="cashier-report-date" aria-label="Report date" value="${esc(report.date)}" max="${esc(report.today || report.date)}" />`
        : `<input type="month" id="cashier-report-month" aria-label="Report month" value="${esc(report.month || report.this_month || '')}" max="${esc(report.this_month || '')}" />`;
    const rangeButtons = [['today', 'Today'], ['week', 'Last 7 days'], ['month', 'This month'], ['all', 'All time']]
        .map(([value, label]) => `<a class="cashier-range-chip ${report.mode === 'range' && report.range === value ? 'active' : ''}" href="#/cashier/report?range=${value}">${label}</a>`)
        .join('');
    const subtitle = isDay
        ? formatReportDate(report.date)
        : report.mode === 'month'
            ? formatReportDate(report.month)
            : report.range === 'today' ? 'Today' : report.range === 'week' ? 'Last 7 days' : report.range === 'month' ? 'This month' : 'All completed orders';

    // Recent days, so any date can be opened in one click.
    const dayChips = (report.available_days || []).slice(0, 10)
        .map(day => `<a class="cashier-day-chip ${isDay && report.date === day.date ? 'active' : ''}" href="#/cashier/report?date=${encodeURIComponent(day.date)}"><strong>${formatReportDate(day.date, { short: true })}</strong><small>${day.orders} ${day.orders === 1 ? 'order' : 'orders'}</small></a>`)
        .join('');

    // Grouped by calendar day, newest first, each group closed with its own total.
    const groups = isDay
        ? [{ date: report.date, completed_count: report.completed_count, total_amount: report.total_amount, orders: report.orders }]
        : (report.groups || []);
    const list = groups.length
        ? groups.map(group => `<section class="cashier-day-group">
            <header class="cashier-day-heading">
                <div><strong>${dayLabel(group.date)}</strong><small>${group.completed_count} ${group.completed_count === 1 ? 'order' : 'orders'}</small></div>
                <span>${money(group.total_amount)}</span>
            </header>
            ${reportOrderTable(group.orders)}
        </section>`).join('')
        : `<p class="cashier-empty">No orders were completed ${isDay ? `on ${formatReportDate(report.date)}` : 'in this period'}.</p>`;

    const emptyHint = !groups.length && !isDay && report.latest_completed_date
        ? `<div class="cashier-report-suggest"><span>Last completed order was on <strong>${formatReportDate(report.latest_completed_date)}</strong>.</span><a class="button button-outline" href="#/cashier/report?date=${encodeURIComponent(report.latest_completed_date)}">View that day</a></div>`
        : '';

    return `<div class="cashier-dashboard">${cashierSidebar('cashier/report')}<main class="cashier-main">
    <header class="cashier-topbar"><div><h1>Completed orders</h1><p>${isDay ? subtitle : `${subtitle} · grouped by date`}</p></div><div class="cashier-top-actions"><label class="cashier-report-date">${dateField}</label><button class="cashier-notification" data-action="notifications" aria-label="Notifications" title="Notifications">♧<i></i></button></div></header>
    <div class="cashier-content">
        <div class="cashier-page-heading"><div><span>REPORT</span><h2>Money collected</h2></div><div class="cashier-summary"><span>Completed orders <strong>${report.completed_count}</strong></span><span>Total collected <strong>${money(report.total_amount)}</strong></span></div></div>
        <nav class="cashier-range-bar" aria-label="Report range">${rangeButtons}</nav>
        <section class="cashier-report-totals">
            <article class="cashier-report-card primary"><span>Total money collected</span><strong>${money(report.total_amount)}</strong><small>${report.paid_count} paid ${report.paid_count === 1 ? 'order' : 'orders'}</small></article>
            <article class="cashier-report-card"><span>Completed orders</span><strong>${report.completed_count}</strong><small>${isDay ? 'Finished tickets' : `Across ${report.group_count || 0} ${report.group_count === 1 ? 'day' : 'days'}`}</small></article>
            <article class="cashier-report-card"><span>Average order</span><strong>${money(report.average_amount)}</strong><small>Per paid order</small></article>
            <section class="cashier-report-card cashier-report-mix"><span>Breakdown by payment method</span>${methodRows}</section>
        </section>
        ${dayChips ? `<section class="cashier-day-strip"><span class="cashier-day-strip-label">Jump to a day</span>${dayChips}</section>` : ''}
        <section class="cashier-report-panel"><header><div><h3>Completed order list</h3><p>Grouped by the day the order was placed, newest first.</p></div><strong>${report.completed_count}</strong></header>${list}${emptyHint}</section>
    </div></main></div>`;
}

function renderCashier() {
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
    return `<div class="cashier-dashboard">${cashierSidebar('cashier')}<main class="cashier-main"><header class="cashier-topbar"><div><h1>Live orders</h1><p>${dateLabel}</p></div><div class="cashier-top-actions"><span class="cashier-live"><i></i>Live · Connected</span><button class="cashier-notification" data-action="notifications" aria-label="Notifications" title="Notifications">♧<i></i></button></div></header><div class="cashier-content"><div class="cashier-page-heading"><div><span>ORDER MANAGEMENT</span><h2>Kitchen overview</h2></div><div class="cashier-summary"><span>Open orders <strong>${openOrders.length}</strong></span><span>Avg. time <strong>${averageMinutes}m</strong></span></div></div><div class="cashier-columns">${orderColumns}</div></div></div>`;
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
        if (['admin', 'cashier', 'cashier/report', 'waiter'].includes(current)) {
            const { user } = await api('/api/auth/session');
            currentUser = user;
            const staffView = current.split('/')[0];
            if (user.role !== staffView && !(staffView === 'cashier' && user.role === 'admin')) {
                app.innerHTML = renderLoginScreen(staffView);
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
        if (current === 'cashier/report') {
            const query = routeQuery();
            const params = new URLSearchParams();
            if (query.get('date')) params.set('date', query.get('date'));
            else if (query.get('month')) params.set('month', query.get('month'));
            else params.set('range', query.get('range') || 'week');
            // Always ask the server which day it reports on, so the picker and the totals agree
            // even when the browser and the server sit in different time zones.
            cashierReport = await api(`/api/cashier/report?${params.toString()}`);
            if (version !== renderVersion) return;
            app.innerHTML = renderCashierReport();
            return;
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
            if (current === 'cashier/report') {
                // Keep staff on their own screen instead of bouncing to the shop front.
                app.innerHTML = `<div class="cashier-dashboard">${cashierSidebar('cashier/report')}<main class="cashier-main"><div class="cashier-content"><section class="cashier-report-panel"><header><div><h3>Report unavailable</h3><p>${esc(error.message)}</p></div></header><a class="cashier-utility-link" href="#/cashier"><span>←</span><span><strong>Back to live orders</strong><small>Return to the kitchen overview</small></span></a></section></div></main></div>`;
                return;
            }
            location.hash = '/home';
            return;
        }
        if (error.status === 401) {
            const staffView = current.split('/')[0];
            if (['admin', 'cashier', 'waiter'].includes(staffView)) {
                location.hash = `/login?role=${staffView}&next=${staffView}`;
                app.innerHTML = renderLoginScreen(staffView);
                return;
            }
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
async function submitOrder(paymentMethod, orderType, targetCart) {
    const items = Object.entries(targetCart).filter(([, quantity]) => quantity > 0).map(([menuItemId, quantity]) => ({ menu_item_id: menuItemId, quantity }));
    if (!items.length) throw new Error('Add at least one item before placing the order.');
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
            if (email) email.value = role === 'admin' ? 'admin@sebacafe.et' : role === 'cashier' ? 'cashier@sebacafe.et' : 'waiter@sebacafe.et';
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
        paymentChannel = PAYMENT_CHANNELS.some(channel => channel.id === control.dataset.channel) ? control.dataset.channel : 'telebirr';
        render();
    }
    else if (action === 'copy-account') {
        if (!navigator.clipboard?.writeText) showToast('Clipboard access is unavailable in this browser.', true);
        else navigator.clipboard.writeText(control.dataset.account).then(() => showToast('Account number copied.')).catch(() => showToast('Could not copy the account number.', true));
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
    const visible = filteredMenuItems();
    const grid = document.getElementById('menu-grid');
    const count = document.getElementById('menu-count');
    if (grid) grid.innerHTML = renderMenuCards(visible);
    if (count) count.textContent = `${visible.length} ${visible.length === 1 ? 'item' : 'items'}`;
});

function showItemImagePreview(input) {
    const file = input.files && input.files[0];
    const box = document.getElementById('item-image-drop');
    const label = document.getElementById('item-image-file-name');
    const thumb = document.getElementById('item-image-preview');
    if (!box || !label || !thumb) return;
    thumb.style.backgroundImage = '';
    thumb.textContent = '▣';
    box.classList.remove('has-file', 'has-error');
    if (!file) {
        label.textContent = 'Click to choose a photo';
        return;
    }
    if (file.size > 5 * 1024 * 1024) {
        input.value = '';
        box.classList.add('has-error');
        label.textContent = 'That photo is larger than 5 MB';
        showToast('Choose a JPG, PNG, or WebP image up to 5 MB.', true);
        return;
    }
    box.classList.add('has-file');
    label.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    thumb.style.backgroundImage = `url("${URL.createObjectURL(file)}")`;
    thumb.textContent = '';
}

document.addEventListener('change', event => {
    const target = event.target;
    if (target.id === 'item-image') { showItemImagePreview(target); return; }
    if (target.id === 'cashier-report-date') { location.hash = `/cashier/report?date=${encodeURIComponent(target.value)}`; return; }
    if (target.id === 'cashier-report-month') { location.hash = `/cashier/report?month=${encodeURIComponent(target.value)}`; return; }
    if (target.id === 'qr-table' || target.id === 'waiter-table') {
        selectedTable = target.value;
        if (target.id === 'waiter-table') render();
        else { const menuLink = document.querySelector('.hero-actions a[href="#/menu"]'); if (menuLink) menuLink.href = `?table=${selectedTable}#/menu`; render(); }
    } else if (target.name === 'waiter_payment') {
        waiterPaymentMethod = target.value;
        render();
    } else if (target.name === 'payment') { checkoutMethod = target.value; render(); }
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
        const button = event.target.querySelector('button[type="submit"]');
        button.disabled = true;
        submitOrder(waiterPaymentMethod, 'waiter_assisted', waiterCart, null).then(order => {
            waiterCart = {};
            document.getElementById('waiter-checkout-dialog')?.close();
            showToast(`Order #${order.order_id} sent to cashier for review.`);
            location.hash = `/confirmation?token=${encodeURIComponent(order.public_token)}&source=waiter`;
        }).catch(error => {
            showToast(error.message, true);
            button.disabled = false;
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
            const order = await submitOrder(checkoutMethod === 'cash' ? 'cash' : 'digital_aggregator', 'qr_self_service', cart);
            if (checkoutMethod === 'cash') {
                cart = {};
                location.hash = `/confirmation?token=${encodeURIComponent(order.public_token)}`;
                return;
            }
            const payment = await api('/api/payments/initialize', { method: 'POST', body: paymentSubmitBody(data, order) });
            cart = {};
            continuePayment(payment, order.public_token);
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
        body: data
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
