'use strict';
const api = typeof browser !== 'undefined' ? browser : chrome;
const K = { Q:'quickList', W:'watchlist', S:'settings' };
// Default settings — cacheGuard removed, replaced by allowNuke as single gate
const DS = { confirm:true, sandbox:true, auto:true, tamper:true, allowNuke:false, autoNuke:false };
const THROTTLE = 3000;
const tmap = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let S = {...DS};

// ── Dual storage: sync (primary) + local (fallback/backup) ────────────────────
// chrome.storage.sync survives across devices when signed into Chrome.
// Both are cleared on uninstall — use JSON export for true persistence.
async function load(k, d) {
  // Try sync first, fall back to local
  try {
    const r = await api.storage.sync.get(k);
    if (r[k] !== undefined) return r[k];
  } catch {}
  try {
    const r = await api.storage.local.get(k);
    if (r[k] !== undefined) return r[k];
  } catch {}
  return d;
}

async function save(k, v) {
  // Write to both stores in parallel for maximum redundancy
  const obj = {[k]: v};
  await Promise.all([
    api.storage.sync.set(obj).catch(() => {}),
    api.storage.local.set(obj).catch(() => {}),
  ]);
}

async function saveS() { await save(K.S, S); }

// ── Utilities ─────────────────────────────────────────────────────────────────
function norm(r) { if (!r) return ''; return r.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split(/[/?#]/)[0]; }
function matchD(h, d, subs) { h = h.toLowerCase().replace(/^www\./,''); return h===d || (subs && h.endsWith('.'+d)); }
function isSafe(d) { return !!(d && d.includes('.') && d.length <= 253); }
function okThrottle(d) { const l=tmap.get(d)||0; if (Date.now()-l<THROTTLE) return false; tmap.set(d,Date.now()); return true; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
async function sha(t) { const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t.toLowerCase().trim())); return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join(''); }
function mask(d) { const dot=d.lastIndexOf('.'); if(dot<=0) return '***'; const tld=d.slice(dot),n=d.slice(0,dot); if(n.length<=2) return '*'.repeat(n.length)+tld; return n[0]+'*'.repeat(Math.max(1,n.length-2))+n[n.length-1]+tld; }
function readOpts(el) { const o={}; el.querySelectorAll('[data-opt]').forEach(t=>{o[t.dataset.opt]=t.querySelector('input').checked;}); return o; }

// ── Navigation ────────────────────────────────────────────────────────────────
const vp = document.getElementById('vp');
document.getElementById('go-lists').addEventListener('click', () => { vp.className='vp to-lists'; renderLists(); });
document.getElementById('go-settings').addEventListener('click', () => vp.className='vp to-settings');
document.getElementById('back-from-lists').addEventListener('click', () => vp.className='vp');
document.getElementById('back-from-settings').addEventListener('click', () => vp.className='vp');

// ── Log ───────────────────────────────────────────────────────────────────────
const logZone  = document.getElementById('log-zone');
const logInner = document.getElementById('log-inner');
let lt = 0;
function logClear() { logInner.innerHTML=''; lt=0; logZone.classList.remove('open'); }
function logLine(t, c='i', d=0) { logZone.classList.add('open'); const el=document.createElement('div'); el.className='ll '+c; el.textContent=t; el.style.animationDelay=d+'ms'; logInner.appendChild(el); setTimeout(()=>{ logInner.scrollTop=logInner.scrollHeight; }, d+30); }
const L = {
  head: t => { logLine('▸ '+t, 'hd', lt); lt+=80; },
  step: t => { logLine('  '+t, 'i', lt); lt+=110; },
  ok:   t => { logLine('  ✓ '+t, 'ok', lt); lt+=90; },
  err:  t => { logLine('  ✗ '+t, 'er', lt); lt+=90; },
  done: t => { logLine('✓ '+t, 'dn', lt); lt+=80; },
};

// ── In-page clear (self-contained — runs inside tab context) ──────────────────
function _clear() {
  try { sessionStorage.clear(); } catch {}
  try { localStorage.clear(); } catch {}
  try { if (typeof indexedDB!=='undefined' && indexedDB.databases) indexedDB.databases().then(ds=>ds.forEach(d=>{try{indexedDB.deleteDatabase(d.name);}catch{}})).catch(()=>{}); } catch {}
  try { if (typeof caches!=='undefined') caches.keys().then(ks=>ks.forEach(k=>caches.delete(k))).catch(()=>{}); } catch {}
  try { if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister())).catch(()=>{}); } catch {}
  return true;
}

// ── Erase pipeline ────────────────────────────────────────────────────────────
async function findTabs(d, subs) {
  try { const all=await api.tabs.query({}); return all.filter(t=>{if(!t.url||!t.id)return false;try{return matchD(new URL(t.url).hostname,d,subs);}catch{return false;}}).map(t=>({id:t.id,url:t.url})); }
  catch { return []; }
}
async function injectTabs(tabs) {
  let n=0; for(const t of tabs){try{await api.scripting.executeScript({target:{tabId:t.id,allFrames:false},func:_clear});n++;}catch{}} return n;
}
async function eraseCookies(d, subs) {
  let n=0, stores=[{id:'0'}];
  try { stores=await api.cookies.getAllCookieStores(); } catch {}
  for (const st of stores) {
    try {
      const cs=await api.cookies.getAll({domain:d, storeId:st.id});
      for (const c of cs) {
        const h=c.domain.replace(/^\./,'');
        if (S.sandbox && !matchD(h,d,subs)) continue;
        const url=`${c.secure?'https':'http'}://${h}${c.path||'/'}`;
        try { await api.cookies.remove({url, name:c.name, storeId:st.id}); n++; } catch {}
      }
    } catch {}
  }
  return n;
}
async function eraseHistory(d, subs) {
  let n=0;
  try {
    const rs=await api.history.search({text:d, maxResults:100000, startTime:0});
    await Promise.all(rs.map(item=>{
      try { if(matchD(new URL(item.url).hostname,d,subs)) return api.history.deleteUrl({url:item.url}).then(()=>{n++;}); }
      catch {}
      return Promise.resolve();
    }));
  } catch {}
  return n;
}
async function bData(d, subs) {
  const origins=[`https://${d}`,`http://${d}`,`https://www.${d}`,`http://www.${d}`];
  if (subs) {
    try { const cs=await api.cookies.getAll({domain:d}); for(const c of cs){const h=c.domain.replace(/^\./,'');origins.push(`https://${h}`,`http://${h}`);} } catch {}
  }
  const hostnames=[...new Set(origins.map(o=>{try{return new URL(o).hostname;}catch{return null;}}).filter(Boolean))];
  const types={cacheStorage:true,fileSystems:true,indexedDB:true,localStorage:true,serviceWorkers:true,webSQL:true};
  try { await api.browsingData.remove({origins:[...new Set(origins)]}, types); } catch {}
  try { await api.browsingData.remove({hostnames}, types); } catch {}
}

async function runErase(domain, opts) {
  if (!isSafe(domain)) throw new Error(`Invalid domain: ${domain}`);
  if (!okThrottle(domain)) throw new Error('Too fast — wait a moment.');
  if (!opts.cookies && !opts.storage && !opts.history) throw new Error('Select at least one option.');
  // Nuke gate: opts.nuke is only true when S.allowNuke is already confirmed true (set by caller)
  if (opts.nuke && !S.allowNuke) throw new Error('Cache nuke locked. Enable in Settings → Advanced.');

  logClear(); L.head(domain);
  const subs = opts.subs !== false;
  const tabs = (opts.cookies||opts.storage) ? await findTabs(domain, subs) : [];
  L.step(`${tabs.length} active tab${tabs.length!==1?'s':''}`); await sleep(lt);

  if (tabs.length && opts.storage) {
    L.step('Injecting in-page cleanup...');
    const n=await injectTabs(tabs); await sleep(100);
    L.ok(`In-page clear (${n} tab${n!==1?'s':''})`);
  }
  if (tabs.length && (opts.cookies||opts.storage)) {
    L.step('Navigating to safe state...');
    for (const t of tabs) try { await api.tabs.update(t.id,{url:'about:blank'}); } catch {}
    await sleep(500); L.ok('Pages unloaded');
  }

  let cn=null, hn=null;
  if (opts.cookies) { L.step('Clearing cookies...'); await sleep(lt); cn=await eraseCookies(domain,subs); L.ok(`${cn} cookie${cn!==1?'s':''} removed`); }
  if (opts.storage) { L.step('Clearing storage...'); await sleep(lt); await bData(domain,subs); L.ok('Storage cleared'); }

  // Nuke: opts.nuke is true AND S.allowNuke is true
  if (opts.nuke && S.allowNuke) {
    L.step('Nuking HTTP cache...');
    try { await api.browsingData.remove({since:0},{cache:true}); } catch {}
    L.ok('HTTP cache wiped');
  }

  if (opts.history) { L.step('Clearing history...'); await sleep(lt); hn=await eraseHistory(domain,subs); L.ok(`${hn} entr${hn!==1?'ies':'y'} removed`); }

  await sleep(lt + 350);
  if (tabs.length && (opts.cookies||opts.storage)) {
    L.step('Restoring tabs...');
    for (const t of tabs) try { await api.tabs.update(t.id,{url:t.url}); } catch {}
    if (opts.storage) { await sleep(900); await injectTabs(tabs); L.ok('Second-pass cleanup done'); }
  }
  await sleep(lt); L.done(`${domain} cleared`);
  return {cn, hn, tn:tabs.length};
}

// ── Opts wiring ───────────────────────────────────────────────────────────────
function wireOpts(el, cb) {
  el.addEventListener('click', e => {
    const tile=e.target.closest('[data-opt]'); if (!tile) return;
    const chk=tile.querySelector('input'); if (!chk) return;
    chk.checked=!chk.checked; tile.classList.toggle('on',chk.checked);
    if (cb) cb();
  });
}
wireOpts(document.getElementById('opts-strip'));
wireOpts(document.getElementById('qf-opts'));

// Show/hide nuke tile based on S.allowNuke
function updateNukeTile() {
  const tile = document.getElementById('nuke-op-tile');
  tile.style.display = S.allowNuke ? '' : 'none';
  tile.classList.remove('nuke-op'); // override display:none from CSS
  if (!S.allowNuke) {
    // Uncheck it when locked
    const cb = tile.querySelector('input');
    cb.checked = false; tile.classList.remove('on');
  }
}

// ── Erase panel ───────────────────────────────────────────────────────────────
const domIn    = document.getElementById('domain-input');
const eraseBtn = document.getElementById('erase-btn');
const eraseLbl = document.getElementById('erase-lbl');
const sheetBg  = document.getElementById('sheet-bg');
const shTarget = document.getElementById('sh-target');
const shCancel = document.getElementById('sh-cancel');
const shOk     = document.getElementById('sh-ok');
const noWarn   = document.getElementById('no-warn');
const optsEl   = document.getElementById('opts-strip');
let pendD=null, pendO=null;

document.getElementById('autofill-btn').addEventListener('click', async () => {
  try {
    const [tab]=await api.tabs.query({active:true,currentWindow:true});
    if (tab?.url) { const h=new URL(tab.url).hostname.replace(/^www\./,'').toLowerCase(); if(h){domIn.value=h;domIn.focus();} }
  } catch {}
});

eraseBtn.addEventListener('click', async () => {
  const raw=domIn.value.trim(); if(!raw){domIn.focus();return;}
  const domain=norm(raw);
  if (!domain||!domain.includes('.')) { logClear(); L.err(`"${domain}" is not a valid domain`); return; }
  // Read opts including nuke tile (only active when allowNuke is true)
  const opts = readOpts(optsEl);
  // Ensure nuke is only set when truly allowed
  opts.nuke = opts.nuke && S.allowNuke;
  if (S.confirm) { pendD=domain; pendO=opts; shTarget.textContent=domain; sheetBg.classList.add('open'); return; }
  await doErase(domain, opts);
});

domIn.addEventListener('keydown', e => { if(e.key==='Enter') eraseBtn.click(); });
shCancel.addEventListener('click', () => { sheetBg.classList.remove('open'); pendD=null; pendO=null; });
sheetBg.addEventListener('click', e => { if(e.target===sheetBg){sheetBg.classList.remove('open');pendD=null;pendO=null;} });
shOk.addEventListener('click', async () => {
  if (noWarn.checked) { S.confirm=false; await saveS(); document.getElementById('s-confirm').checked=false; }
  sheetBg.classList.remove('open');
  const d=pendD, o=pendO; pendD=null; pendO=null;
  if (d&&o) await doErase(d, o);
});

async function doErase(domain, opts) {
  eraseBtn.disabled=true; eraseLbl.textContent='Erasing...';
  eraseBtn.classList.remove('done','sweep');
  const scan=eraseBtn.querySelector('.eb-scan');
  scan.style.animation='none'; void scan.offsetWidth; scan.style.animation='';
  eraseBtn.classList.add('sweep');
  try {
    await runErase(domain, opts);
    eraseBtn.classList.remove('sweep'); eraseBtn.classList.add('done'); eraseLbl.textContent='✓ Done';
    setTimeout(()=>{ eraseBtn.disabled=false; eraseBtn.classList.remove('done'); eraseLbl.textContent='Erase'; }, 2500);
  } catch(err) {
    eraseBtn.classList.remove('sweep'); eraseBtn.disabled=false; eraseLbl.textContent='Erase';
    logClear(); L.err(err.message || 'Erase failed');
  }
}

// ── Quick list ────────────────────────────────────────────────────────────────
const qForm  = document.getElementById('q-form');
const qfD    = document.getElementById('qf-d');
const qfN    = document.getElementById('qf-n');
const qfOpts = document.getElementById('qf-opts');
const qItems = document.getElementById('q-items');

document.getElementById('q-add-open').addEventListener('click', () => {
  qForm.classList.toggle('open');
  if (qForm.classList.contains('open')) qfD.focus(); else { qfD.value=''; qfN.value=''; }
});
async function addQuick() {
  const d=norm(qfD.value); if(!d||!d.includes('.')) return;
  const nick=qfN.value.trim().slice(0,32)||null, opts=readOpts(qfOpts);
  const list=await load(K.Q,[]);
  if (!list.some(e=>e.domain===d)) { list.push({domain:d,nick,opts}); await save(K.Q,list); }
  qfD.value=''; qfN.value=''; qForm.classList.remove('open'); renderQ(list);
}
document.getElementById('qf-ok').addEventListener('click', addQuick);
qfD.addEventListener('keydown', e=>{if(e.key==='Enter')qfN.focus();if(e.key==='Escape')qForm.classList.remove('open');});
qfN.addEventListener('keydown', e=>{if(e.key==='Enter')addQuick();if(e.key==='Escape')qForm.classList.remove('open');});

function renderQ(list) {
  if (!list.length) { qItems.innerHTML='<div class="ls-empty">No saved domains.</div>'; return; }
  qItems.innerHTML = list.map((item,i) => `
    <div>
      <div class="li">
        <span class="li-txt ${item.nick?'nick':''}">${esc(item.nick||item.domain)}</span>
        <div class="li-acts">
          <button class="la" data-a="q-run" data-i="${i}">&#9889;</button>
          <button class="la" data-a="q-cfg" data-i="${i}">&#9881;</button>
          <button class="la del" data-a="q-del" data-i="${i}">&times;</button>
        </div>
      </div>
      <div class="li-opts" id="qo-${i}">
        <label class="lio ${item.opts?.cookies!==false?'on':''}" data-opt="cookies" data-qi="${i}"><input type="checkbox" ${item.opts?.cookies!==false?'checked':''}/>Cookies</label>
        <label class="lio ${item.opts?.storage!==false?'on':''}" data-opt="storage" data-qi="${i}"><input type="checkbox" ${item.opts?.storage!==false?'checked':''}/>Storage</label>
        <label class="lio ${item.opts?.history!==false?'on':''}" data-opt="history" data-qi="${i}"><input type="checkbox" ${item.opts?.history!==false?'checked':''}/>History</label>
        <label class="lio ${item.opts?.subs!==false?'on':''}" data-opt="subs" data-qi="${i}"><input type="checkbox" ${item.opts?.subs!==false?'checked':''}/>Subs</label>
      </div>
    </div>`).join('');
  qItems.querySelectorAll('.lio').forEach(tile => {
    tile.addEventListener('click', async e => {
      const cb=tile.querySelector('input'); cb.checked=!cb.checked; tile.classList.toggle('on',cb.checked);
      const qi=parseInt(tile.dataset.qi);
      const grid=tile.closest('.li-opts');
      const l2=await load(K.Q,[]);
      if (l2[qi]) { l2[qi].opts={}; grid.querySelectorAll('[data-opt]').forEach(t=>{l2[qi].opts[t.dataset.opt]=t.querySelector('input').checked;}); await save(K.Q,l2); }
    });
  });
}

qItems.addEventListener('click', async e => {
  const btn=e.target.closest('[data-a]'); if(!btn) return;
  const a=btn.dataset.a, i=parseInt(btn.dataset.i);
  const list=await load(K.Q,[]);
  if (a==='q-del') { list.splice(i,1); await save(K.Q,list); renderQ(list); return; }
  if (a==='q-cfg') { document.getElementById(`qo-${i}`)?.classList.toggle('open'); return; }
  if (a==='q-run') {
    const item=list[i]; if(!item) return;
    btn.textContent='…'; btn.disabled=true;
    try {
      await runErase(item.domain, {cookies:item.opts?.cookies!==false, storage:item.opts?.storage!==false, history:item.opts?.history!==false, subs:item.opts?.subs!==false, nuke:false});
      btn.innerHTML='&#10003;'; btn.style.color='var(--grn)';
      setTimeout(()=>{ btn.innerHTML='&#9889;'; btn.disabled=false; btn.style.color=''; }, 1800);
    } catch(err) { btn.innerHTML='&#9889;'; btn.disabled=false; logClear(); L.err(err.message||'Erase failed'); }
  }
});

// ── Watch list ────────────────────────────────────────────────────────────────
const wForm     = document.getElementById('w-form');
const wfD       = document.getElementById('wf-d');
const wfN       = document.getElementById('wf-n');
const wItems    = document.getElementById('w-items');
const autoEye   = document.getElementById('auto-eye');
const autoBanner= document.getElementById('auto-banner');

document.getElementById('w-add-open').addEventListener('click', () => {
  wForm.classList.toggle('open');
  if (wForm.classList.contains('open')) wfD.focus(); else { wfD.value=''; wfN.value=''; }
});
async function addWatch() {
  const d=norm(wfD.value); if(!d||!d.includes('.')) return;
  const nick=wfN.value.trim().slice(0,32)||null;
  const hash=await sha(d), m=mask(d);
  const list=await load(K.W,[]);
  if (!list.some(e=>e.hash===hash)) { list.push({hash,mask:m,nick}); await save(K.W,list); }
  wfD.value=''; wfN.value=''; wForm.classList.remove('open'); renderW(list);
}
document.getElementById('wf-ok').addEventListener('click', addWatch);
wfD.addEventListener('keydown', e=>{if(e.key==='Enter')wfN.focus();if(e.key==='Escape')wForm.classList.remove('open');});
wfN.addEventListener('keydown', e=>{if(e.key==='Enter')addWatch();if(e.key==='Escape')wForm.classList.remove('open');});

autoEye.addEventListener('click', async () => {
  S.auto=!S.auto; await saveS();
  autoEye.classList.toggle('off',!S.auto);
  autoBanner.style.display=S.auto?'none':'block';
  document.getElementById('s-auto').checked=S.auto;
});

function renderW(list) {
  if (!list.length) { wItems.innerHTML='<div class="ls-empty">No watched domains.</div>'; return; }
  wItems.innerHTML = list.map((e,i) => {
    const lbl = e.nick ? `<span class="li-txt nick">&#127991; ${esc(e.nick)}</span>` : `<span class="li-txt masked">${esc(e.mask)}</span>`;
    return `<div class="li">${lbl}<div class="li-acts"><button class="la del" data-a="w-del" data-i="${i}">&times;</button></div></div>`;
  }).join('');
}

wItems.addEventListener('click', async e => {
  const btn=e.target.closest('[data-a]'); if(!btn) return;
  if (btn.dataset.a==='w-del') {
    const i=parseInt(btn.dataset.i);
    const list=await load(K.W,[]); list.splice(i,1); await save(K.W,list); renderW(list);
  }
});

// ── Settings toggles ──────────────────────────────────────────────────────────
function bindTog(id, key, cb) {
  const el=document.getElementById(id);
  el.addEventListener('change', async () => { S[key]=el.checked; await saveS(); if(cb) cb(el.checked); });
}
bindTog('s-confirm',   'confirm',    null);
bindTog('s-sandbox',   'sandbox',    null);
bindTog('s-auto',      'auto',       v => { autoEye.classList.toggle('off',!v); autoBanner.style.display=v?'none':'block'; });
bindTog('s-tamper',    'tamper',     null);
bindTog('s-auto-nuke', 'autoNuke',   null);
bindTog('s-allow-nuke','allowNuke',  v => { updateNukeTile(); });

function syncS() {
  document.getElementById('s-confirm').checked   = S.confirm;
  document.getElementById('s-sandbox').checked   = S.sandbox;
  document.getElementById('s-auto').checked      = S.auto;
  document.getElementById('s-tamper').checked    = S.tamper;
  document.getElementById('s-auto-nuke').checked = S.autoNuke;
  document.getElementById('s-allow-nuke').checked= S.allowNuke;
}

// ── Export / Import ───────────────────────────────────────────────────────────
document.getElementById('btn-export').addEventListener('click', async () => {
  const [q, w, s] = await Promise.all([load(K.Q,[]), load(K.W,[]), load(K.S,{})]);
  const data = { v:1, exported: new Date().toISOString(), quick:q, watch:w, settings:s };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `domain-eraser-backup-${Date.now()}.json`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.getElementById('import-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.v) throw new Error('Invalid backup file.');
    if (data.quick)    await save(K.Q, data.quick);
    if (data.watch)    await save(K.W, data.watch);
    if (data.settings) await save(K.S, data.settings);
    await init(); // reload everything
  } catch(err) {
    logClear(); L.err('Import failed: ' + (err.message||'invalid file'));
    // Navigate back to main to show the error
    vp.className = 'vp';
  }
  e.target.value = ''; // reset file input
});

// ── Render lists (called when entering lists screen) ─────────────────────────
async function renderLists() {
  const [q, w] = await Promise.all([load(K.Q,[]), load(K.W,[])]);
  renderQ(q); renderW(w);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const [q, w, sv] = await Promise.all([load(K.Q,[]), load(K.W,[]), load(K.S,{})]);
  S = {...DS, ...sv};
  syncS();
  updateNukeTile();
  autoEye.classList.toggle('off', !S.auto);
  autoBanner.style.display = S.auto ? 'none' : 'block';
  renderQ(q); renderW(w);
}
init();
