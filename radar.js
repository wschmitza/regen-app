// Datenlogik: DWD-Radar (RV-Produkt) via Bright Sky laden, dekodieren,
// an einem Punkt auswerten und für die Karte nach Web-Mercator umprojizieren.

const API = 'https://api.brightsky.dev/radar';

// --- Polarstereographische Projektion des DWD-Rasters -----------------------
// +proj=stere +lat_0=90 +lat_ts=60 +lon_0=10 +a=6378137 +b=6356752.3142451802
// +x_0=543196.83521776402 +y_0=3622588.8619310018
// Pixelzentren liegen bei x = 1000·Spalte, y = -1000·Zeile (Raster 1100 × 1200).
const A = 6378137;
const B = 6356752.3142451802;
const E = Math.sqrt(1 - (B * B) / (A * A));
const LAT_TS = (60 * Math.PI) / 180;
const LON_0 = (10 * Math.PI) / 180;
const X_0 = 543196.83521776402;
const Y_0 = 3622588.8619310018;
const tFn = (p) =>
  Math.tan(Math.PI / 4 - p / 2) /
  Math.pow((1 - E * Math.sin(p)) / (1 + E * Math.sin(p)), E / 2);
const M_C = Math.cos(LAT_TS) / Math.sqrt(1 - E * E * Math.sin(LAT_TS) ** 2);
const T_C = tFn(LAT_TS);
export const GRID_W = 1100;
export const GRID_H = 1200;

/** lat/lon → Rasterposition (Spalte, Zeile) im Gesamtraster, fraktional. */
export function toGrid(lat, lon) {
  const p = (lat * Math.PI) / 180;
  const l = (lon * Math.PI) / 180;
  const rho = (A * M_C * tFn(p)) / T_C;
  const x = rho * Math.sin(l - LON_0) + X_0;
  const y = -rho * Math.cos(l - LON_0) + Y_0;
  return { col: x / 1000, row: -y / 1000 };
}

export function insideGrid(lat, lon) {
  const { col, row } = toGrid(lat, lon);
  return col >= 2 && col <= GRID_W - 3 && row >= 2 && row <= GRID_H - 3;
}

// --- Laden & Dekodieren ------------------------------------------------------
async function inflate(b64) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint16Array(await new Response(stream).arrayBuffer());
}

/**
 * Holt 1 Std. Vergangenheit + bis zu 2 Std. Vorhersage (5-Min-Schritte).
 * Rückgabe: { frames:[{time, observed, data}], bbox, pos, center }
 */
export async function fetchRadar(lat, lon, { distance = 200000, signal } = {}) {
  const now = Date.now();
  const params = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
    distance: String(distance),
    date: new Date(now - 65 * 60e3).toISOString(),
    last_date: new Date(now + 130 * 60e3).toISOString(),
    format: 'compressed',
  });
  const res = await fetch(`${API}?${params}`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`Radar-Server antwortet mit ${res.status}`);
  const json = await res.json();
  if (!json.radar?.length) throw new Error('Keine Radardaten erhalten');

  const [top, left, bottom, right] = json.bbox;
  const W = right - left + 1;
  const H = bottom - top + 1;
  const frames = await Promise.all(
    json.radar.map(async (f) => {
      const data = await inflate(f.precipitation_5);
      const srcTime = Date.parse(String(f.source).split('::').pop());
      const time = Date.parse(f.timestamp);
      return { time, observed: srcTime === time, data };
    })
  );
  frames.sort((a, b) => a.time - b.time);
  for (const f of frames) {
    if (f.data.length !== W * H) throw new Error('Radardaten unvollständig');
  }
  return {
    frames,
    bbox: { top, left, bottom, right, W, H },
    pos: json.latlon_position, // fraktional relativ zur bbox
    center: { lat, lon },
    fetchedAt: now,
  };
}

// --- Punktauswertung ---------------------------------------------------------
// Rohwert = 0,01 mm / 5 min  →  mm/h = Rohwert · 0,12
const RAW_TO_MMH = 0.12;

function sampleAt(frame, bbox, x, y) {
  const cx = Math.round(x);
  const cy = Math.round(y);
  const { W, H } = bbox;
  let sum = 0;
  let n = 0;
  let center = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = cx + dx;
      const yy = cy + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const v = frame.data[yy * W + xx];
      if (dx === 0 && dy === 0) center = v;
      sum += v;
      n++;
    }
  }
  // Mittel über 3×3 km glättet Radarrauschen, das Zentrum zählt aber mindestens voll.
  return Math.max(center, n ? sum / n : 0) * RAW_TO_MMH;
}

/** Zeitreihe am Standort: [{time, mmh, observed}] in 5-Min-Schritten. */
export function pointSeries(radar) {
  const { x, y } = radar.pos;
  return radar.frames.map((f) => ({
    time: f.time,
    observed: f.observed,
    mmh: sampleAt(f, radar.bbox, x, y),
  }));
}

/** Auf Minuten interpoliert, ab der aktuellen Minute bis Vorhersageende. */
export function minuteSeries(points, now = Date.now()) {
  const out = [];
  if (points.length < 2) return out;
  const start = Math.floor(now / 60e3) * 60e3;
  const last = points[points.length - 1].time;
  let j = 0;
  for (let t = start; t <= last; t += 60e3) {
    while (j < points.length - 2 && points[j + 1].time < t) j++;
    const a = points[j];
    const b = points[j + 1];
    let mmh;
    if (t <= a.time) mmh = a.mmh;
    else if (t >= b.time) mmh = b.mmh;
    else mmh = a.mmh + ((b.mmh - a.mmh) * (t - a.time)) / (b.time - a.time);
    out.push({ t, mmh });
  }
  return out;
}

// --- Bewertung ---------------------------------------------------------------
export const RAIN_MIN = 0.1; // mm/h – darunter gilt es als trocken

export function intensity(mmh) {
  if (mmh < RAIN_MIN) return { key: 'none', label: 'trocken' };
  if (mmh < 2.5) return { key: 'light', label: 'leicht' };
  if (mmh < 10) return { key: 'moderate', label: 'mäßig' };
  if (mmh < 25) return { key: 'heavy', label: 'stark' };
  return { key: 'extreme', label: 'heftig' };
}

// Ende eines Regenereignisses: erste Minute, ab der es mind. 5 Min trocken bleibt.
function findEnd(min, from) {
  for (let i = from; i < min.length; i++) {
    if (min[i].mmh >= RAIN_MIN) continue;
    let dry = true;
    for (let k = i; k < Math.min(i + 5, min.length); k++) {
      if (min[k].mmh >= RAIN_MIN) { dry = false; break; }
    }
    if (dry) return i;
  }
  return -1;
}

function peak(min, a, b) {
  let p = 0;
  for (let i = a; i < b; i++) p = Math.max(p, min[i].mmh);
  return p;
}

/**
 * kind: 'dry' | 'coming' | 'raining' | 'raining-long'
 */
export function analyze(min) {
  if (!min.length) return { kind: 'unknown' };
  const horizon = min[min.length - 1].t;
  if (min[0].mmh >= RAIN_MIN) {
    const end = findEnd(min, 1);
    if (end < 0) {
      return { kind: 'raining-long', now: min[0].mmh, peak: peak(min, 0, min.length), horizon };
    }
    return { kind: 'raining', now: min[0].mmh, peak: peak(min, 0, end), endIn: end, endTime: min[end].t, horizon };
  }
  const start = min.findIndex((m) => m.mmh >= RAIN_MIN);
  if (start < 0) return { kind: 'dry', horizon };
  const end = findEnd(min, start + 1);
  const stop = end < 0 ? min.length : end;
  return {
    kind: 'coming',
    startIn: start,
    startTime: min[start].t,
    duration: stop - start,
    openEnd: end < 0,
    peak: peak(min, start, stop),
    horizon,
  };
}

// --- Kartenbilder ------------------------------------------------------------
// Farbskala (mm/h → RGBA). Bewusst kräftig, damit es auf dunkler wie heller Karte trägt.
const STOPS = [
  [0.1, [111, 227, 255, 120]],
  [1, [64, 186, 255, 175]],
  [2.5, [59, 130, 255, 210]],
  [10, [124, 77, 255, 225]],
  [25, [214, 51, 214, 235]],
  [50, [255, 61, 127, 245]],
];

function colorFor(mmh) {
  if (mmh < STOPS[0][0]) return 0;
  let c = STOPS[STOPS.length - 1][1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [a, ca] = STOPS[i];
    const [b, cb] = STOPS[i + 1];
    if (mmh < b) {
      const k = (Math.log(mmh) - Math.log(a)) / (Math.log(b) - Math.log(a));
      c = ca.map((v, j) => Math.round(v + (cb[j] - v) * k));
      break;
    }
  }
  // ImageData ist RGBA in Speicherreihenfolge → little-endian Uint32 = ABGR
  return ((c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
}

let LUT = null;
function lut() {
  if (LUT) return LUT;
  LUT = new Uint32Array(4096);
  for (let v = 0; v < LUT.length; v++) LUT[v] = colorFor(v * RAW_TO_MMH);
  return LUT;
}

/**
 * Projiziert das polarstereographische Teilraster exakt in ein
 * Mercator-achsparalleles Bild. Rückgabe: { bounds:[[s,w],[n,e]], frames:[blobURL] }
 */
export async function buildImages(radar, outWidth = 640) {
  const { top, left, W, H } = radar.bbox;
  // Eckpunkte (Außenkanten) über die inverse Lage: wir tasten den Rand ab.
  const inv = invGrid;
  const edges = [];
  for (let i = 0; i <= 20; i++) {
    const f = i / 20;
    edges.push(inv(left - 0.5 + f * W, top - 0.5));
    edges.push(inv(left - 0.5 + f * W, top - 0.5 + H));
    edges.push(inv(left - 0.5, top - 0.5 + f * H));
    edges.push(inv(left - 0.5 + W, top - 0.5 + f * H));
  }
  const lats = edges.map((e) => e.lat);
  const lons = edges.map((e) => e.lon);
  const s = Math.min(...lats), n = Math.max(...lats);
  const w = Math.min(...lons), e = Math.max(...lons);
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const mN = merc(n), mS = merc(s);
  const spanX = ((e - w) * Math.PI) / 180;
  const OW = outWidth;
  const OH = Math.round((OW * (mN - mS)) / spanX);

  // Index-Lookup einmal berechnen, dann pro Frame nur noch nachschlagen.
  const idx = new Int32Array(OW * OH);
  for (let r = 0; r < OH; r++) {
    const my = mN - ((r + 0.5) / OH) * (mN - mS);
    const lat = (Math.atan(Math.sinh(my)) * 180) / Math.PI;
    for (let c = 0; c < OW; c++) {
      const lon = w + ((c + 0.5) / OW) * (e - w);
      const g = toGrid(lat, lon);
      const gx = Math.round(g.col) - left;
      const gy = Math.round(g.row) - top;
      idx[r * OW + c] = gx >= 0 && gy >= 0 && gx < W && gy < H ? gy * W + gx : -1;
    }
  }

  const colors = lut();
  const canvas = document.createElement('canvas');
  canvas.width = OW;
  canvas.height = OH;
  const ctx = canvas.getContext('2d');
  const urls = [];
  for (const f of radar.frames) {
    const img = ctx.createImageData(OW, OH);
    const px = new Uint32Array(img.data.buffer);
    for (let i = 0; i < px.length; i++) {
      const k = idx[i];
      if (k >= 0) {
        const v = f.data[k];
        px[i] = colors[v < 4096 ? v : 4095];
      }
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    urls.push(URL.createObjectURL(blob));
  }
  return { bounds: [[s, w], [n, e]], urls };
}

/** Rasterposition (Spalte, Zeile) → lat/lon (inverse Projektion, iterativ). */
export function invGrid(col, row) {
  const x = col * 1000 - X_0;
  const y = -row * 1000 - Y_0;
  const rho = Math.hypot(x, y);
  const t = (rho * T_C) / (A * M_C);
  const lon = LON_0 + Math.atan2(x, -y);
  let lat = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 8; i++) {
    const es = E * Math.sin(lat);
    lat = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - es) / (1 + es), E / 2));
  }
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}
