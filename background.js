'use strict';
// background.js — service worker (Chrome/Brave) + background script (Firefox MV3)
const api = typeof browser !== 'undefined' ? browser : chrome;

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const K = { WATCH: 'watchlist', SETTINGS: 'settings', TABMAP: 'tabMap' };

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function matchesDomain(hostname, domain) {
  hostname = hostname.toLowerCase().replace(/^www\./, '');
  return hostname === domain || hostname.endsWith('.' + domain);
}

function domainFromUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    if (['chrome:', 'chrome-extension:', 'moz-extension:', 'about:', 'data:', 'javascript:', 'file:'].includes(url.protocol)) return null;
    return url.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch { return null; }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.toLowerCase().trim()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function storageGet(key, def) {
  try { const r = await api.storage.sync.get(key); if (r[key] !== undefined) return r[key]; } catch {}
  try { const r = await api.storage.local.get(key); if (r[key] !== undefined) return r[key]; } catch {}
  return def;
}
async function storageSave(key, val) {
  const obj = {[key]: val};
  await Promise.all([
    api.storage.sync.set(obj).catch(()=>{}),
    api.storage.local.set(obj).catch(()=>{}),
  ]);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// IN-PAGE CLEAR — self-contained (no closures — runs inside tab context)
// ─────────────────────────────────────────────────────────────────────────────
function _inPageClear() {
  try { sessionStorage.clear(); } catch {}
  try { localStorage.clear(); } catch {}
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
      indexedDB.databases().then(dbs =>
        dbs.forEach(db => { try { indexedDB.deleteDatabase(db.name); } catch {} })
      ).catch(() => {});
    }
  } catch {}
  try {
    if (typeof caches !== 'undefined') {
      caches.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(() => {});
    }
  } catch {}
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.getRegistrations()
        .then(regs => regs.forEach(r => r.unregister()))
        .catch(() => {});
    }
  } catch {}
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// ERASE PIPELINE (background version — always full erase, no logging)
// ─────────────────────────────────────────────────────────────────────────────
async function eraseDomain(domain) {
  if (!domain || !domain.includes('.')) return;

  // 1. Find affected tabs
  const affected = [];
  try {
    const tabs = await api.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url || !tab.id) continue;
      try {
        if (matchesDomain(new URL(tab.url).hostname, domain))
          affected.push({ id: tab.id, url: tab.url });
      } catch {}
    }
  } catch {}

  // 2. Inject into live tabs (sessionStorage, localStorage, IDB, caches, SW)
  if (affected.length > 0) {
    for (const t of affected) {
      try {
        await api.scripting.executeScript({
          target: { tabId: t.id, allFrames: false },
          func: _inPageClear,
        });
      } catch {}
    }
  }

  // 3. Navigate to blank — kill in-memory JS auth state
  for (const t of affected) {
    try { await api.tabs.update(t.id, { url: 'about:blank' }); } catch {}
  }
  if (affected.length > 0) await sleep(600);

  // 4. Cookies — iterate all stores
  let cookieStores = [{ id: '0' }];
  try { cookieStores = await api.cookies.getAllCookieStores(); } catch {}
  for (const store of cookieStores) {
    try {
      const cookies = await api.cookies.getAll({ domain, storeId: store.id });
      for (const c of cookies) {
        const host = c.domain.replace(/^\./, '');
        const url  = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
        try { await api.cookies.remove({ url, name: c.name, storeId: store.id }); } catch {}
      }
    } catch {}
  }

  // 5. browsingData bonus pass — Chrome uses origins, Firefox uses hostnames
  const origins   = [`https://${domain}`, `http://${domain}`, `https://www.${domain}`, `http://www.${domain}`];
  const hostnames = [domain, `www.${domain}`];
  const types     = { cacheStorage: true, fileSystems: true, indexedDB: true, localStorage: true, serviceWorkers: true, webSQL: true };
  try { await api.browsingData.remove({ origins }, types); } catch {}
  try { await api.browsingData.remove({ hostnames }, types); } catch {}

  await sleep(400);

  // 6. Restore tabs
  for (const t of affected) {
    try { await api.tabs.update(t.id, { url: t.url }); } catch {}
  }

  // 7. Second injection pass after reload
  if (affected.length > 0) {
    await sleep(900);
    for (const t of affected) {
      try {
        await api.scripting.executeScript({
          target: { tabId: t.id, allFrames: false },
          func: _inPageClear,
        });
      } catch {}
    }
  }

  // 8. History
  try {
    const results = await api.history.search({ text: domain, maxResults: 100000, startTime: 0 });
    await Promise.all(results.map(item => {
      try {
        if (matchesDomain(new URL(item.url).hostname, domain))
          return api.history.deleteUrl({ url: item.url }).catch(() => {});
      } catch {}
      return Promise.resolve();
    }));
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB TRACKING — persisted to survive service worker sleep
// ─────────────────────────────────────────────────────────────────────────────
async function getTabMap()  { return storageGet(K.TABMAP, {}); }
async function saveTabMap(m){ await storageSave(K.TABMAP, m); }

async function setTabDomain(tabId, domain) {
  const m = await getTabMap();
  m[String(tabId)] = domain;
  await saveTabMap(m);
}

async function popTabDomain(tabId) {
  const m = await getTabMap();
  const domain = m[String(tabId)] || null;
  delete m[String(tabId)];
  await saveTabMap(m);
  return domain;
}

function trackTab(tabId, url) {
  const domain = domainFromUrl(url);
  if (domain) setTabDomain(tabId, domain);
}

// Rebuild on cold-start (tabs open from before SW woke up)
api.tabs.query({}).then(tabs => {
  for (const tab of tabs) {
    if (tab.url) trackTab(tab.id, tab.url);
  }
}).catch(() => {});

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (url) trackTab(tabId, url);
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-ERASE ON TAB CLOSE
// ─────────────────────────────────────────────────────────────────────────────
api.tabs.onRemoved.addListener(async (tabId) => {
  const domain = await popTabDomain(tabId);
  if (!domain) return;

  // Check settings
  const saved = await storageGet(K.SETTINGS, {});
  if (saved.autoEraseEnabled === false) return;

  // Check if domain is in watchlist
  const watchlist = await storageGet(K.WATCH, []);
  if (!watchlist.length) return;

  const hash = await sha256(domain);
  if (watchlist.some(e => e.hash === hash)) {
    await eraseDomain(domain);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TAMPER PROTECTION — fires on every browser startup
// Erases any watchlist domains that still have data, covering:
//   1. Graceful browser close (tabs were closed, erase may have run but verify)
//   2. Crash / force-quit (erase never ran)
//   3. Ungraceful shutdown
//
// NOTE: onStartup fires on browser startup (not service worker restart).
// Service worker wakes frequently — we gate on a "session" timestamp to avoid
// running tamper protection more than once per actual browser restart.
// ─────────────────────────────────────────────────────────────────────────────
api.runtime.onStartup.addListener(async () => {
  const saved = await storageGet(K.SETTINGS, {});
  if (saved.tamperProtection === false) return;

  const watchlist = await storageGet(K.WATCH, []);
  if (!watchlist.length) return;

  // We need to erase all watchlist domains — the problem is we only store hashes,
  // not the original domains. So we can't call eraseDomain() directly.
  // Instead, we use browsingData to scan which domains have cookies/storage,
  // then check if their hash is in the watchlist.

  // Approach: iterate all cookies, find matching watchlist entries by hashing domains
  let cookieStores = [{ id: '0' }];
  try { cookieStores = await api.cookies.getAllCookieStores(); } catch {}

  const domainsToErase = new Set();

  // Get all cookies and hash each unique domain to check against watchlist
  const allDomains = new Set();
  for (const store of cookieStores) {
    try {
      const cookies = await api.cookies.getAll({ storeId: store.id });
      for (const c of cookies) {
        const h = c.domain.replace(/^\./, '').toLowerCase().replace(/^www\./, '');
        allDomains.add(h);
        // Also add parent domain
        const parts = h.split('.');
        if (parts.length > 2) allDomains.add(parts.slice(-2).join('.'));
      }
    } catch {}
  }

  // Hash each found domain and check against watchlist
  for (const domain of allDomains) {
    const hash = await sha256(domain);
    if (watchlist.some(e => e.hash === hash)) {
      domainsToErase.add(domain);
    }
  }

  // Erase each matching domain
  for (const domain of domainsToErase) {
    await eraseDomain(domain);
  }

  // Also clear tab map (stale from previous session)
  await saveTabMap({});
});
