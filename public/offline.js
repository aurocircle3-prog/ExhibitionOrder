// public/offline.js — minimal IndexedDB cache + outbox for taking orders with
// no connection. Scope is deliberately narrow: item lookup, buyer lookup／
// creation, and order submission — the actual booth workflow. Nothing else
// (item master editing, reports, etc.) is offline-capable, and doesn't need
// to be — those aren't done in the moment at a booth.
(function () {
  const DB_NAME = 'exo-offline', DB_VERSION = 1;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('parties')) db.createObjectStore('parties', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function reqp(req) {
    return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  }
  async function putAll(storeName, rows) {
    if (!rows.length) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readwrite');
      rows.forEach(r => t.objectStore(storeName).put(r));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
  async function getAll(storeName) {
    const db = await openDB();
    return reqp(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
  }
  async function del(storeName, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readwrite');
      t.objectStore(storeName).delete(key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  // ── Read caches, refreshed opportunistically whenever online ──
  async function cacheItems(tenantSlug, items) {
    await putAll('items', items.map(it => ({ key: tenantSlug + '::' + it.id, tenantSlug, item: it })));
  }
  async function countItems(tenantSlug) {
    const all = await getAll('items');
    return all.filter(r => r.tenantSlug === tenantSlug).length;
  }
  async function findItemByCode(tenantSlug, code) {
    const all = await getAll('items');
    const hit = all.find(r => r.tenantSlug === tenantSlug && r.item.scannerCode === code);
    return hit ? hit.item : null;
  }
  async function cacheParties(tenantSlug, parties) {
    await putAll('parties', parties.map(p => ({ key: tenantSlug + '::' + p.id, tenantSlug, party: p })));
  }
  async function searchPartiesOffline(tenantSlug, q) {
    const all = await getAll('parties');
    const needle = q.toLowerCase();
    return all
      .filter(r => r.tenantSlug === tenantSlug && (r.party.firmName?.toLowerCase().includes(needle) || r.party.phone?.includes(needle)))
      .map(r => r.party);
  }

  // ── Outbox — queued writes waiting to reach the server ──
  // Two entry types: 'party' and 'order'. An order created offline for a
  // buyer created offline too references that buyer via a 'local:<id>' id;
  // the sync pass resolves those to real server ids once the party syncs.
  async function queue(entry) {
    entry.id = entry.id || ('local:' + Date.now() + ':' + Math.random().toString(36).slice(2));
    entry.queuedAt = new Date().toISOString();
    await putAll('outbox', [entry]);
    return entry;
  }
  async function getOutbox(tenantSlug) {
    const all = await getAll('outbox');
    return all.filter(e => e.tenantSlug === tenantSlug).sort((a, b) => a.queuedAt < b.queuedAt ? -1 : 1);
  }
  async function removeFromOutbox(id) { await del('outbox', id); }

  // ── Sync engine ──
  // Syncs queued parties first (so their real ids exist), then queued
  // orders, rewriting any 'local:' partyId reference along the way. Stops at
  // the first failure per pass and leaves the remainder queued rather than
  // risk sending things out of order — the next trigger (reconnect, timer,
  // manual button) picks up where it left off.
  let syncing = false;
  async function flushOutbox(tenantSlug, apiFetch) {
    if (syncing) return { synced: 0, remaining: (await getOutbox(tenantSlug)).length };
    syncing = true;
    let synced = 0;
    try {
      const idMap = {};
      for (const entry of await getOutbox(tenantSlug)) {
        if (entry.type !== 'party') continue;
        try {
          const real = await apiFetch('/parties', { method: 'POST', body: JSON.stringify(entry.payload) });
          idMap[entry.id] = real.id;
          await removeFromOutbox(entry.id);
          synced++;
        } catch { break; } // still offline (or a real error) — stop, try again next trigger
      }
      for (const entry of await getOutbox(tenantSlug)) {
        if (entry.type !== 'order') continue;
        const payload = { ...entry.payload };
        if (typeof payload.partyId === 'string' && payload.partyId.startsWith('local:')) {
          const real = idMap[payload.partyId];
          if (!real) continue; // that buyer hasn't synced yet this pass — retry next time
          payload.partyId = real;
        }
        try {
          await apiFetch('/orders', { method: 'POST', body: JSON.stringify(payload) });
          await removeFromOutbox(entry.id);
          synced++;
        } catch { break; }
      }
    } finally { syncing = false; }
    const remaining = (await getOutbox(tenantSlug)).length;
    return { synced, remaining };
  }

  window.ExoOffline = { cacheItems, countItems, findItemByCode, cacheParties, searchPartiesOffline, queue, getOutbox, removeFromOutbox, flushOutbox };
})();
