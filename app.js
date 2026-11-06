import {
  fetchRadar, pointSeries, minuteSeries, analyze, intensity, insideGrid,
  buildImages, RAIN_MIN,
} from './radar.js';
import { spruch } from './sprueche.js';

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('rainradar.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rainradar.' + k, JSON.stringify(v)); } catch { /* privat-Modus */ } },
};

function roundGpsLoc(loc) {
  if (!loc || !loc.gps) return loc;
  return { ...loc, lat: Math.round(loc.lat * 100) / 100, lon: Math.round(loc.lon * 100) / 100 };
}

const REFRESH_MS = 5 * 60e3;
const ALERT_LEAD_MIN = 15;

const S = {
  loc: roundGpsLoc(store.get('loc', null)), // {lat, lon, name, gps}
  radar: null,
  points: [],
  analysis: null,
  loading: false,
  ctrl: null,
  lastLoad: 0,
  temp: null, // °C, für temperaturabhängige Sprüche
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

const tagFor = (kategorie) => spruch(kategorie, { temp: S.temp });

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
    tag.textContent = tagFor('dry');
  } else if (a.kind === 'coming') {
    kicker.textContent = `${ADJ[lvl.key]} Regen in`;
    big.innerHTML = bigNumber(a.startIn);
    sub.innerHTML = a.openEnd
      ? `Ab <b>${fmtTime(a.startTime)}</b> – und hält danach erst mal an.`
      : `Ab <b>${fmtTime(a.startTime)}</b> · etwa <b>${fmtDur(a.duration)}</b> lang.`;
    tag.textContent = tagFor(state === 'heavy' ? 'heavyComing' : a.startIn <= 10 ? 'comingSoon' : 'comingLater');
  } else if (a.kind === 'raining') {
    const nowLvl = intensity(a.now);
    kicker.textContent = `${ADJ[nowLvl.key]} Regen – noch`;
    big.innerHTML = bigNumber(a.endIn);
    sub.innerHTML = `Gegen <b>${fmtTime(a.endTime)}</b> ist Schluss.`;
    tag.textContent = tagFor(['light', 'moderate', 'heavy', 'extreme'].includes(nowLvl.key) ? nowLvl.key : 'moderate');
  } else if (a.kind === 'raining-long') {
    const nowLvl = intensity(a.now);
    kicker.textContent = `${ADJ[nowLvl.key]} Regen`;
    big.textContent = 'Dauer­regen.';
    big.classList.add('word');
    sub.innerHTML = `Kein Ende vor <b>${fmtTime(a.horizon)}</b> in Sicht.`;
    tag.textContent = tagFor('long');
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
let chartGeom = null; // { W, H, xs, ys } für den Finger-Cursor

// Monotone kubische Interpolation (Fritsch–Carlson): glatte Kurve ohne Überschwinger unter die Nulllinie.
function smoothPath(xs, ys) {
  const n = xs.length;
  if (n < 2) return '';
  const d = [];
  const m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let p = `M${xs[0].toFixed(2)},${ys[0].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    p += `C${(xs[i] + dx).toFixed(2)},${(ys[i] + m[i] * dx).toFixed(2)} ${(xs[i + 1] - dx).toFixed(2)},${(ys[i + 1] - m[i + 1] * dx).toFixed(2)} ${xs[i + 1].toFixed(2)},${ys[i + 1].toFixed(2)}`;
  }
  return p;
}

function renderChart() {
  const el = $('#chart');
  const min = minuteSeries(S.points);
  chartMinutes = min;
  const W = el.clientWidth || 320;
  const H = el.clientHeight || 112;
  if (!min.length) { el.innerHTML = ''; $('#axis').innerHTML = ''; chartGeom = null; return; }
  const n = min.length;
  const c = COLORS();
  const maxLog = Math.log1p(30);
  const BASE = H - 2; // Nulllinie
  const yOf = (v) => (v < RAIN_MIN ? BASE : BASE - (6 + (BASE - 10) * Math.min(1, Math.log1p(v) / maxLog)));
  const xs = min.map((_, i) => (n > 1 ? (i / (n - 1)) * W : 0));
  const ys = min.map((m) => yOf(m.mmh));
  chartGeom = { W, H, xs, ys };

  // Farbverlauf nach Höhe: die Kurve färbt sich je nach Intensität (trocken → leicht → mäßig → stark → heftig).
  const off = (y) => Math.max(0, Math.min(1, (H - y) / H)).toFixed(3);
  const edge = (v) => yOf(v);
  const stops = [
    [off(BASE + 0.5), c.none], [off(BASE - 2), c.none],
    [off(BASE - 4), c.light], [off(edge(2.5) + 2), c.light],
    [off(edge(2.5) - 2), c.moderate], [off(edge(10) + 2), c.moderate],
    [off(edge(10) - 2), c.heavy], [off(edge(25) + 2), c.heavy],
    [off(edge(25) - 2), c.extreme], ['1', c.extreme],
  ].map(([o, col]) => `<stop offset="${o}" stop-color="${col}"/>`).join('');
  const line = smoothPath(xs, ys);
  const area = `${line}L${W},${H}L0,${H}Z`;
  const guides = [2.5, 10]
    .map((v) => `<line x1="0" x2="${W}" y1="${yOf(v).toFixed(1)}" y2="${yOf(v).toFixed(1)}" stroke="${c.none}" stroke-dasharray="2 4"/>`)
    .join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="rg" gradientUnits="userSpaceOnUse" x1="0" y1="${H}" x2="0" y2="0">${stops}</linearGradient>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient>
      <mask id="fm"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>
    </defs>
    ${guides}
    <path d="${area}" fill="url(#rg)" mask="url(#fm)"/>
    <path d="${line}" fill="none" stroke="url(#rg)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <line class="cursor" id="cursor" x1="0" x2="0" y1="-6" y2="${H}"/>
    <circle class="cursor-dot" id="cursorDot" cx="0" cy="${BASE}" r="5"/>
  </svg>`;

  // Achse: Jetzt + alle 30 Min
  let axis = `<span style="left:0">Jetzt</span>`;
  for (let m = 30; m < n - 8; m += 30) axis += `<span style="left:${xs[m].toFixed(1)}px">${fmtTime(min[m].t)}</span>`;
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
    const i = Math.round(f * (chartMinutes.length - 1));
    const m = chartMinutes[i];
    const cur = $('#cursor');
    const dot = $('#cursorDot');
    if (cur && chartGeom) {
      const x = chartGeom.xs[i];
      cur.setAttribute('x1', x);
      cur.setAttribute('x2', x);
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', chartGeom.ys[i]);
      dot.setAttribute('fill', COLORS()[intensity(m.mmh).key]);
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
    S.temp = typeof t === 'number' ? t : null;
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
  pushSync().catch((e) => console.warn(e));
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
      // Datensparsam: GPS-Position auf 0,01° runden (≈ 1,1 km Nord-Süd, ≈ 0,7 km Ost-West).
      // Das Radar rechnet ohnehin mit 1-km-Zellen und mittelt über 3×3 km – die Prognose bleibt gleich.
      // So verlässt nie die genaue Position das Gerät (Bright Sky, BigDataCloud, Push-Server).
      const lat = Math.round(p.coords.latitude * 100) / 100;
      const lon = Math.round(p.coords.longitude * 100) / 100;
      const prev = S.loc;
      const moved = !prev || !prev.gps || Math.hypot(prev.lat - lat, prev.lon - lon) > 0.005;
      if (moved) setLoc({ lat, lon, name: prev?.gps ? prev.name : 'Mein Standort', gps: true });
      const name = await reverseName(lat, lon);
      if (name && S.loc?.gps) {
        S.loc.name = name;
        store.set('loc', S.loc);
        $('#locName').textContent = name;
        if (moved) { store.set('pushSig', ''); pushSync().catch((e) => console.warn(e)); }
      }
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
// Regen-Alarm
// Mit PUSH_URL: echter Hintergrund-Push über den Cloudflare Worker (push-worker/).
// Ohne PUSH_URL: lokale Mitteilung, nur solange die App offen ist.
const PUSH_URL = 'https://rain-radar-push.wschmitza.workers.dev';

function alertSupported() { return 'Notification' in window && 'serviceWorker' in navigator; }
const pushMode = () => !!PUSH_URL && 'PushManager' in window;
const alertOn = () => store.get('alert', false) && alertSupported() && Notification.permission === 'granted';

function renderAlertBtn() {
  const on = alertOn();
  $('#alertBtn').setAttribute('aria-pressed', String(on));
  $('#alertLabel').textContent = on ? 'Regen-Alarm an' : 'Regen-Alarm aus';
}

function b64uToBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function pushPost(path, body) {
  const r = await fetch(PUSH_URL.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Push-Server ${r.status}`);
  return r.json();
}

/** Meldet das iPhone (mit aktuellem Ort) beim Push-Server an bzw. aktualisiert den Ort. */
async function pushSync({ test = false } = {}) {
  if (!pushMode() || !alertOn() || !S.loc) return;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const r = await fetch(PUSH_URL.replace(/\/$/, '') + '/vapid');
    const { publicKey } = await r.json();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
  }
  const { lat, lon, name } = S.loc;
  const sig = `${sub.endpoint}|${lat}|${lon}`;
  if (!test && store.get('pushSig', '') === sig) return; // nichts geändert
  await pushPost('/subscribe', { subscription: sub.toJSON(), lat, lon, name, lead: ALERT_LEAD_MIN });
  store.set('pushSig', sig);
  if (test) await pushPost('/test', { endpoint: sub.endpoint });
}

async function pushOff() {
  if (!pushMode()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await pushPost('/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } finally {
    store.set('pushSig', '');
  }
}

async function toggleAlert() {
  if (!alertSupported() || (PUSH_URL && !('PushManager' in window))) {
    toast('Auf dem iPhone: erst „Zum Home-Bildschirm“ hinzufügen, dann klappt’s.');
    return;
  }
  if (alertOn()) {
    store.set('alert', false);
    renderAlertBtn();
    pushOff().catch(() => {});
    toast('Regen-Alarm aus.');
    return;
  }
  const p = await Notification.requestPermission();
  if (p !== 'granted') { toast('Mitteilungen sind blockiert – in den iPhone-Einstellungen erlauben.'); store.set('alert', false); renderAlertBtn(); return; }
  store.set('alert', true);
  renderAlertBtn();
  if (pushMode()) {
    try {
      await pushSync({ test: true });
      toast('Test-Nachricht ist unterwegs – ab jetzt warne ich auch bei geschlossener App.');
    } catch (e) {
      console.error(e);
      toast('Push-Server nicht erreichbar – versuch’s gleich nochmal.');
      store.set('alert', false);
      renderAlertBtn();
    }
  } else {
    toast(`Ich melde mich ${ALERT_LEAD_MIN} Min vor dem Regen.`);
    checkAlert();
  }
}

/** Lokale Mitteilung – nur ohne Push-Server (sonst gäbe es doppelte Nachrichten). */
async function checkAlert() {
  if (pushMode()) return;
  const a = S.analysis;
  if (!a || a.kind !== 'coming' || a.startIn > ALERT_LEAD_MIN) return;
  if (!alertOn()) return;
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

// ---------------------------------------------------------------------------
// Darstellung: Automatisch (System) · Hell · Dunkel
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = store.get('theme', 'auto');
  const scheme = pref === 'auto' ? (darkMq.matches ? 'dark' : 'light') : pref;
  const changed = document.documentElement.dataset.scheme !== scheme;
  document.documentElement.dataset.scheme = scheme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.removeAttribute('media'); m.content = bg; });
  document.querySelectorAll('#themeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === pref)));
  if (changed) renderChart();
}
function setupTheme() {
  applyTheme();
  darkMq.addEventListener?.('change', applyTheme);
  $('#themeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme]');
    if (!b) return;
    store.set('theme', b.dataset.theme);
    applyTheme();
  });
}

function init() {
  setupTheme();
  makeDrops();
  setupChartScrub();
  setupSheet();
  setupRadarControls();
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#alertBtn').addEventListener('click', toggleAlert);
  $('#refreshBtn').addEventListener('click', () => load());
  renderAlertBtn();
  pushSync().catch((e) => console.warn(e));

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
