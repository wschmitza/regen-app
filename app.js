import {
  fetchRadar, pointSeries, minuteSeries, analyze, intensity, insideGrid,
  buildImages, RAIN_MIN,
} from './radar.js';

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('rainradar.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rainradar.' + k, JSON.stringify(v)); } catch { /* privat-Modus */ } },
};

const REFRESH_MS = 5 * 60e3;
const ALERT_LEAD_MIN = 15;

const S = {
  loc: store.get('loc', null), // {lat, lon, name, gps}
  radar: null,
  points: [],
  analysis: null,
  loading: false,
  ctrl: null,
  lastLoad: 0,
};

// ---------------------------------------------------------------------------
// Formatierung
const fmtTime = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtDur = (m) => (m < 60 ? `${m} Min` : `${Math.floor(m / 60)} Std${m % 60 ? ` ${m % 60} Min` : ''}`);
const ADJ = { light: 'Leichter', moderate: 'Mäßiger', heavy: 'Starker', extreme: 'Heftiger', none: '' };
const mmhStr = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: v < 10 ? 1 : 0 });

function bigNumber(min) {
  if (min < 60) return `${min}<small>Min</small>`;
  const h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}<small>Std</small>`;
}

const TAGS = {
  dry: ['Schirm bleibt zu.', 'Raus mit dir.', 'Trockener wird’s nicht.', 'Wäsche kann raus.'],
  comingSoon: ['Beeil dich.', 'Jetzt oder nie.', 'Lauf, Forrest.'],
  comingLater: ['Noch Zeit für einen Kaffee.', 'Kein Stress. Noch.', 'Schirm schon mal einpacken.'],
  light: ['Nur Niesel. Stell dich nicht so an.', 'Kapuze reicht.', 'Frisur in Gefahr.'],
  moderate: ['Kapuze auf.', 'Schirm raus.', 'Das wird nass.'],
  heavy: ['Drinnen bleiben. Ernsthaft.', 'Schirm reicht nicht.', 'Land unter.'],
  long: ['Richtet sich häuslich ein.', 'Das wird heute nix mehr.', 'Couch-Wetter.'],
};
const pick = (arr) => arr[Math.floor(Date.now() / 3.6e6) % arr.length];

// ---------------------------------------------------------------------------
// Hero
function renderHero() {
  const a = S.analysis;
  const kicker = $('#kicker');
  const big = $('#big');
  const sub = $('#sub');
  const tag = $('#tag');
  big.classList.remove('word');
  let state = a?.kind ?? 'unknown';

  if (!a || a.kind === 'unknown') return;
  const lvl = intensity(a.peak ?? a.now ?? 0);
  if ((a.kind !== 'dry') && (lvl.key === 'heavy' || lvl.key === 'extreme')) state = 'heavy';

  if (a.kind === 'dry') {
    kicker.textContent = 'Die nächsten 2 Stunden';
    big.textContent = 'Trocken.';
    big.classList.add('word');
    sub.innerHTML = `Kein Tropfen bis mindestens <b>${fmtTime(a.horizon)}</b>.`;
    tag.textContent = pick(TAGS.dry);
  } else if (a.kind === 'coming') {
    kicker.textContent = `${ADJ[lvl.key]} Regen in`;
    big.innerHTML = bigNumber(a.startIn);
    sub.innerHTML = a.openEnd
      ? `Ab <b>${fmtTime(a.startTime)}</b> – und hält danach erst mal an.`
      : `Ab <b>${fmtTime(a.startTime)}</b> · etwa <b>${fmtDur(a.duration)}</b> lang.`;
    tag.textContent = state === 'heavy' ? pick(TAGS.heavy) : a.startIn <= 10 ? pick(TAGS.comingSoon) : pick(TAGS.comingLater);
  } else if (a.kind === 'raining') {
    const nowLvl = intensity(a.now);
    kicker.textContent = `${ADJ[nowLvl.key]} Regen – noch`;
    big.innerHTML = bigNumber(a.endIn);
    sub.innerHTML = `Gegen <b>${fmtTime(a.endTime)}</b> ist Schluss.`;
    tag.textContent = pick(TAGS[nowLvl.key === 'extreme' ? 'heavy' : nowLvl.key] || TAGS.moderate);
  } else if (a.kind === 'raining-long') {
    const nowLvl = intensity(a.now);
    kicker.textContent = `${ADJ[nowLvl.key]} Regen`;
    big.textContent = 'Dauer­regen.';
    big.classList.add('word');
    sub.innerHTML = `Kein Ende vor <b>${fmtTime(a.horizon)}</b> in Sicht.`;
    tag.textContent = pick(TAGS.long);
  }
  document.body.dataset.state = state;
}

function heroMessage(kicker, word, sub, state = 'error') {
  $('#kicker').textContent = kicker;
  const big = $('#big');
  big.textContent = word;
  big.classList.add('word');
  $('#sub').innerHTML = sub;
  $('#tag').textContent = '';
  document.body.dataset.state = state;
}

// ---------------------------------------------------------------------------
// Minuten-Chart
const COLORS = () => {
  const cs = getComputedStyle(document.documentElement);
  return {
    none: cs.getPropertyValue('--c-none').trim(),
    light: cs.getPropertyValue('--c-light').trim(),
    moderate: cs.getPropertyValue('--c-moderate').trim(),
    heavy: cs.getPropertyValue('--c-heavy').trim(),
    extreme: cs.getPropertyValue('--c-extreme').trim(),
  };
};

let chartMinutes = [];
function renderChart() {
  const el = $('#chart');
  const min = minuteSeries(S.points);
  chartMinutes = min;
  const W = el.clientWidth || 320;
  const H = el.clientHeight || 112;
  if (!min.length) { el.innerHTML = ''; $('#axis').innerHTML = ''; return; }
  const n = min.length;
  const step = W / n;
  const bw = Math.max(1, step * 0.62);
  const c = COLORS();
  const maxLog = Math.log1p(30);
  let bars = '';
  for (let i = 0; i < n; i++) {
    const v = min[i].mmh;
    const lvl = intensity(v);
    const x = i * step + (step - bw) / 2;
    if (v < RAIN_MIN) {
      bars += `<rect x="${x.toFixed(2)}" y="${H - 3}" width="${bw.toFixed(2)}" height="3" rx="1" fill="${c.none}"/>`;
    } else {
      const h = 8 + (H - 8) * Math.min(1, Math.log1p(v) / maxLog);
      bars += `<rect x="${x.toFixed(2)}" y="${(H - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="${Math.min(bw / 2, 3).toFixed(2)}" fill="${c[lvl.key]}"/>`;
    }
  }
  // Hilfslinien für leicht/mäßig/stark
  const gy = (v) => (H - (8 + (H - 8) * Math.min(1, Math.log1p(v) / maxLog))).toFixed(1);
  const guides = [2.5, 10]
    .map((v) => `<line x1="0" x2="${W}" y1="${gy(v)}" y2="${gy(v)}" stroke="${c.none}" stroke-dasharray="2 4"/>`)
    .join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${guides}${bars}<line class="cursor" id="cursor" x1="0" x2="0" y1="-6" y2="${H}"/></svg>`;

  // Achse: Jetzt + alle 30 Min
  let axis = `<span style="left:0">Jetzt</span>`;
  for (let m = 30; m < n - 8; m += 30) axis += `<span style="left:${(m * step).toFixed(1)}px">${fmtTime(min[m].t)}</span>`;
  axis += `<span style="left:100%">${fmtTime(min[n - 1].t)}</span>`;
  $('#axis').innerHTML = axis;
}

function setupChartScrub() {
  const el = $('#chart');
  const info = $('#scrubInfo');
  const move = (e) => {
    if (!chartMinutes.length) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(0.9999, Math.max(0, (e.clientX - r.left) / r.width));
    const i = Math.floor(f * chartMinutes.length);
    const m = chartMinutes[i];
    const cur = $('#cursor');
    if (cur) {
      const x = ((i + 0.5) * r.width) / chartMinutes.length;
      cur.setAttribute('x1', x);
      cur.setAttribute('x2', x);
    }
    el.classList.add('scrubbing');
    const lvl = intensity(m.mmh);
    info.textContent = m.mmh < RAIN_MIN ? `${fmtTime(m.t)} · trocken` : `${fmtTime(m.t)} · ${lvl.label} · ${mmhStr(m.mmh)} mm/h`;
  };
  const end = () => { el.classList.remove('scrubbing'); info.textContent = ''; };
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); move(e); });
  el.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || el.hasPointerCapture(e.pointerId)) move(e); });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') end(); });
}

function renderUpdated() {
  if (!S.radar) return;
  const lastObs = [...S.radar.frames].reverse().find((f) => f.observed);
  $('#updated').textContent = `Radar ${lastObs ? fmtTime(lastObs.time) : '–'} · DWD`;
}

function renderNow() {
  if (!S.points.length) return;
  S.analysis = analyze(minuteSeries(S.points));
  renderHero();
  renderChart();
  renderUpdated();
  checkAlert();
}

// ---------------------------------------------------------------------------
// Laden
async function load({ quiet = false } = {}) {
  if (!S.loc) return;
  const { lat, lon } = S.loc;
  if (!insideGrid(lat, lon)) {
    heroMessage('Hmm.', 'Zu weit weg.', 'Das DWD-Radar deckt Deutschland und die Nachbarregionen ab – dein Ort liegt außerhalb.');
    return;
  }
  S.ctrl?.abort();
  const ctrl = (S.ctrl = new AbortController());
  S.loading = true;
  $('#refreshBtn').classList.add('loading');
  try {
    const [radar] = await Promise.all([
      fetchRadar(lat, lon, { signal: ctrl.signal }),
      loadTemp(lat, lon, ctrl.signal),
    ]);
    if (ctrl.signal.aborted) return;
    S.radar = radar;
    S.points = pointSeries(radar);
    S.lastLoad = Date.now();
    renderNow();
    if (map && (!mapData || mapData.home)) setMapData(radar, true);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    if (!S.points.length) {
      heroMessage('Funkloch?', 'Kein Radar.', 'Die Radardaten kommen gerade nicht durch. Tipp unten auf die Uhrzeit, um es nochmal zu versuchen.');
    } else if (!quiet) toast('Aktualisieren hat nicht geklappt.');
  } finally {
    S.loading = false;
    $('#refreshBtn').classList.remove('loading');
  }
}

async function loadTemp(lat, lon, signal) {
  try {
    const r = await fetch(`https://api.brightsky.dev/current_weather?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, { signal });
    if (!r.ok) return;
    const j = await r.json();
    const t = j.weather?.temperature;
    $('#temp').textContent = typeof t === 'number' ? `${Math.round(t)}°` : '';
  } catch { /* Temperatur ist Beiwerk */ }
}

// ---------------------------------------------------------------------------
// Standort
function setLoc(loc) {
  S.loc = loc;
  store.set('loc', loc);
  $('#locName').textContent = loc.name || 'Mein Standort';
  S.points = [];
  if (map) { meMarker.setLatLng([loc.lat, loc.lon]); map.setView([loc.lat, loc.lon], Math.max(map.getZoom(), 8)); }
  load();
}

async function reverseName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=de`);
    const j = await r.json();
    return j.city || j.locality || j.principalSubdivision || '';
  } catch { return ''; }
}

function locate({ interactive = false } = {}) {
  if (!('geolocation' in navigator)) { if (interactive) toast('Dein Browser kann keinen Standort.'); return; }
  navigator.geolocation.getCurrentPosition(
    async (p) => {
      const lat = +p.coords.latitude.toFixed(4);
      const lon = +p.coords.longitude.toFixed(4);
      const prev = S.loc;
      const moved = !prev || !prev.gps || Math.hypot(prev.lat - lat, prev.lon - lon) > 0.01;
      if (moved) setLoc({ lat, lon, name: prev?.gps ? prev.name : 'Mein Standort', gps: true });
      const name = await reverseName(lat, lon);
      if (name && S.loc?.gps) { S.loc.name = name; store.set('loc', S.loc); $('#locName').textContent = name; }
    },
    () => {
      if (interactive || !S.loc) {
        toast('Standort nicht freigegeben – such dir einen Ort aus.');
        openSheet();
      }
    },
    { enableHighAccuracy: false, maximumAge: 5 * 60e3, timeout: 12e3 }
  );
}

function openSheet() {
  const d = $('#locSheet');
  if (!d.open) d.showModal();
}

function setupSheet() {
  $('#locBtn').addEventListener('click', openSheet);
  $('#useGps').addEventListener('click', () => { $('#locSheet').close(); locate({ interactive: true }); });
  let t;
  let ctrl;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    if (q.length < 2) { $('#results').innerHTML = ''; return; }
    t = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=de&format=json`, { signal: ctrl.signal });
        const j = await r.json();
        const list = j.results || [];
        $('#results').innerHTML = list.length
          ? list.map((p, i) => `<li><button type="button" data-i="${i}">${esc(p.name)}<small>${esc([p.admin1, p.country_code].filter(Boolean).join(', '))}</small></button></li>`).join('')
          : '<li class="meta" style="text-align:left">Nix gefunden.</li>';
        $('#results').onclick = (ev) => {
          const b = ev.target.closest('button[data-i]');
          if (!b) return;
          const p = list[+b.dataset.i];
          $('#locSheet').close();
          $('#search').value = '';
          $('#results').innerHTML = '';
          setLoc({ lat: p.latitude, lon: p.longitude, name: p.name, gps: false });
        };
      } catch { /* abgebrochen */ }
    }, 280);
  });
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------------------
// Radar-Karte
let map = null;
let meMarker = null;
let mapData = null; // { radar, home, overlays, frames, nowIndex }
let frameIndex = 0;
let playTimer = null;
let mapBuildId = 0;

function initMap() {
  const { lat, lon } = S.loc || { lat: 51.16, lon: 10.45 };
  map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 5, maxZoom: 12 }).setView([lat, lon], 8);
  map.createPane('radar').style.zIndex = 450;
  // OpenStreetMap-Standardkacheln (ohne API-Schlüssel). Im Dunkelmodus per CSS-Filter abgedunkelt.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Radar: <a href="https://www.dwd.de/">DWD</a> via <a href="https://brightsky.dev/">Bright Sky</a>',
  }).addTo(map);
  map.attributionControl.setPrefix(false);
  meMarker = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18] }), interactive: false, keyboard: false }).addTo(map);

  let panTimer;
  map.on('moveend', () => {
    clearTimeout(panTimer);
    panTimer = setTimeout(maybeRefetchForMap, 500);
  });
  if (S.radar) setMapData(S.radar, true);
}

async function maybeRefetchForMap() {
  if (!mapData) return;
  const c = map.getCenter();
  const d = map.distance(c, [mapData.radar.center.lat, mapData.radar.center.lon]);
  if (d < 140e3 || !insideGrid(c.lat, c.lng)) return;
  try {
    const r = await fetchRadar(c.lat, c.lng);
    setMapData(r, false);
  } catch (e) { console.warn(e); }
}

// Radar-Zeitleiste: letzte Stunde + eine Stunde Vorhersage.
const MAP_PAST_MS = 62 * 60e3;
const MAP_FUTURE_MS = 62 * 60e3;

async function setMapData(fullRadar, home) {
  const id = ++mapBuildId;
  const t0 = Date.now();
  const radar = { ...fullRadar, frames: fullRadar.frames.filter((f) => f.time >= t0 - MAP_PAST_MS && f.time <= t0 + MAP_FUTURE_MS) };
  if (!radar.frames.length) return;
  const { bounds, urls } = await buildImages(radar);
  if (id !== mapBuildId) { urls.forEach(URL.revokeObjectURL); return; }
  // Alle Bilder vorladen, bevor wir umschalten – kein Flackern, keine Lücken.
  await Promise.all(urls.map((u) => { const im = new Image(); im.src = u; return im.decode().catch(() => {}); }));
  if (id !== mapBuildId) { urls.forEach(URL.revokeObjectURL); return; }

  const wasPlaying = !!playTimer;
  const prevRel = mapData ? frameIndex - mapData.nowIndex : 0;
  if (mapData) {
    mapData.overlays.forEach((o) => map.removeLayer(o));
    mapData.urls.forEach(URL.revokeObjectURL);
  }
  const overlays = urls.map((u) => L.imageOverlay(u, bounds, { pane: 'radar', opacity: 0, interactive: false, className: 'radar-layer' }).addTo(map));
  const frames = radar.frames.map((f) => ({ time: f.time, observed: f.observed }));
  const now = Date.now();
  let nowIndex = 0;
  frames.forEach((f, i) => { if (f.time <= now) nowIndex = i; });
  mapData = { radar: fullRadar, home, overlays, urls, frames, nowIndex };

  const scrub = $('#scrub');
  scrub.max = String(frames.length - 1);
  const firstFc = frames.findIndex((f) => !f.observed);
  const pct = (i) => (frames.length > 1 ? (i / (frames.length - 1)) * 100 : 0);
  $('#future').style.left = firstFc < 0 ? '100%' : `${pct(firstFc - 0.5)}%`;
  $('#nowmark').style.left = `calc(${pct(nowIndex)}% - 1px)`;
  const labels = document.querySelector('.scrub-labels');
  labels.innerHTML = `<span>${fmtTime(frames[0].time)}</span><span class="now-label" style="left:${pct(nowIndex)}%">Jetzt</span><span>${fmtTime(frames[frames.length - 1].time)}</span>`;

  showFrame(Math.max(0, Math.min(frames.length - 1, nowIndex + (wasPlaying ? 0 : prevRel))));
}

function showFrame(i) {
  if (!mapData) return;
  const { overlays, frames } = mapData;
  overlays[frameIndex]?.setOpacity(0);
  frameIndex = i;
  overlays[i].setOpacity(1);
  $('#scrub').value = String(i);
  const f = frames[i];
  const rel = Math.round((f.time - Date.now()) / 60e3);
  const box = $('#radarTime');
  box.querySelector('b').textContent = fmtTime(f.time);
  let label;
  if (i === mapData.nowIndex) label = 'Jetzt';
  else if (rel < 0) label = `vor ${fmtDur(-rel)}`;
  else label = `Vorhersage · in ${fmtDur(rel)}`;
  box.querySelector('span').textContent = label;
  box.classList.toggle('is-fc', !f.observed);
}

function play() {
  if (!mapData) return;
  $('#play').classList.add('playing');
  $('#play').setAttribute('aria-label', 'Pause');
  let hold = 0;
  if (frameIndex >= mapData.frames.length - 1) showFrame(0);
  playTimer = setInterval(() => {
    const last = mapData.frames.length - 1;
    if (frameIndex >= last) {
      if (++hold < 4) return;
      hold = 0;
      showFrame(0);
    } else showFrame(frameIndex + 1);
  }, 380);
}
function pause() {
  clearInterval(playTimer);
  playTimer = null;
  $('#play').classList.remove('playing');
  $('#play').setAttribute('aria-label', 'Abspielen');
}

function setupRadarControls() {
  $('#play').addEventListener('click', () => (playTimer ? pause() : play()));
  $('#scrub').addEventListener('input', (e) => { pause(); showFrame(+e.target.value); });
  $('#recenter').addEventListener('click', () => {
    if (!S.loc) return;
    map.setView([S.loc.lat, S.loc.lon], 9);
    if (mapData && !mapData.home && S.radar) setMapData(S.radar, true);
  });
}

// ---------------------------------------------------------------------------
// Tabs
function showView(name) {
  document.querySelectorAll('.tabs button').forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('.tabs').classList.toggle('second', name === 'radar');
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.body.classList.toggle('on-radar', name === 'radar');
  if (name === 'radar') {
    if (typeof L === 'undefined') { toast('Kartenbibliothek konnte nicht geladen werden – Verbindung prüfen.'); return; }
    if (!map) initMap();
    else map.invalidateSize();
    if (mapData) showFrame(mapData.nowIndex);
  } else {
    pause();
    renderChart();
  }
}

// ---------------------------------------------------------------------------
// Regen-Alarm (lokale Mitteilung, solange die App aktiv ist)
function alertSupported() { return 'Notification' in window && 'serviceWorker' in navigator; }
function renderAlertBtn() {
  const on = store.get('alert', false) && alertSupported() && Notification.permission === 'granted';
  $('#alertBtn').setAttribute('aria-pressed', String(on));
  $('#alertLabel').textContent = on ? 'Regen-Alarm an' : 'Regen-Alarm aus';
}
async function toggleAlert() {
  if (!alertSupported()) {
    toast('Auf dem iPhone: erst „Zum Home-Bildschirm“ hinzufügen, dann klappt’s.');
    return;
  }
  if (store.get('alert', false) && Notification.permission === 'granted') {
    store.set('alert', false);
  } else {
    const p = await Notification.requestPermission();
    if (p !== 'granted') { toast('Mitteilungen sind blockiert.'); store.set('alert', false); renderAlertBtn(); return; }
    store.set('alert', true);
    toast(`Ich melde mich ${ALERT_LEAD_MIN} Min vor dem Regen.`);
  }
  renderAlertBtn();
  checkAlert();
}
async function checkAlert() {
  const a = S.analysis;
  if (!a || a.kind !== 'coming' || a.startIn > ALERT_LEAD_MIN) return;
  if (!store.get('alert', false) || !alertSupported() || Notification.permission !== 'granted') return;
  const key = `${S.loc?.lat},${S.loc?.lon},${Math.round(a.startTime / 15 / 60e3)}`;
  if (store.get('alertKey', '') === key) return;
  store.set('alertKey', key);
  const lvl = intensity(a.peak);
  const reg = await navigator.serviceWorker.ready;
  reg.showNotification(`${ADJ[lvl.key]} Regen in ${a.startIn} Min`, {
    body: `${S.loc?.name ?? ''}: ab ${fmtTime(a.startTime)}${a.openEnd ? '' : `, etwa ${fmtDur(a.duration)}`}.`,
    tag: 'rain',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
  });
}

// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function makeDrops() {
  const box = document.querySelector('.drops');
  let html = '';
  for (let i = 0; i < 36; i++) {
    const left = Math.random() * 100;
    const dur = 0.7 + Math.random() * 0.9;
    const delay = -Math.random() * 2;
    const op = 0.25 + Math.random() * 0.5;
    html += `<i style="left:${left}%;animation-duration:${dur}s;animation-delay:${delay}s;opacity:${op}"></i>`;
  }
  box.innerHTML = html;
}

function init() {
  makeDrops();
  setupChartScrub();
  setupSheet();
  setupRadarControls();
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#alertBtn').addEventListener('click', toggleAlert);
  $('#refreshBtn').addEventListener('click', () => load());
  renderAlertBtn();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (S.loc) {
    $('#locName').textContent = S.loc.name || 'Mein Standort';
    load();
  }
  if (!S.loc || S.loc.gps) locate();

  // Countdown live halten, Daten regelmäßig erneuern.
  setInterval(() => { if (!document.hidden) renderNow(); }, 30e3);
  setInterval(() => { if (!document.hidden) load({ quiet: true }); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pause(); return; }
    if (Date.now() - S.lastLoad > 2 * 60e3) { if (S.loc?.gps) locate(); load({ quiet: true }); }
    else renderNow();
  });
  let rz;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(renderChart, 120); });
}

init();
