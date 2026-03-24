'use strict';
const api = typeof browser !== 'undefined' ? browser : chrome;

// ── Constants ─────────────────────────────────────────────────────────────────
const K = { QUICK:'quickList', WATCH:'watchlist', SETTINGS:'settings' };
const DEF = { requireConfirm:true, cacheGuard:true, sandbox:true, autoErase:true, tamper:true, allowNuke:false };
const THROTTLE_MS = 3000;
const throttleMap = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Storage ───────────────────────────────────────────────────────────────────
let S = {...DEF};
async function load(k, d) { try { const r = await api.storage.local.get(k); return r[k] ?? d; } catch { return d; } }
async function save(k, v) { try { await api.storage.local.set({[k]:v}); } catch {} }
async function saveS() { await save(K.SETTINGS, S); }

// ── Utils ─────────────────────────────────────────────────────────────────────
function norm(r) {
  if (!r) return '';
  return r.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split(/[/?#]/)[0];
}
function matchDomain(host, domain, subs) {
  host = host.toLowerCase().replace(/^www\./,'');
  return host === domain || (subs && host.endsWith('.'+domain));
}
function isSafe(d) { return !!(d && d.includes('.') && d.length <= 253); }
function throttleOk(d) {
  const last = throttleMap.get(d)||0;
  if (Date.now()-last < THROTTLE_MS) return false;
  throttleMap.set(d, Date.now()); return true;
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
async function sha256(t) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t.toLowerCase().trim()));
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
}
function maskDomain(d) {
  const dot = d.lastIndexOf('.');
  if (dot <= 0) return '***';
  const tld = d.slice(dot), name = d.slice(0,dot);
  if (name.length <= 2) return '*'.repeat(name.length)+tld;
  return name[0]+'*'.repeat(Math.max(1,name.length-2))+name[name.length-1]+tld;
}

// ── Log ───────────────────────────────────────────────────────────────────────
const statusIdle = document.getElementById('status-idle');
const logLines   = document.getElementById('log-lines');
let logT = 0;
const MAX_LOG_LINES = 4; // fixed height zone — keep only last N lines visible

function logClear() {
  logLines.innerHTML = ''; logT = 0;
  logLines.style.display = 'none';
  statusIdle.style.display = 'block';
  statusIdle.textContent = 'Ready. Enter a domain above.';
}

function logStart() {
  statusIdle.style.display = 'none';
  logLines.style.display = 'block';
}

function logLine(text, cls='i', delay=0) {
  logStart();
  // Trim to max lines
  while (logLines.children.length >= MAX_LOG_LINES) logLines.removeChild(logLines.firstChild);
  const el = document.createElement('div');
  el.className = `ll ${cls}`;
  el.textContent = text;
  el.style.animationDelay = delay + 'ms';
  logLines.appendChild(el);
}

const L = {
  head: t => { logLine('▸ ' + t, 'hd', logT); logT += 70; },
  step: t => { logLine('  ' + t, 'i',  logT); logT += 100; },
  ok:   t => { logLine('  ✓ ' + t, 'ok', logT); logT += 80; },
  err:  t => { logLine('  ✗ ' + t, 'er', logT); logT += 80; },
  done: t => { logLine('✓ ' + t, 'dn', logT); logT += 70; },
};

// ── In-page injected function ─────────────────────────────────────────────────
function _inPageClear() {
  try { sessionStorage.clear(); } catch {}
  try { localStorage.clear(); } catch {}
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB.databases)
      indexedDB.databases().then(dbs =>
        dbs.forEach(db => { try { indexedDB.deleteDatabase(db.name); } catch {} })
      ).catch(()=>{});
  } catch {}
  try {
    if (typeof caches !== 'undefined')
      caches.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(()=>{});
  } catch {}
  try {
    if (navigator.serviceWorker)
      navigator.serviceWorker.getRegistrations()
        .then(rs => rs.forEach(r => r.unregister())).catch(()=>{});
  } catch {}
  return true;
}

// ── Erase pipeline ────────────────────────────────────────────────────────────
async function findTabs(domain, subs) {
  try {
    return (await api.tabs.query({})).filter(t => {
      if (!t.url || !t.id) return false;
      try { return matchDomain(new URL(t.url).hostname, domain, subs); } catch { return false; }
    }).map(t => ({id:t.id, url:t.url}));
  } catch { return []; }
}

async function injectTabs(tabs) {
  let n = 0;
  for (const t of tabs) {
    try { await api.scripting.executeScript({target:{tabId:t.id,allFrames:false},func:_inPageClear}); n++; } catch {}
  }
  return n;
}

async function eraseCookies(domain, subs) {
  let n = 0;
  let stores = [{id:'0'}];
  try { stores = await api.cookies.getAllCookieStores(); } catch {}
  for (const st of stores) {
    try {
      const cs = await api.cookies.getAll({domain, storeId:st.id});
      for (const c of cs) {
        const host = c.domain.replace(/^\./,'');
        if (S.sandbox && !matchDomain(host, domain, subs)) continue;
        const url = `${c.secure?'https':'http'}://${host}${c.path||'/'}`;
        try { await api.cookies.remove({url, name:c.name, storeId:st.id}); n++; } catch {}
      }
    } catch {}
  }
  return n;
}

async function eraseHistory(domain, subs) {
  let n = 0;
  try {
    const rs = await api.history.search({text:domain, maxResults:100000, startTime:0});
    await Promise.all(rs.map(item => {
      try {
        if (matchDomain(new URL(item.url).hostname, domain, subs))
          return api.history.deleteUrl({url:item.url}).then(()=>{ n++; });
      } catch {}
      return Promise.resolve();
    }));
  } catch {}
  return n;
}

async function browsingDataPass(domain, subs) {
  const origins = [`https://${domain}`,`http://${domain}`,`https://www.${domain}`,`http://www.${domain}`];
  if (subs) {
    try {
      const cs = await api.cookies.getAll({domain});
      for (const c of cs) { const h=c.domain.replace(/^\./,''); origins.push(`https://${h}`,`http://${h}`); }
    } catch {}
  }
  const uniq = [...new Set(origins)];
  const hostnames = [...new Set(uniq.map(o=>{ try{return new URL(o).hostname;}catch{return null;} }).filter(Boolean))];
  const types = {cacheStorage:true,fileSystems:true,indexedDB:true,localStorage:true,serviceWorkers:true,webSQL:true};
  try { await api.browsingData.remove({origins:uniq}, types); } catch {}
  try { await api.browsingData.remove({hostnames}, types); } catch {}
}

async function runErase(domain, opts) {
  if (!isSafe(domain)) throw new Error(`Invalid domain: ${domain}`);
  if (!throttleOk(domain)) throw new Error('Wait a moment before erasing again.');
  if (!opts.cookies && !opts.storage && !opts.history) throw new Error('Select at least one option.');
  if (opts.nuke && S.cacheGuard) throw new Error('Cache nuke locked. Disable protection in Config.');

  logClear(); logT = 0;
  L.head(domain);

  const subs = opts.subdomains !== false;
  const tabs = (opts.cookies || opts.storage) ? await findTabs(domain, subs) : [];
  L.step(`${tabs.length} tab${tabs.length!==1?'s':''} found`);
  await sleep(logT);

  if (tabs.length && opts.storage) {
    L.step('In-page injection...');
    await injectTabs(tabs);
    L.ok('sessionStorage, localStorage, SW cleared');
  }

  if (tabs.length && (opts.cookies || opts.storage)) {
    L.step('Navigating tabs away...');
    for (const t of tabs) try { await api.tabs.update(t.id, {url:'about:blank'}); } catch {}
    await sleep(500); L.ok('Pages unloaded');
  }

  if (opts.cookies) {
    await sleep(logT);
    L.step('Clearing cookies...');
    const n = await eraseCookies(domain, subs);
    L.ok(`${n} cookie${n!==1?'s':''} removed`);
  }

  if (opts.storage) {
    await sleep(logT);
    L.step('Clearing storage...');
    await browsingDataPass(domain, subs);
    L.ok('Storage cleared');
  }

  if (opts.nuke && !S.cacheGuard) {
    await sleep(logT);
    L.step('Nuking HTTP cache...');
    try { await api.browsingData.remove({since:0},{cache:true}); } catch {}
    L.ok('Done');
  }

  if (opts.history) {
    await sleep(logT);
    L.step('Clearing history...');
    const n = await eraseHistory(domain, subs);
    L.ok(`${n} ${n!==1?'entries':'entry'} removed`);
  }

  await sleep(logT + 350);
  if (tabs.length && (opts.cookies || opts.storage)) {
    L.step('Restoring tabs...');
    for (const t of tabs) try { await api.tabs.update(t.id, {url:t.url}); } catch {}
    if (opts.storage) { await sleep(900); await injectTabs(tabs); }
  }

  await sleep(logT);
  L.done(`${domain} cleared`);
}

// ── Read / apply opts grids ───────────────────────────────────────────────────
function readOpts(el) {
  const o = {};
  el.querySelectorAll('[data-opt]').forEach(t => { o[t.dataset.opt] = t.querySelector('input').checked; });
  return o;
}

// ── Nav / screen router ───────────────────────────────────────────────────────
function goScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`screen-${name}`)?.classList.add('active');
  document.querySelector(`.nav-btn[data-screen="${name}"]`)?.classList.add('active');
}

document.querySelectorAll('.nav-btn, .back-btn').forEach(btn => {
  btn.addEventListener('click', () => goScreen(btn.dataset.screen));
});

// ── Erase screen ──────────────────────────────────────────────────────────────
const domainIn  = document.getElementById('domain-input');
const eraseBtn  = document.getElementById('erase-btn');
const eraseLabel= document.getElementById('erase-label');
const optsStrip = document.getElementById('opts-strip');
const nukeTog   = document.getElementById('nuke-tog');
const nukeLabel = document.getElementById('nuke-label');
const sheetBg   = document.getElementById('sheet-bg');
const sheetTarget = document.getElementById('sheet-target');
const noWarnCb  = document.getElementById('no-warn');
let pendingDomain = null, pendingOpts = null;

document.getElementById('autofill-btn').addEventListener('click', async () => {
  try {
    const [tab] = await api.tabs.query({active:true,currentWindow:true});
    if (tab?.url) {
      const h = new URL(tab.url).hostname.replace(/^www\./,'').toLowerCase();
      if (h) { domainIn.value = h; domainIn.focus(); }
    }
  } catch {}
});

optsStrip.addEventListener('click', e => {
  const tile = e.target.closest('[data-opt]');
  if (!tile) return;
  const cb = tile.querySelector('input');
  cb.checked = !cb.checked;
  tile.classList.toggle('on', cb.checked);
});

nukeTog.addEventListener('click', e => {
  if (!S.allowNuke) {
    nukeTog.style.transform = 'translateX(4px)';
    setTimeout(()=>nukeTog.style.transform='translateX(-3px)',55);
    setTimeout(()=>nukeTog.style.transform='translateX(2px)',110);
    setTimeout(()=>nukeTog.style.transform='',165);
    return;
  }
  const cb = nukeTog.querySelector('input');
  cb.checked = !cb.checked;
  nukeTog.classList.toggle('on', cb.checked);
});

function updateNuke() {
  if (S.allowNuke) {
    nukeTog.classList.remove('locked');
    nukeLabel.textContent = 'Nuke cache';
  } else {
    nukeTog.classList.add('locked');
    nukeTog.querySelector('input').checked = false;
    nukeTog.classList.remove('on');
    nukeLabel.textContent = 'Nuke cache';
  }
}

eraseBtn.addEventListener('click', async () => {
  const raw = domainIn.value.trim();
  if (!raw) { domainIn.focus(); return; }
  const domain = norm(raw);
  if (!domain || !domain.includes('.')) { logClear(); logT=0; L.err(`"${domain}" — invalid domain`); return; }
  const opts = { ...readOpts(optsStrip), nuke: nukeTog.querySelector('input').checked };
  if (S.requireConfirm) {
    pendingDomain = domain; pendingOpts = opts;
    sheetTarget.textContent = domain;
    sheetBg.classList.add('open'); return;
  }
  await doErase(domain, opts);
});

domainIn.addEventListener('keydown', e => { if (e.key === 'Enter') eraseBtn.click(); });

document.getElementById('sheet-cancel').addEventListener('click', () => {
  sheetBg.classList.remove('open'); pendingDomain = null; pendingOpts = null;
});
sheetBg.addEventListener('click', e => {
  if (e.target === sheetBg) { sheetBg.classList.remove('open'); pendingDomain = null; pendingOpts = null; }
});
document.getElementById('sheet-ok').addEventListener('click', async () => {
  if (noWarnCb.checked) { S.requireConfirm = false; await saveS(); document.getElementById('s-confirm').checked = false; }
  sheetBg.classList.remove('open');
  const d = pendingDomain, o = pendingOpts;
  pendingDomain = null; pendingOpts = null;
  if (d && o) await doErase(d, o);
});

async function doErase(domain, opts) {
  eraseBtn.disabled = true;
  eraseLabel.textContent = 'Erasing...';
  eraseBtn.classList.add('scanning');
  void eraseBtn.querySelector('.sweep').offsetWidth; // reflow for animation restart
  try {
    await runErase(domain, opts);
    eraseBtn.classList.remove('scanning');
    eraseBtn.classList.add('done');
    eraseLabel.textContent = '✓ Done';
    setTimeout(() => {
      eraseBtn.disabled = false;
      eraseBtn.classList.remove('done');
      eraseLabel.textContent = 'Erase';
    }, 2500);
  } catch (err) {
    eraseBtn.classList.remove('scanning');
    eraseBtn.disabled = false;
    eraseLabel.textContent = 'Erase';
    logClear(); logT = 0; L.err(err.message || 'Erase failed');
  }
}

// ── Quick list ────────────────────────────────────────────────────────────────
const quickAddOpen = document.getElementById('quick-add-open');
const quickForm    = document.getElementById('quick-form');
const qfDomain     = document.getElementById('qf-domain');
const qfNick       = document.getElementById('qf-nick');
const qfOpts       = document.getElementById('qf-opts');
const quickItems   = document.getElementById('quick-items');

quickAddOpen.addEventListener('click', () => {
  quickForm.classList.toggle('open');
  if (quickForm.classList.contains('open')) qfDomain.focus();
  else { qfDomain.value = ''; qfNick.value = ''; }
});
qfOpts.addEventListener('click', e => {
  const t = e.target.closest('[data-opt]'); if (!t) return;
  const cb = t.querySelector('input'); cb.checked = !cb.checked; t.classList.toggle('on', cb.checked);
});

async function confirmAddQuick() {
  const domain = norm(qfDomain.value);
  if (!domain || !domain.includes('.')) return;
  const nickname = qfNick.value.trim().slice(0,32) || null;
  const opts = readOpts(qfOpts);
  const list = await load(K.QUICK, []);
  if (!list.some(e => e.domain === domain)) { list.push({domain, nickname, opts}); await save(K.QUICK, list); }
  qfDomain.value=''; qfNick.value='';
  quickForm.classList.remove('open'); renderQuick(list);
}
document.getElementById('qf-submit').addEventListener('click', confirmAddQuick);
qfDomain.addEventListener('keydown', e=>{ if(e.key==='Enter') qfNick.focus(); if(e.key==='Escape') quickForm.classList.remove('open'); });
qfNick.addEventListener('keydown', e=>{ if(e.key==='Enter') confirmAddQuick(); if(e.key==='Escape') quickForm.classList.remove('open'); });

function renderQuick(list) {
  if (!list.length) { quickItems.innerHTML='<div class="list-empty">No saved domains.</div>'; return; }
  quickItems.innerHTML = list.map((item, i) => `
    <div>
      <div class="li">
        <span class="li-label${item.nickname?' nick':''}">${esc(item.nickname||item.domain)}</span>
        <div class="li-acts">
          <button class="la" data-act="q-run" data-i="${i}">⚡</button>
          <button class="la" data-act="q-opts" data-i="${i}">⚙</button>
          <button class="la del" data-act="q-del" data-i="${i}">×</button>
        </div>
      </div>
      <div class="qi-opts" id="qi-${i}">
        <label class="qi-opt${item.opts?.cookies!==false?' on':''}" data-opt="cookies" data-qi="${i}"><input type="checkbox"${item.opts?.cookies!==false?' checked':''}/>Cookies</label>
        <label class="qi-opt${item.opts?.storage!==false?' on':''}" data-opt="storage" data-qi="${i}"><input type="checkbox"${item.opts?.storage!==false?' checked':''}/>Storage</label>
        <label class="qi-opt${item.opts?.history!==false?' on':''}" data-opt="history" data-qi="${i}"><input type="checkbox"${item.opts?.history!==false?' checked':''}/>History</label>
        <label class="qi-opt${item.opts?.subs!==false?' on':''}" data-opt="subs" data-qi="${i}"><input type="checkbox"${item.opts?.subs!==false?' checked':''}/>Subs</label>
      </div>
    </div>`).join('');

  quickItems.querySelectorAll('.qi-opt').forEach(tile => {
    tile.addEventListener('click', async e => {
      if (e.target.tagName==='INPUT') return;
      const cb = tile.querySelector('input'); cb.checked = !cb.checked; tile.classList.toggle('on', cb.checked);
      const qi = parseInt(tile.dataset.qi);
      const grid = tile.closest('.qi-opts');
      const list2 = await load(K.QUICK,[]);
      if (list2[qi]) {
        list2[qi].opts = {};
        grid.querySelectorAll('[data-opt]').forEach(t=>{ list2[qi].opts[t.dataset.opt]=t.querySelector('input').checked; });
        await save(K.QUICK, list2);
      }
    });
  });
}

quickItems.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act, i = parseInt(btn.dataset.i);
  const list = await load(K.QUICK,[]);
  if (act === 'q-del') { list.splice(i,1); await save(K.QUICK,list); renderQuick(list); return; }
  if (act === 'q-opts') { document.getElementById(`qi-${i}`)?.classList.toggle('open'); return; }
  if (act === 'q-run') {
    const item = list[i]; if (!item) return;
    btn.textContent='…'; btn.disabled=true;
    try {
      await runErase(item.domain, {
        cookies:item.opts?.cookies!==false, storage:item.opts?.storage!==false,
        history:item.opts?.history!==false, subdomains:item.opts?.subs!==false, nuke:false
      });
      btn.textContent='✓'; btn.style.color='var(--green)';
      setTimeout(()=>{ btn.textContent='⚡'; btn.disabled=false; btn.style.color=''; }, 1800);
    } catch(err) { btn.textContent='⚡'; btn.disabled=false; logClear(); logT=0; L.err(err.message||'Failed'); }
  }
});

// ── Watch list ────────────────────────────────────────────────────────────────
const watchAddOpen = document.getElementById('watch-add-open');
const watchForm    = document.getElementById('watch-form');
const wfDomain     = document.getElementById('wf-domain');
const wfNick       = document.getElementById('wf-nick');
const watchItems   = document.getElementById('watch-items');
const eyeTog       = document.getElementById('eye-tog');
const autoOffBar   = document.getElementById('auto-off-bar');

watchAddOpen.addEventListener('click', () => {
  watchForm.classList.toggle('open');
  if (watchForm.classList.contains('open')) wfDomain.focus();
  else { wfDomain.value=''; wfNick.value=''; }
});

async function confirmAddWatch() {
  const domain = norm(wfDomain.value);
  if (!domain || !domain.includes('.')) return;
  const nickname = wfNick.value.trim().slice(0,32) || null;
  const hash = await sha256(domain);
  const mask = maskDomain(domain);
  const list = await load(K.WATCH,[]);
  if (!list.some(e=>e.hash===hash)) { list.push({hash,mask,nickname}); await save(K.WATCH,list); }
  wfDomain.value=''; wfNick.value='';
  watchForm.classList.remove('open'); renderWatch(list);
}
document.getElementById('wf-submit').addEventListener('click', confirmAddWatch);
wfDomain.addEventListener('keydown', e=>{ if(e.key==='Enter') wfNick.focus(); if(e.key==='Escape') watchForm.classList.remove('open'); });
wfNick.addEventListener('keydown', e=>{ if(e.key==='Enter') confirmAddWatch(); if(e.key==='Escape') watchForm.classList.remove('open'); });

eyeTog.addEventListener('click', async () => {
  S.autoErase = !S.autoErase; await saveS();
  syncAutoUI(); document.getElementById('s-auto').checked = S.autoErase;
});
function syncAutoUI() {
  eyeTog.classList.toggle('off', !S.autoErase);
  autoOffBar.style.display = S.autoErase ? 'none' : 'block';
}

function renderWatch(list) {
  if (!list.length) { watchItems.innerHTML='<div class="list-empty">No watched domains.</div>'; return; }
  watchItems.innerHTML = list.map((e,i) => {
    const label = e.nickname
      ? `<span class="li-label nick">🏷 ${esc(e.nickname)}</span>`
      : `<span class="li-label masked">${esc(e.mask)}</span>`;
    return `<div class="li">${label}<div class="li-acts">
      <button class="la del" data-act="w-del" data-i="${i}">×</button>
    </div></div>`;
  }).join('');
}

watchItems.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  if (btn.dataset.act === 'w-del') {
    const i = parseInt(btn.dataset.i);
    const list = await load(K.WATCH,[]); list.splice(i,1); await save(K.WATCH,list); renderWatch(list);
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────
function bindToggle(id, key, cb) {
  const el = document.getElementById(id);
  el.addEventListener('change', async () => { S[key]=el.checked; await saveS(); if(cb) cb(el.checked); });
}
bindToggle('s-confirm',    'requireConfirm', null);
bindToggle('s-cache-guard','cacheGuard',     updateNuke);
bindToggle('s-sandbox',    'sandbox',        null);
bindToggle('s-auto',       'autoErase',      v=>{ syncAutoUI(); });
bindToggle('s-tamper',     'tamper',         null);
bindToggle('s-allow-nuke', 'allowNuke',      updateNuke);

function syncSettings() {
  document.getElementById('s-confirm').checked    = S.requireConfirm;
  document.getElementById('s-cache-guard').checked= S.cacheGuard;
  document.getElementById('s-sandbox').checked    = S.sandbox;
  document.getElementById('s-auto').checked       = S.autoErase;
  document.getElementById('s-tamper').checked     = S.tamper;
  document.getElementById('s-allow-nuke').checked = S.allowNuke;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const [quick, watch, savedS] = await Promise.all([load(K.QUICK,[]), load(K.WATCH,[]), load(K.SETTINGS,{})]);
  S = {...DEF, ...savedS};
  syncSettings(); updateNuke(); syncAutoUI();
  renderQuick(quick); renderWatch(watch);
}
init();
