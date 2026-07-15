// ══════════════════════ STATE ══════════════════════
let trades = [];
let idb = null;
let pool = [];           // vollständige gefilterte Treffermenge (für Stats)
let shown = [];          // sichtbare, geflootete Untermenge (max. 8, per Dismiss/Refill gesteuert)
let excludedIds = new Set();
let referenceReasons = {}; // { tradeId: text } — nur diese Session, bis explizit an Trade-Notizen angehängt
let fsIdx = -1;          // Index in `shown`
let fsSlot = null;       // aktuell gezeigter Slot-Key

const FILTER_DEFS = [
  { cat:'strategy', label:'STRATEGY', items:[
    ['Day Trap','Day Trap'], ['Session Rider','Session Rider'], ['PO3 Rider7','PO3 Rider7'], ['PO3 Rider10','PO3 Rider10']
  ]},
  { cat:'dir', label:'DIRECTION', items:[ ['LONG','⬆ LONG'], ['SHORT','⬇ SHORT'] ] },
  { cat:'sym', label:'SYMBOL', items:[
    ['MNQ','MNQ'], ['MGC','MGC'], ['GER40','GER40'], ['ES','ES'], ['YM','YM'], ['XAUUSD','XAUUSD']
  ]},
  { cat:'tf', label:'TIMEFRAME', items:[ ['tf:7h+4h','7h + 4h'], ['tf:7h','7h only'], ['tf:4h','4h only'] ] },
  { cat:'candle', label:'SESSION', items:[
    ['candle:premarket_06','Pre-Mkt 06'], ['candle:london_01','London 01'], ['candle:london_02','London 02'],
    ['candle:ny_08','NY 08'], ['candle:ny_10','NY 10']
  ]},
  { cat:'sweep', label:'SWEEP', items:[
    ['sweep:pdh','PDH'], ['sweep:pdl','PDL'], ['sweep:prev_7h','Prev 7h'], ['sweep:prev_4h','Prev 4h']
  ]},
  { cat:'m15', label:'15M ENTRY', items:[
    ['15m:cisd+sweep+fvg','CISD+Sweep+FVG'], ['15m:cisd+fvg','CISD+FVG'],
    ['15m:cisd+fvg+sweep_in_fvg','FVG+Sweep-in-FVG'], ['15m:fvg+sweep','FVG+Sweep'], ['15m:sweep','Sweep only']
  ]},
  { cat:'cpos', label:'CANDLE POS', items:[
    ['cpos:c2','C2 — Reversal'], ['cpos:c3','C3 — Continuation'], ['cpos:c4','C4 — 2nd Cont.'], ['cpos:c2late','C2 late']
  ]},
  { cat:'grade', label:'GRADE', items:[ ['A+','A+'], ['A','A'], ['B','B'], ['C','C'] ] },
  { cat:'acct', label:'ACCOUNT', items:[
    ['funded','Funded'], ['eval','Eval'], ['paper','Paper'], ['personal','Personal'], ['backtest','🔬 Backtest']
  ]},
];
let filters = {}; FILTER_DEFS.forEach(g => filters[g.cat] = []);
let refOnly = false; // "Nur Referenz-Setups" — Best-Practice-Marker aus Futures Desk (t.refSetup), geteilt ueber fd_trades

function toggleRefSetup(id, ev){
  if(ev) ev.stopPropagation();
  const t = trades.find(x => x.id === id);
  if(!t) return;
  t.refSetup = !t.refSetup;
  saveTrades();
  renderWall();
}

function toggleRefOnly(el){
  refOnly = !refOnly;
  if(el) el.classList.toggle('on', refOnly);
  shown = [];
  renderWall();
}

// ══════════════════════ THEME (3-Stufen, wie Futures Desk) ══════════════════════
const THEME_CYCLE = ['dark','dim','light'];
const THEME_ICONS = { dark:'🌙', dim:'🌗', light:'☀️' };
function toggleTheme(){
  const html = document.documentElement;
  const cur = html.getAttribute('data-theme') || 'dark';
  const idx = THEME_CYCLE.indexOf(cur);
  const next = THEME_CYCLE[(idx+1) % THEME_CYCLE.length];
  html.setAttribute('data-theme', next);
  document.getElementById('theme-btn').textContent = THEME_ICONS[next];
  try{ localStorage.setItem('fd_sessionguide_theme', next); }catch(e){}
}
(function initTheme(){
  let saved = null;
  try{ saved = localStorage.getItem('fd_sessionguide_theme') || localStorage.getItem('fd_theme'); }catch(e){}
  const t = THEME_CYCLE.includes(saved) ? saved : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('theme-btn');
  if(btn) btn.textContent = THEME_ICONS[t];
})();

// ══════════════════════ IDB ══════════════════════
function openIDB(){
  return new Promise((res,rej)=>{
    const req = indexedDB.open('FuturesDesk', 1);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains('images')) db.createObjectStore('images');
    };
  });
}
function idbGet(key){
  if(!idb) return Promise.resolve(null);
  return new Promise(res=>{
    const tx = idb.transaction('images','readonly');
    const req = tx.objectStore('images').get(key);
    req.onsuccess = e => res(e.target.result || null);
    req.onerror   = () => res(null);
  });
}

// ══════════════════════ DATA HELPERS ══════════════════════
const SLOTS = ['daily','4h','1h','entry'];
function rawSlotVal(t, slot){
  const raw = t.imgs || {};
  if(Array.isArray(raw)) return raw[SLOTS.indexOf(slot)] || null;
  return raw[slot] || null;
}
function hasSlot(t, slot){ return !!rawSlotVal(t, slot); }
async function resolveSlot(t, slot){
  const v = rawSlotVal(t, slot);
  if(!v) return null;
  if(v === '__idb__') return (await idbGet('img_' + t.id + '_' + slot)) || null;
  return v;
}
function heroSlotFor(t){
  if(t.heroSlot && hasSlot(t, t.heroSlot)) return t.heroSlot;
  for(const s of ['entry','1h','4h','daily']) if(hasSlot(t, s)) return s;
  return null;
}
function rrNum(t){ return parseFloat(String(t.rr||'0').replace('R','').trim()||'0'); }
function tagsByPrefix(t, prefix){
  return (t.setupTags||[]).filter(tag => tag.startsWith(prefix));
}
function otherTags(t){
  const known = ['tf:','candle:','sweep:','15m:','3m:','cpos:','ps:'];
  return (t.setupTags||[]).filter(tag => !known.some(p => tag.startsWith(p)));
}
function stripPrefix(tag){ return tag.replace(/^(tf:|candle:|sweep:|15m:|3m:|cpos:|ps:)/,''); }

// ══════════════════════ LOAD (nur lesen — trades bleibt 1:1 wie in fd_trades gespeichert) ══════════════════════
function loadTrades(){
  try{ trades = JSON.parse(localStorage.getItem('fd_trades') || '[]'); }catch(e){ trades = []; }
}
function saveTrades(){
  // Schreibt das komplette trades-Array unverändert zurück — es wird NIE etwas anderes
  // als das notes-Feld des einen betroffenen Trades mutiert (siehe saveReasonToTradeNotes).
  try{ localStorage.setItem('fd_trades', JSON.stringify(trades)); }catch(e){ console.warn('saveTrades failed', e); }
}
function gpDateKey(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
// Vorher zeigte dieses Label den STATISCHEN gpData.wipBias-Wert vom alten, ungenutzten
// "What's in Play"-Panel im Futures Desk -- der aendert sich nie durch irgendeine Interaktion
// HIER in Guided Session, weshalb es fuer den User wie ein kaputtes/haengendes "immer bear"
// aussah, egal was er klickte. Fix: Label leitet sich jetzt LIVE aus dem aktuell aktiven
// DIRECTION-Filter ab (filters.dir) -- reagiert also tatsaechlich auf Klicks in der Filterbar.
function loadTodayContext(){
  let gpData = {};
  try{ gpData = JSON.parse(localStorage.getItem('fd_gpdata') || '{}'); }catch(e){}
  const key = gpDateKey(new Date());
  const d = gpData[key] || {};
  const notesEl = document.getElementById('ctx-notes-txt');
  if(notesEl) notesEl.textContent = d.wipNotes || '';
  updateLiveBiasIndicator();
  return d;
}
function updateLiveBiasIndicator(){
  const strip = document.getElementById('ctx-strip');
  const biasLbl = document.getElementById('ctx-bias-lbl');
  if(!strip || !biasLbl) return;
  const dirSel = filters.dir || [];
  const onlyLong  = dirSel.length === 1 && dirSel[0] === 'LONG';
  const onlyShort = dirSel.length === 1 && dirSel[0] === 'SHORT';
  let cls = 'neutral', txt = '⚪ CONTEXT';
  if(onlyLong)  { cls = 'bull'; txt = '🟢 BULL — Filter: LONG'; }
  if(onlyShort) { cls = 'bear'; txt = '🔴 BEAR — Filter: SHORT'; }
  biasLbl.className = 'ctx-bias ' + cls;
  biasLbl.textContent = txt;
  const hasNotes = !!(document.getElementById('ctx-notes-txt')?.textContent || '').trim();
  if(onlyLong || onlyShort || hasNotes) strip.classList.add('show');
  else strip.classList.remove('show');
}

// ══════════════════════ FILTER BAR ══════════════════════
function renderFilterBar(){
  const el = document.getElementById('fbar');
  el.innerHTML = FILTER_DEFS.map(g => `
    <div class="fbar-row">
      <div class="fbar-lbl">${g.label}</div>
      ${g.items.map(([val,lbl]) => `<button class="fchip" data-cat="${g.cat}" data-val="${val}" onclick="toggleFilter('${g.cat}','${val}',this)">${lbl}</button>`).join('')}
      ${g.cat==='grade' ? `<div class="fbar-actions">
        <button class="fchip-ref${refOnly?' on':''}" onclick="toggleRefOnly(this)" title="Nur als Best-Practice markierte Referenz-Setups anzeigen">🏆 Nur Referenz</button>
        <button class="fbar-btn load-today" onclick="loadTodayFilters()">⟳ Heutige WIP-Filter laden</button>
        <button class="fbar-btn" onclick="clearFilters()">✕ CLEAR</button>
      </div>` : ''}
    </div>
  `).join('');
}
// ══════════════════════ FILTERLEISTE EIN-/AUSKLAPPEN ══════════════════════
const FBAR_COLLAPSE_KEY = 'fd_sessionguide_fbar_collapsed';
function toggleFilterBar(){
  const body = document.getElementById('fbar-body');
  const collapsed = body.classList.toggle('collapsed');
  document.getElementById('fbar-chevron').classList.toggle('collapsed', collapsed);
  try{ localStorage.setItem(FBAR_COLLAPSE_KEY, collapsed ? '1' : '0'); }catch(e){}
}
function initFilterBarCollapse(){
  let collapsed = false;
  try{ collapsed = localStorage.getItem(FBAR_COLLAPSE_KEY) === '1'; }catch(e){}
  document.getElementById('fbar-body').classList.toggle('collapsed', collapsed);
  document.getElementById('fbar-chevron').classList.toggle('collapsed', collapsed);
}
function updateFilterBarCount(){
  const n = Object.values(filters).reduce((s,a) => s + a.length, 0);
  const el = document.getElementById('fbar-active-count');
  if(el) el.textContent = n ? `(${n} aktiv)` : '';
}

function toggleFilter(cat, val, el){
  const arr = filters[cat];
  const idx = arr.indexOf(val);
  if(idx >= 0) arr.splice(idx,1); else arr.push(val);
  el.classList.toggle('on', arr.includes(val));
  shown = [];
  renderWall();
}
function clearFilters(){
  FILTER_DEFS.forEach(g => filters[g.cat] = []);
  document.querySelectorAll('.fchip.on').forEach(el => el.classList.remove('on'));
  refOnly = false;
  const refChip = document.querySelector('.fchip-ref'); if(refChip) refChip.classList.remove('on');
  shown = [];
  excludedIds.clear();
  renderWall();
}
function loadTodayFilters(){
  let gpData = {};
  try{ gpData = JSON.parse(localStorage.getItem('fd_gpdata') || '{}'); }catch(e){}
  const key = gpDateKey(new Date());
  const dayPlan = gpData[key] || {};
  const saved = dayPlan.wipFilters || {};
  FILTER_DEFS.forEach(g => { filters[g.cat] = Array.isArray(saved[g.cat]) ? [...saved[g.cat]] : []; });
  document.querySelectorAll('.fchip').forEach(el => {
    el.classList.toggle('on', filters[el.dataset.cat].includes(el.dataset.val));
  });
  refOnly = !!dayPlan.wipRefOnly;
  const refChip = document.querySelector('.fchip-ref');
  if(refChip) refChip.classList.toggle('on', refOnly);
  shown = [];
  renderWall();
}

// ══════════════════════ MATCHING / DISMISS-REFILL ══════════════════════
function getPool(){
  const allEmpty = Object.values(filters).every(a => a.length === 0) && !refOnly;
  if(allEmpty) return [];
  return trades.filter(t => {
    const tags = t.setupTags || [];
    if(filters.strategy.length && !filters.strategy.includes(t.strategy||'')) return false;
    if(filters.dir.length      && !filters.dir.includes(t.dir||''))            return false;
    if(filters.sym.length      && !filters.sym.includes(t.sym||''))            return false;
    if(filters.grade.length    && !filters.grade.includes(t.grade||''))        return false;
    if(filters.tf.length       && !filters.tf.some(v => tags.includes(v)))     return false;
    if(filters.candle.length   && !filters.candle.some(v => tags.includes(v))) return false;
    if(filters.sweep.length    && !filters.sweep.some(v => tags.includes(v)))  return false;
    if(filters.m15.length      && !filters.m15.some(v => tags.includes(v)))    return false;
    if(filters.cpos.length     && !filters.cpos.some(v => tags.includes(v)))   return false;
    // Account-Type ist ein normaler, NICHT-restriktiver Filter: leer = alle Kontotypen gemischt (verzerrt sonst die Referenz).
    if(filters.acct.length     && !filters.acct.includes(t.accountType||'funded')) return false;
    if(refOnly && !t.refSetup) return false;
    return true;
  }).sort((a,b) => (b.id||0) - (a.id||0));
}
function refillShown(){
  // Max. gleichzeitig sichtbare Karten von 8 auf 6 reduziert (User-Wunsch nach dem
  // Abstands-Fix): bei 6 Karten passt der grosszuegigere Kartenabstand eher ohne
  // Scrollen auf den Bildschirm. Restliche Treffer bleiben ueber Dismiss (Nachladen
  // aus dem gefilterten Pool) weiterhin erreichbar, Stats oben bleiben unveraendert
  // auf dem GESAMTEN Pool berechnet, nicht nur den 6 gezeigten.
  const MAX_SHOWN = 6;
  shown = shown.filter(t => !excludedIds.has(t.id) && pool.some(p => p.id === t.id));
  for(const t of pool){
    if(shown.length >= MAX_SHOWN) break;
    if(excludedIds.has(t.id)) continue;
    if(shown.some(s => s.id === t.id)) continue;
    shown.push(t);
  }
}
function dismissCard(id){
  excludedIds.add(id);
  shown = shown.filter(t => t.id !== id);
  refillShown();
  renderRadial();
  updateExclRow();
}
function dismissFromModal(id){ closeFs(); dismissCard(id); }
function resetExclusions(){
  excludedIds.clear();
  shown = [];
  refillShown();
  renderRadial();
  updateExclRow();
}
function updateExclRow(){
  const row = document.getElementById('excl-row');
  const n = excludedIds.size;
  row.classList.toggle('show', n > 0);
  document.getElementById('excl-count').textContent = n + ' Trade' + (n!==1?'s':'') + ' aus dieser Session ausgeblendet';
}

// ══════════════════════ STATS (über volle gefilterte Pool, nicht nur die gezeigten Karten) ══════════════════════
function updateStats(){
  const total = pool.length;
  const winners = pool.filter(t => rrNum(t) > 0);
  const totalR = pool.reduce((s,t) => s + rrNum(t), 0);
  const wr = total ? (winners.length/total*100).toFixed(0)+'%' : '—';
  const avgR = total ? (totalR/total).toFixed(2)+'R' : '—';
  document.getElementById('s-total').textContent = total || '—';
  document.getElementById('s-wr').textContent = wr;
  const trEl = document.getElementById('s-totalr');
  trEl.textContent = total ? (totalR>=0?'+':'')+totalR.toFixed(2)+'R' : '—';
  trEl.style.color = total ? (totalR>=0?'var(--green)':'var(--red)') : 'var(--white)';
  const arEl = document.getElementById('s-avgr');
  arEl.textContent = avgR;
  arEl.style.color = total ? (parseFloat(avgR)>=0?'var(--green)':'var(--red)') : 'var(--white)';
}

// ══════════════════════ RENDER: WALL / EMPTY STATES ══════════════════════
function renderWall(){
  pool = getPool();
  updateStats();
  updateFilterBarCount();
  updateLiveBiasIndicator();
  const emptyWrap = document.getElementById('wall-empty-wrap');
  const body = document.getElementById('session-body');
  const allEmpty = Object.values(filters).every(a => a.length === 0);

  if(allEmpty){
    body.style.display = 'none';
    emptyWrap.innerHTML = `<div class="wall-empty">
      <div class="wall-empty-icon">🧠</div>
      <div class="wall-empty-title">Bereit für deine Guided Session</div>
      <div class="wall-empty-sub">Wähle oben Filter (Strategy, Session, Sweep, 15m-Entry, Account …) — oder lade deine heutigen WIP-Filter aus dem Desk mit einem Klick. Deine markierten Hero-Screenshots erscheinen dann als visuelle Karten um deinen Leitsatz.</div>
    </div>`;
    updateExclRow();
    return;
  }
  if(!pool.length){
    body.style.display = 'none';
    emptyWrap.innerHTML = `<div class="wall-empty">
      <div class="wall-empty-icon">🔍</div>
      <div class="wall-empty-title">Keine passenden Trades</div>
      <div class="wall-empty-sub">Filter anpassen oder zurücksetzen.</div>
    </div>`;
    updateExclRow();
    return;
  }

  emptyWrap.innerHTML = '';
  body.style.display = 'flex';
  refillShown();
  renderRadial();
  updateExclRow();
}

// ══════════════════════ RADIAL LAYOUT ══════════════════════
function cardInnerHtml(t){
  const rr = String(t.rr||'—');
  const win = !rr.startsWith('-');
  const rrColor = rr==='—' ? 'rgba(255,255,255,0.6)' : win ? 'var(--green)' : 'var(--red)';
  const dirCls = t.dir==='LONG' ? 'long' : 'short';
  const hero = heroSlotFor(t);
  const hasReason = !!(referenceReasons[t.id] && referenceReasons[t.id].trim());
  let html = '';
  html += `<button class="gcard-dismiss" onclick="event.stopPropagation();dismissCard(${t.id})" title="Ausblenden, nächsten Treffer laden">✕</button>`;
  html += `<div class="gcard-img" id="rc-img-${t.id}"></div>`;
  if(!hero) html += `<div class="gcard-noimg"><div class="gcard-noimg-icon">🖼</div><div class="gcard-noimg-txt">KEIN HERO</div></div>`;
  if(hero) html += `<div class="gcard-hero-badge" title="Hero-Screenshot">⭐</div>`;
  html += `<div class="gcard-reason-badge" id="reason-badge-${t.id}" title="Referenz-Begründung vorhanden" style="display:${hasReason?'flex':'none'}">📝</div>`;
  html += `<div class="gcard-refsetup-badge ${t.refSetup?'on':''}" onclick="event.stopPropagation();toggleRefSetup(${t.id})" title="${t.refSetup?'Referenz-Setup entfernen':'Als Best-Practice Referenz-Setup markieren'}">🏆</div>`;
  if((t.accountType||'funded')==='backtest') html += `<div class="gcard-bt-badge" title="Backtest-Trade">🔬 BT</div>`;
  html += `<div class="gcard-scrim-top"><div><span class="gcard-sym">${t.sym||'?'}</span><span class="gcard-dir ${dirCls}">${t.dir||''}</span></div><div class="gcard-rr" style="color:${rrColor}">${rr}</div></div>`;
  html += `<div class="gcard-scrim-bot"><span class="gcard-strat">${t.strategy||t.setup||''}</span></div>`;
  return html;
}

function renderRadial(){
  const wrap = document.getElementById('radial-wrap');
  const cardsEl = document.getElementById('radial-cards');
  const svg = document.getElementById('radial-lines');
  cardsEl.innerHTML = '';
  svg.innerHTML = '';

  const n = shown.length;
  if(!n) return;

  // Kartengröße (muss zu .radial-card-wrap/.gcard CSS passen: 184px breit, 4:5 Seitenverhältnis = 230px hoch)
  const cardW = 184, cardH = 230;
  const marginX = 48, marginY = 42;
  const hubHalf = 128; // halbe Hub-Node-Breite (230px) + kleiner Sicherheitsabstand

  // Mindest-Radius. Faktor bewusst nur noch knapp über dem Original (0.94 -> 0.98, statt 1.15) und
  // Margen nur leicht erhöht (User-Entscheidung: Abstand fast auf Original zurück, weil 1.15 bei 6
  // Karten je nach Fensterhöhe immer noch Scrollen erzwang -- lieber etwas mehr Restrisiko für
  // minimalen Rand-Overlap auf sehr kurzen Fenstern als durchgehendes Scrollen).
  const diag = Math.sqrt(cardW*cardW + cardH*cardH);
  const radiusFloor = n > 1 ? Math.max(hubHalf, (diag * 0.98) / (2 * Math.sin(Math.PI / n))) : Math.max(hubHalf, 260);

  // Vertikal: so viel Platz nutzen wie der Container aktuell hergibt, nie unter das Überlappungs-Minimum
  const radiusYMax = wrap.clientHeight/2 - cardH/2 - marginY;
  const radiusY = Math.max(radiusFloor, radiusYMax);

  // Der Container darf NIE kleiner sein als für radiusY nötig -- Abstand/Sichtbarkeit jeder einzelnen
  // Karte hat Vorrang vor "passt exakt in den aktuellen Viewport". Reicht die Fensterhöhe nicht, wächst
  // der Container hier (die Seite wird dann vertikal scrollbar), statt Karten zu stauchen, sie zu
  // überlappen oder Richtung Hub zu quetschen (das war der Bug im vorherigen Clamp-Versuch: der harte
  // Min/Max-Clamp auf x/y hat mehrere Karten auf denselben Rand gezogen statt den Container wachsen
  // zu lassen).
  const neededH = radiusY*2 + cardH + marginY*2;
  if(neededH > wrap.clientHeight) wrap.style.height = neededH + 'px';

  const W = wrap.clientWidth, H = Math.max(wrap.clientHeight, neededH);
  const cx = W/2, cy = H/2;

  // Horizontal: volle verfügbare Breite ausnutzen (Strecken erhöht nur den X-Abstand — kann eine Überlappung nie verschlimmern)
  const radiusXMax = W/2 - cardW/2 - marginX;
  const radiusX = Math.max(radiusY, radiusXMax);

  shown.forEach((t,i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI/2;
    const x = cx + radiusX * Math.cos(angle);
    const y = cy + radiusY * Math.sin(angle);

    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1', cx); line.setAttribute('y1', cy);
    line.setAttribute('x2', x); line.setAttribute('y2', y);
    line.setAttribute('class', 'radial-line');
    line.style.animationDelay = (i*0.15) + 's';
    svg.appendChild(line);

    const outer = document.createElement('div');
    outer.className = 'radial-card-wrap';
    outer.style.left = (x - 92) + 'px';
    outer.style.top  = (y - 115) + 'px';
    outer.style.setProperty('--floatname', i%2===0 ? 'floatA' : 'floatB');
    outer.style.setProperty('--floatdur', (6 + (i%4)*1.2) + 's');
    outer.style.setProperty('--floatdelay', (i*0.35) + 's');

    const inner = document.createElement('div');
    const hasReason = !!(referenceReasons[t.id] && referenceReasons[t.id].trim());
    inner.className = 'gcard' + (hasReason ? ' has-reason' : '') + (((t.accountType||'funded')==='backtest') ? ' is-backtest' : '');
    inner.innerHTML = cardInnerHtml(t);
    inner.addEventListener('click', (e) => {
      if(e.target.closest('.gcard-dismiss')) return;
      openFs(shown.indexOf(t));
    });
    inner.addEventListener('mousemove', (e) => {
      const r = inner.getBoundingClientRect();
      const px = (e.clientX-r.left)/r.width, py=(e.clientY-r.top)/r.height;
      inner.style.setProperty('--mx',(px*100)+'%'); inner.style.setProperty('--my',(py*100)+'%');
      inner.classList.add('hovering');
    });
    inner.addEventListener('mouseleave', () => inner.classList.remove('hovering'));

    outer.appendChild(inner);
    cardsEl.appendChild(outer);

    setTimeout(() => {
      outer.classList.add('in');
      populateCardImage(t);
      setTimeout(() => outer.classList.add('floating'), 500);
    }, 150 + i*130);
  });
}

async function populateCardImage(t){
  const hero = heroSlotFor(t);
  const el = document.getElementById('rc-img-'+t.id);
  if(!el || !hero) return;
  const data = await resolveSlot(t, hero);
  if(data) el.style.backgroundImage = `url(${data})`;
}

// ══════════════════════ FULLSCREEN MODAL ══════════════════════
async function openFs(idx){
  fsIdx = idx;
  const t = shown[idx];
  fsSlot = heroSlotFor(t);
  document.getElementById('fs-overlay').classList.add('open');
  await renderFsDetail();
}
function closeFs(){
  document.getElementById('fs-overlay').classList.remove('open');
  fsIdx = -1; fsSlot = null;
}
function fsNav(dir){
  const next = fsIdx + dir;
  if(next < 0 || next >= shown.length) return;
  openFs(next);
}
function fsCycleSlot(dir){
  const t = shown[fsIdx];
  const avail = SLOTS.filter(s => hasSlot(t, s));
  if(!avail.length) return;
  let idx = avail.indexOf(fsSlot);
  idx = (idx + dir + avail.length) % avail.length;
  fsSlot = avail[idx];
  renderFsImage();
  renderFsThumbs();
}
function fsSetSlot(s){
  fsSlot = s; renderFsImage();
  document.querySelectorAll('.fs-thumb').forEach(el => el.classList.toggle('active', el.id==='fs-thumb-'+s));
}

async function renderFsDetail(){
  const t = shown[fsIdx];
  const rr = String(t.rr||'—');
  const win = !rr.startsWith('-');
  const rrColor = rr==='—' ? 'var(--grey2)' : win ? 'var(--green)' : 'var(--red)';
  const brokenRules = (t.ruleData||[]).filter(r => r.state==='broke').map(r => r.text).filter(Boolean);
  const notesRaw = (t.notes||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').trim();
  const acctTag = (t.accountType||'funded')==='backtest' ? ` &nbsp;·&nbsp; <span style="color:var(--purple)">🔬 BACKTEST</span>` : '';

  const tagGroups = [
    ['STRATEGIE', t.strategy ? [t.strategy] : []],
    ['TIMEFRAME', tagsByPrefix(t,'tf:').map(stripPrefix)],
    ['SESSION / CANDLE', tagsByPrefix(t,'candle:').map(stripPrefix)],
    ['SWEEP LEVEL', tagsByPrefix(t,'sweep:').map(stripPrefix)],
    ['15M ENTRY', tagsByPrefix(t,'15m:').map(stripPrefix)],
    ['3M CONFIRM', tagsByPrefix(t,'3m:').map(stripPrefix)],
    ['CANDLE POSITION', tagsByPrefix(t,'cpos:').map(stripPrefix)],
    ['SONSTIGE', otherTags(t)],
  ].filter(([,arr]) => arr.length);

  document.getElementById('fs-detail').innerHTML = `
    <div class="fs-detail-hdr">
      <div class="fs-sym">${t.sym||'?'}</div>
      <span class="gcard-dir ${t.dir==='LONG'?'long':'short'}" style="position:static">${t.dir||''}</span>
      <div class="fs-rr" style="color:${rrColor}">${rr}</div>
    </div>
    <div class="fs-meta">${t.date||''} &nbsp;·&nbsp; ${t.session||''} &nbsp;·&nbsp; Grade: ${t.grade||'—'}${acctTag}</div>

    <div class="fs-sec fs-reason-sec">
      <div class="fs-sec-title" style="color:var(--gold)">💭 WARUM ALS REFERENZ FÜR HEUTE?</div>
      <textarea class="fs-reason-ta" id="fs-reason-ta" placeholder="Was macht dieses Setup gerade relevant für deine heutige Session?">${referenceReasons[t.id]||''}</textarea>
      <div class="fs-reason-actions">
        <button class="fs-reason-save-btn" onclick="saveReasonToTradeNotes(${t.id})">📌 An Trade-Notizen anhängen</button>
        <span class="fs-reason-saved-msg" id="reason-saved-msg"></span>
      </div>
    </div>

    ${tagGroups.length ? `<div class="fs-sec">
      <div class="fs-sec-title">CONFIRMATIONS</div>
      <div class="fs-tags-grid">
        ${tagGroups.map(([lbl,arr]) => `<div class="fs-tag-group" style="width:100%">
          <div class="fs-tag-group-lbl">${lbl}</div>
          ${arr.map(v => `<span class="fs-tag">${v}</span>`).join('')}
        </div>`).join('')}
      </div>
    </div>` : ''}

    ${notesRaw ? `<div class="fs-sec">
      <div class="fs-sec-title">NOTES</div>
      <div class="fs-notes">${notesRaw}</div>
    </div>` : ''}

    <div class="fs-sec fs-warn-sec">
      <div class="fs-sec-title" style="color:var(--red)">⚠ WORAUF ACHTEN</div>
      ${brokenRules.length
        ? brokenRules.map(r => `<div class="fs-warn-item">✗ <span>${r}</span></div>`).join('')
        : `<div class="fs-warn-empty">Keine dokumentierten Regelverstöße bei diesem Setup — sauber ausgeführt.</div>`}
    </div>

    <button class="fs-dismiss-btn" onclick="dismissFromModal(${t.id})">✕ Aus dieser Session ausblenden</button>

    <div class="fs-footer-nav">
      <button class="fs-footer-btn" onclick="fsNav(-1)" ${fsIdx<=0?'disabled':''}>← Vorheriger Trade</button>
      <span class="fs-pos-lbl">${fsIdx+1} / ${shown.length}</span>
      <button class="fs-footer-btn" onclick="fsNav(1)" ${fsIdx>=shown.length-1?'disabled':''}>Nächster Trade →</button>
    </div>
  `;

  const reasonTA = document.getElementById('fs-reason-ta');
  reasonTA.addEventListener('input', () => {
    referenceReasons[t.id] = reasonTA.value;
    const badge = document.getElementById('reason-badge-'+t.id);
    if(badge) badge.style.display = reasonTA.value.trim() ? 'flex' : 'none';
  });

  await renderFsImage();
  renderFsThumbs();
}

async function renderFsImage(){
  const main = document.getElementById('fs-imgmain');
  const t = shown[fsIdx];
  if(!fsSlot){
    main.innerHTML = `<div class="fs-imgmain-empty">🖼<br>Kein Screenshot für diesen Trade</div>`;
    return;
  }
  const data = await resolveSlot(t, fsSlot);
  main.innerHTML = data
    ? `<img src="${data}" alt="${fsSlot}">`
    : `<div class="fs-imgmain-empty">Kein Screenshot</div>`;
}

async function renderFsThumbs(){
  const t = shown[fsIdx];
  const avail = SLOTS.filter(s => hasSlot(t, s));
  const wrap = document.getElementById('fs-thumbs');
  if(!avail.length){ wrap.innerHTML = ''; return; }
  wrap.innerHTML = avail.map(s => `<div class="fs-thumb ${s===fsSlot?'active':''}" id="fs-thumb-${s}" onclick="fsSetSlot('${s}')">
    ${s===t.heroSlot ? '<span class="fs-thumb-star">⭐</span>' : ''}
    <span class="fs-thumb-lbl">${s.toUpperCase()}</span>
  </div>`).join('');
  for(const s of avail){
    const data = await resolveSlot(t, s);
    const el = document.getElementById('fs-thumb-'+s);
    if(el && data) el.style.backgroundImage = `url(${data})`;
  }
}

// ══════════════════════ REASON → ECHTE TRADE-NOTIZEN ══════════════════════
// Schreibt NUR das notes-Feld des einen betroffenen Trades; imgs/__idb__-Platzhalter,
// heroSlot, ruleData, accountType etc. bleiben unangetastet (saveTrades() serialisiert
// das komplette, ansonsten unveränderte trades-Array zurück nach fd_trades).
function saveReasonToTradeNotes(id){
  const t = trades.find(x => x.id === id);
  if(!t) return;
  const reason = (referenceReasons[id]||'').trim();
  if(!reason) return;
  const today = new Date().toISOString().slice(0,10);
  const marker = `\n\n[Guided Session ${today}] ${reason}`;
  t.notes = (t.notes||'') + marker;
  saveTrades();
  addToReferencedTrades(t.id);
  stageReferenceForNextTrade(t.id);
  const biasTag = t.dir === 'LONG' ? ' (🟢 Bullish)' : t.dir === 'SHORT' ? ' (🔴 Bearish)' : '';
  const msg = document.getElementById('reason-saved-msg');
  if(msg){ msg.textContent = '✓ An Trade-Notizen angehängt' + biasTag; msg.style.opacity = '1'; setTimeout(() => { msg.style.opacity='0'; }, 2600); }
  renderFsDetail();
}

// Spiegelt die referenzierte Trade-ID zusätzlich in den Tagesplan (fd_gpdata[heute].referencedTrades),
// damit sie im Futures Desk Post-Session-Bereich als klickbare Referenz-Liste erscheint.
// Liest/schreibt fd_gpdata frisch (gleiches Pattern wie loadTodayContext/init) statt eines
// geteilten Moduls-States, um keine Race Condition mit gleichzeitigen Schreibern zu riskieren.
function addToReferencedTrades(tradeId){
  let gpd = {};
  try{ gpd = JSON.parse(localStorage.getItem('fd_gpdata') || '{}'); }catch(e){ gpd = {}; }
  const key = gpDateKey(new Date());
  if(!gpd[key]) gpd[key] = {};
  const list = Array.isArray(gpd[key].referencedTrades) ? gpd[key].referencedTrades : [];
  if(!list.includes(tradeId)) list.push(tradeId);
  gpd[key].referencedTrades = list;
  try{ localStorage.setItem('fd_gpdata', JSON.stringify(gpd)); }catch(e){ console.warn('addToReferencedTrades failed', e); }
}

// ══════════════════════ STAGED REFS (fuer den naechsten NEUEN Trade, v.a. Backtest-Workflow) ══════════════════════
// Anders als addToReferencedTrades() (haengt an den heutigen Tagesplan) ist das hier fuer den
// Fall "ich schaue mir in Session Guide Referenz-Setups an, BEVOR ich den eigentlichen (Backtest-)
// Trade logge". Die IDs werden hier zwischengespeichert und beim naechsten dlmLogTrade() im
// Hauptdesk direkt an den neuen Trade gehaengt (dlmConsumeStagedRefs()), danach geleert.
const STAGED_REFS_KEY = 'fd_sessionguide_staged_refs';
function stageReferenceForNextTrade(tradeId){
  let staged = [];
  try{ staged = JSON.parse(localStorage.getItem(STAGED_REFS_KEY) || '[]'); }catch(e){ staged = []; }
  if(!staged.includes(tradeId)) staged.push(tradeId);
  try{ localStorage.setItem(STAGED_REFS_KEY, JSON.stringify(staged)); }catch(e){ console.warn('stageReferenceForNextTrade failed', e); }
  renderStagedRefsBadge();
}
function clearStagedRefs(){
  try{ localStorage.removeItem(STAGED_REFS_KEY); }catch(e){}
  renderStagedRefsBadge();
}
// Aufschluesselung nach Richtung (nicht nur Flat-Count) -- beim Pre-Market-Research werden oft
// parallel bullishe (LONG) und bearishe (SHORT) Kandidaten-Setups gepinnt (zwei Szenarien im Blick,
// bis der Open eins bestaetigt). Die Richtung wird direkt vom referenzierten historischen Trade
// uebernommen (dir-Feld), keine separate Bull/Bear-Markierung noetig. Beim Trade-Log im Futures Desk
// wird ohnehin nur die zur tatsaechlich getradeten Richtung passende Haelfte automatisch attached
// (siehe dlmConsumeStagedRefs in future desk vXX.html) -- diese Badge zeigt schon hier transparent,
// was gerade in welchem Topf liegt.
function renderStagedRefsBadge(){
  const row = document.getElementById('staged-row');
  const lbl = document.getElementById('staged-count');
  if(!row || !lbl) return;
  let staged = [];
  try{ staged = JSON.parse(localStorage.getItem(STAGED_REFS_KEY) || '[]'); }catch(e){ staged = []; }
  if(!staged.length){ row.classList.remove('show'); return; }
  const bullN = staged.filter(id => { const rt = trades.find(x => x.id === id); return rt && rt.dir === 'LONG'; }).length;
  const bearN = staged.filter(id => { const rt = trades.find(x => x.id === id); return rt && rt.dir === 'SHORT'; }).length;
  const otherN = staged.length - bullN - bearN;
  const parts = [];
  if (bullN)  parts.push('🟢 ' + bullN + ' Bullish');
  if (bearN)  parts.push('🔴 ' + bearN + ' Bearish');
  if (otherN) parts.push(otherN + ' ohne Richtung');
  lbl.textContent = '📎 ' + parts.join(' · ') + ' — passende Haelfte wird beim Trade-Log automatisch verknuepft';
  row.classList.add('show');
}

// ══════════════════════ HUB-QUOTE (persönlicher Leitsatz) ══════════════════════
const QUOTE_KEY = 'fd_sessionguide_quote';
function initHubQuote(){
  const el = document.getElementById('hub-quote');
  let saved = '';
  try{ saved = localStorage.getItem(QUOTE_KEY) || ''; }catch(e){}
  el.textContent = saved;
  el.addEventListener('blur', () => {
    try{ localStorage.setItem(QUOTE_KEY, el.textContent); }catch(e){}
  });
}

// ══════════════════════ SIDE PANEL: SESSION NOTES / RECAP-PREVIEW ══════════════════════
function buildRecapText(){
  const notes = document.getElementById('session-notes-ta').value.trim();
  const refLines = shown
    .filter(t => referenceReasons[t.id] && referenceReasons[t.id].trim())
    .map(t => `- ${t.sym} ${t.dir} ${t.rr} (${t.date}) -- ${referenceReasons[t.id].trim()}`);
  let out = '';
  if(notes) out += notes + '\n\n';
  if(refLines.length) out += 'Referenz-Setups aus Guided Session:\n' + refLines.join('\n');
  return out.trim();
}
function transferToRecap(){
  const text = buildRecapText();
  document.getElementById('preview-lbl').style.display = 'block';
  const preview = document.getElementById('side-hub-preview');
  preview.textContent = text || '(noch keine Notizen oder Referenz-Begründungen eingetragen)';
  preview.style.display = 'block';
  document.getElementById('copy-preview-btn').style.display = text ? 'block' : 'none';
}
function copyPreview(){
  const text = buildRecapText();
  if(!text) return;
  const btn = document.getElementById('copy-preview-btn');
  const done = () => { const orig = btn.textContent; btn.textContent = '✓ Kopiert'; setTimeout(() => btn.textContent = orig, 1800); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, cb){
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); }catch(e){}
  document.body.removeChild(ta);
  if(cb) cb();
}

// ══════════════════════ KEYBOARD ══════════════════════
document.addEventListener('keydown', e => {
  const overlayOpen = document.getElementById('fs-overlay').classList.contains('open');
  if(e.key === 'Escape'){ closeFs(); return; }
  if(!overlayOpen) return;
  if(e.key === 'ArrowLeft'){ fsNav(-1); }
  if(e.key === 'ArrowRight'){ fsNav(1); }
});

// ══ PRE-MARKET BIAS-KONTEXT (via ?bias=bull|bear aus Gameplan-Szenario-Karte) ══
// Rein visuell: Header-Titel/Sub/Titelzeile + farbiger Akzent, damit bei zwei parallel
// offenen Guided-Session-Tabs (ein Tab pro Szenario) sofort erkennbar ist, welcher
// Tab zu welchem Pre-Market-Narrativ gehoert. Beeinflusst keine Filter-/Pool-Logik.
const SCN_BIAS_META = {
  bull: { emoji:'🟢', label:'BULLISH', color:'#00e5a0' },
  bear: { emoji:'🔴', label:'BEARISH', color:'#ff4d6a' }
};
function applyBiasContext(bias){
  const meta = SCN_BIAS_META[bias];
  if (!meta) return;
  document.title = 'Guided Session — ' + meta.label + ' · Futures Desk';
  const hdrEl = document.getElementById('hdr-bar');
  if (hdrEl) { hdrEl.style.borderTop = '3px solid ' + meta.color; hdrEl.style.boxShadow = 'inset 0 3px 0 ' + meta.color; }
  const titleEl = document.querySelector('.hdr-title');
  if (titleEl) titleEl.textContent = meta.emoji + ' GUIDED SESSION — ' + meta.label;
  const subEl = document.querySelector('.hdr-sub');
  if (subEl) subEl.textContent = 'Pre-Market-Szenario: ' + meta.label + ' · gefilterte Setups als visuelle Vorbereitung';
}

async function init(){
  // idb war vorher nie gesetzt (openIDB() wurde nie aufgerufen) -> idbGet() gab
  // immer sofort null zurueck -> alle per __idb__-Platzhalter ausgelagerten
  // Screenshots blieben unsichtbar. Fix: IDB-Verbindung zuerst herstellen.
  try{ idb = await openIDB(); }catch(e){ console.warn('IDB open failed', e); idb = null; }
  applyBiasContext(new URLSearchParams(location.search).get('bias'));
  loadTrades();
  loadTodayContext();
  renderFilterBar();
  initFilterBarCollapse();
  initHubQuote();
  renderStagedRefsBadge();
  // Auto-load today's saved WIP filters if any exist, else stay empty
  let gpData = {};
  try{ gpData = JSON.parse(localStorage.getItem('fd_gpdata') || '{}'); }catch(e){}
  const key = gpDateKey(new Date());
  const saved = (gpData[key] || {}).wipFilters || {};
  const hasSaved = Object.values(saved).some(a => Array.isArray(a) && a.length);
  if(hasSaved) loadTodayFilters();
  else renderWall();
}
init();

// ══════════════════════ CROSS-TAB SYNC ══════════════════════
// Futures Desk (index.html) und Guided Session laufen oft parallel im selben
// Browser — beide teilen sich fd_trades/fd_gpdata über den file://-Origin.
// Der native 'storage'-Event feuert hier, sobald die ANDERE Seite schreibt.
window.addEventListener('storage', (e) => {
  if(!e.key) return;
  if(e.key === 'fd_trades' && e.newValue){
    try{
      trades = JSON.parse(e.newValue);
      if(fsIdx >= 0) closeFs(); // Vollbild schließen, da Index sich verschieben kann
      renderWall();
      console.log('↺ Guided Session: fd_trades aus anderem Tab synchronisiert');
    }catch(err){ console.warn('Cross-tab trades sync failed:', err); }
  }
  if(e.key === 'fd_gpdata' && e.newValue){
    try{
      loadTodayContext();
      console.log('↺ Guided Session: fd_gpdata aus anderem Tab synchronisiert');
    }catch(err){ console.warn('Cross-tab gpdata sync failed:', err); }
  }
});
