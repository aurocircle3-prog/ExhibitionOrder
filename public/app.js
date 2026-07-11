// Shared helpers used by every page — resolves which company (tenant) we're
// talking to, and wraps fetch() so every API call carries the tenant + auth token.
(function () {
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
    if (tenant) { localStorage.setItem('exo_tenant', tenant.slug); localStorage.setItem('exo_tenant_name', tenant.name); }
  }
  function getUser() { try { return JSON.parse(localStorage.getItem('exo_user') || 'null'); } catch { return null; } }
  function logout() { localStorage.removeItem('exo_token'); localStorage.removeItem('exo_user'); location.href = '/login.html'; }
  function requireRole(...roles) {
    const user = getUser();
    if (!localStorage.getItem('exo_token') || !user || !roles.includes(user.role)) { location.href = '/login.html'; return null; }
    return user;
  }
  function navBar(links, active) {
    const user = getUser();
    const items = links.map(l => `<a href="${l.href}" class="${l.key===active?'active':''}">${l.label}</a>`).join('');
    return `<div class="topbar"><div class="brand">🎪 ${localStorage.getItem('exo_tenant_name') || 'Exhibition Order'}</div>
      <nav>${items}<a href="#" onclick="EXO.logout();return false;">Logout${user ? ' (' + user.name + ')' : ''}</a></nav></div>`;
  }
  function adminNav(active) {
    return navBar([
      { key: 'dashboard', href: '/admin/dashboard.html', label: 'Dashboard' },
      { key: 'order', href: '/staff/order.html', label: 'Take Order' },
      { key: 'items', href: '/admin/item-master.html', label: 'Item Master' },
      { key: 'orders', href: '/staff/orders.html', label: 'Orders' },
      { key: 'staff', href: '/admin/staff.html', label: 'Staff' },
      { key: 'reports', href: '/admin/reports.html', label: 'Reports' },
      { key: 'settings', href: '/admin/settings.html', label: 'Settings' },
    ], active);
  }
  function staffNav(active) {
    const user = getUser();
    const links = [
      { key: 'order', href: '/staff/order.html', label: 'Take Order' },
      { key: 'orders', href: '/staff/orders.html', label: user && user.role === 'admin' ? 'Orders' : 'My Orders' },
    ];
    if (user && user.role === 'admin') links.push({ key: 'admin', href: '/admin/dashboard.html', label: '← Admin' });
    return navBar(links, active);
  }
  function clientNav(active) {
    return navBar([{ key: 'orders', href: '/client/orders.html', label: 'My Orders' }], active);
  }

  window.EXO = { getTenantSlug, apiFetch, saveSession, getUser, logout, requireRole, adminNav, staffNav, clientNav };
})();
