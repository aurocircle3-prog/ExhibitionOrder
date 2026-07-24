// Shared helpers used by every page — resolves which company (tenant) we're
// talking to, and wraps fetch() so every API call carries the tenant + auth token.
(function () {
  // Applied immediately (not inside DOMContentLoaded) so the correct theme
  // is set as early as possible, minimizing any flash of the wrong theme
  // before the rest of the page loads.
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('exo_theme', theme);
  }
  function initTheme() {
    const saved = localStorage.getItem('exo_theme');
    if (saved) return applyTheme(saved);
    // No explicit choice yet — follow the system preference rather than
    // always defaulting to light.
    applyTheme(window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    document.querySelectorAll('.theme-toggle').forEach(btn => { btn.textContent = next === 'dark' ? '☀️' : '🌙'; });
  }
  initTheme();
  // Shared hosting platforms (Render, Vercel, etc.) hand out URLs shaped like
  // <service>.onrender.com — structurally identical to a real per-company
  // subdomain, so treating any 3-part hostname as a tenant slug is wrong
  // until you're on your own custom domain. Skip those known platform hosts.
  const PLATFORM_HOST_SUFFIXES = ['onrender.com', 'vercel.app', 'netlify.app', 'herokuapp.com'];
  function getTenantSlug() {
    const urlSlug = new URLSearchParams(location.search).get('tenant');
    if (urlSlug) { localStorage.setItem('exo_tenant', urlSlug); return urlSlug; }
    const cached = localStorage.getItem('exo_tenant');
    if (cached) return cached;
    const host = location.hostname.toLowerCase();
    const onPlatformHost = PLATFORM_HOST_SUFFIXES.some(suf => host.endsWith(suf)) || host === 'localhost';
    const parts = host.split('.');
    if (!onPlatformHost && parts.length > 2 && parts[0] !== 'www') return parts[0];
    return '';
  }

  async function apiFetch(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const slug = getTenantSlug();
    if (slug) headers['X-Tenant-Slug'] = slug;
    const token = localStorage.getItem('exo_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('/api' + path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function saveSession({ token, user, tenant }) {
    localStorage.setItem('exo_token', token);
    localStorage.setItem('exo_user', JSON.stringify(user));
    if (tenant) {
      localStorage.setItem('exo_tenant', tenant.slug);
      localStorage.setItem('exo_tenant_name', tenant.name);
      localStorage.setItem('exo_tenant_logo', tenant.logoUrl || '');
    }
  }
  function getUser() { try { return JSON.parse(localStorage.getItem('exo_user') || 'null'); } catch { return null; } }
  function logout() { localStorage.removeItem('exo_token'); localStorage.removeItem('exo_user'); location.href = '/login.html'; }
  function requireRole(...roles) {
    const user = getUser();
    if (!localStorage.getItem('exo_token') || !user || !roles.includes(user.role)) { location.href = '/login.html'; return null; }
    return user;
  }
  function navBar(links, active, exhibitionSwitcher) {
    const user = getUser();
    const items = links.map(l => `<a href="${l.href}" class="${l.key===active?'active':''}">${l.label}</a>`).join('');
    const switcherHtml = exhibitionSwitcher ? `
      <span class="muted" style="margin:0 8px;white-space:nowrap">📍 ${exhibitionSwitcher.name}</span>
      <button class="ghost small" onclick="EXO.exitExhibition();return false;" style="margin-right:10px;white-space:nowrap">Change exhibition</button>` : '';
    const themeIcon = (localStorage.getItem('exo_theme') || 'light') === 'dark' ? '☀️' : '🌙';
    const logoUrl = localStorage.getItem('exo_tenant_logo');
    const brandMark = logoUrl ? `<img src="${logoUrl}" alt="" style="height:26px;width:auto;object-fit:contain;display:block">` : '🎪';
    return `<div class="topbar">
      <div class="brand" style="display:flex;align-items:center;gap:8px">${brandMark}<span>${localStorage.getItem('exo_tenant_name') || 'Expo Orders'}</span></div>
      ${switcherHtml}
      <button class="nav-toggle" onclick="this.closest('.topbar').classList.toggle('nav-open')" aria-label="Menu">☰</button>
      <nav>${items}<a href="#" onclick="EXO.logout();return false;">Logout${user ? ' (' + user.name + ')' : ''}</a></nav>
      <button class="theme-toggle" onclick="EXO.toggleTheme()" title="Toggle light/dark" aria-label="Toggle light/dark theme">${themeIcon}</button>
    </div>`;
  }
  // Leaves the current exhibition and goes to see the full list again —
  // admins land on Dashboard (Current/Completed, same as normal entry);
  // staff with more than one current exhibition land on the picker, or
  // straight back into their one current exhibition if there's only one.
  function exitExhibition(){
    const tenantSlug = getTenantSlug();
    localStorage.removeItem('exo_current_exhibition_' + tenantSlug);
    localStorage.removeItem('exo_current_exhibition_name_' + tenantSlug);
    const user = getUser();
    location.href = user && user.role === 'admin' ? '/admin/dashboard.html' : '/staff/select-exhibition.html';
  }
  function currentExhibition(){
    const tenantSlug = getTenantSlug();
    const id = localStorage.getItem('exo_current_exhibition_' + tenantSlug);
    if (!id) return null;
    return { id, name: localStorage.getItem('exo_current_exhibition_name_' + tenantSlug) || 'Exhibition' };
  }
  function adminNav(active) {
    const ex = currentExhibition();
    const links = ex ? [
      { key: 'dashboard', href: '/admin/dashboard.html', label: 'Dashboard' },
      { key: 'items', href: '/admin/item-master.html', label: 'Item Master' },
      { key: 'order', href: '/staff/order.html', label: 'Take Order' },
      { key: 'orders', href: '/staff/orders.html', label: 'Orders' },
    ] : [
      { key: 'dashboard', href: '/admin/dashboard.html', label: 'Dashboard' },
      { key: 'buyers', href: '/admin/buyers.html', label: 'Buyers' },
      { key: 'staff', href: '/admin/staff.html', label: 'Staff' },
      { key: 'reports', href: '/admin/reports.html', label: 'Reports' },
      { key: 'settings', href: '/admin/settings.html', label: 'Settings' },
    ];
    return navBar(links, active, ex);
  }
  // Item Master, Take Order, and Orders are all exhibition-scoped now —
  // this makes sure whoever lands on one of those has a current exhibition
  // actually selected before the page tries to load anything scoped to it.
  // Admins are sent back to Dashboard to pick one explicitly. Staff get
  // handled automatically: one current exhibition -> just use it, several
  // -> a short picker, none -> a plain "nothing assigned yet" message
  // instead of a broken page.
  async function ensureExhibitionSelected(){
    if (currentExhibition()) return true;
    const user = getUser();
    if (!user) return false; // requireRole will have already redirected to login
    if (user.role === 'admin') { location.href = '/admin/dashboard.html'; return false; }
    try {
      const exhibitions = await apiFetch('/exhibitions');
      const current = exhibitions.filter(e => e.status === 'current');
      if (current.length === 1) {
        const tenantSlug = getTenantSlug();
        localStorage.setItem('exo_current_exhibition_' + tenantSlug, current[0].id);
        localStorage.setItem('exo_current_exhibition_name_' + tenantSlug, current[0].name);
        return true;
      }
      if (current.length > 1) { location.href = '/staff/select-exhibition.html'; return false; }
      document.body.innerHTML = `<div class="wrap" style="max-width:480px;margin:60px auto"><div class="card" style="text-align:center">
        <h3>No current exhibitions</h3>
        <p class="muted">You haven't been assigned to any exhibition that's currently open. Check with your admin.</p>
        <a href="#" onclick="EXO.logout();return false;">Logout</a>
      </div></div>`;
      return false;
    } catch (e) {
      return false; // couldn't reach the server — let the page's own error handling take it from here
    }
  }
  function staffNav(active) {
    const user = getUser();
    const links = [
      { key: 'order', href: '/staff/order.html', label: 'Take Order' },
      { key: 'orders', href: '/staff/orders.html', label: user && user.role === 'admin' ? 'Orders' : 'My Orders' },
    ];
    if (user && user.role === 'admin') links.push({ key: 'admin', href: '/admin/dashboard.html', label: '← Admin' });
    return navBar(links, active, currentExhibition());
  }
  function clientNav(active) {
    return navBar([{ key: 'orders', href: '/client/orders.html', label: 'My Orders' }], active);
  }

  // Save actions across the app used to just silently succeed or fail with
  // no visible confirmation — easy to walk away unsure whether it actually
  // saved. This gives every page one consistent, unmissable way to say so.
  let toastTimer = null;
  function toast(message, type = 'success') {
    let el = document.getElementById('exo-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'exo-toast';
      document.body.appendChild(el);
    }
    el.className = 'exo-toast ' + type;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // Small, deliberately-boring helper for "did my last deploy actually go
  // live" — fetches the running server's version/build time and drops it
  // into whichever element asked for it. Fails silently; a missing version
  // tag is a cosmetic non-issue, never worth an error to the user.
  async function showVersion(elId) {
    try {
      const res = await fetch('/api/version');
      const { version, builtAt } = await res.json();
      const el = document.getElementById(elId);
      if (el) el.textContent = `Expo Orders v${version} · built ${new Date(builtAt).toLocaleString()}`;
    } catch {}
  }

  // The standard fix for "save is slow, so I click it again" — duplicate
  // orders, duplicate staff, duplicate items. Disables the button and swaps
  // its label the instant it's clicked, restores it when the async work
  // finishes (success or failure), and — critically — ignores a second
  // click on the same button while the first is still in flight, so even a
  // click that lands in the gap before the DOM updates can't fire twice.
  async function busy(btn, fn) {
    if (!btn || btn.disabled) return; // already running — ignore the repeat click
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try { await fn(); }
    finally { btn.disabled = false; btn.textContent = original; }
  }

  window.EXO = { getTenantSlug, apiFetch, saveSession, getUser, logout, requireRole, adminNav, staffNav, clientNav, toast, showVersion, busy, exitExhibition, currentExhibition, ensureExhibitionSelected, toggleTheme };

  // Caches the app shell (order-taking page + scripts) so it can still load
  // with zero connection. Registration itself needs to happen once online;
  // after that the browser keeps it available offline.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
