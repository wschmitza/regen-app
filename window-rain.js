// Regen am Fenster: Tropfen auf einer Glasscheibe, die anhaften, zusammenlaufen und abperlen.
// Reines Canvas 2D (kein WebGL), Tropfen-Optik als vorberechnetes Sprite mit Lichtbrechung,
// Randschatten und Glanzpunkt. Dichte und Tropfengröße folgen der Regenintensität (mm/h).
//
// API:  rainWindow.set({ on, mmh })   – ein-/ausblenden, Intensität setzen
//       rainWindow.enable(bool)       – Effekt grundsätzlich an/aus (Einstellung „Fenster“/„Striche“)

const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
const SPRITE = 128;          // Kantenlänge des Tropfen-Sprites
const SPRITE_R = SPRITE * 0.36; // Tropfenradius innerhalb des Sprites (Rest: Schatten/Kante)

let canvas, ctx, micro, mctx, W = 0, H = 0, dpr = 1;
let drops = [];
let sprite = null, spriteScheme = '';
let enabled = true, visible = false, level = 0;
let raf = 0, lastT = 0, spawnAcc = 0, microAcc = 0, hideTimer = 0;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
// Tropfen-Sprite: pro Pixel eine Halbkugel schattieren.
// Ein Wassertropfen wirkt wie eine Linse und stellt die Umgebung auf den Kopf –
// der helle Himmel erscheint daher unten im Tropfen, oben bleibt er dunkel; am Rand
// bricht das Licht weg (dunkler Saum), oben links sitzt der Glanzpunkt.
function buildSprite(scheme) {
  const dark = scheme !== 'light';
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE;
  const g = c.getContext('2d');
  const img = g.createImageData(SPRITE, SPRITE);
  const d = img.data;
  const cx = SPRITE / 2, cy = SPRITE / 2, r = SPRITE_R;
  // Farben (0–255) je Darstellung
  const lightCol = dark ? [196, 216, 255] : [255, 255, 255];
  const rimCol = dark ? [2, 5, 12] : [38, 48, 66];
  const L = norm([-0.45, -0.6, 0.66]); // Lichtrichtung (von oben links)

  for (let y = 0; y < SPRITE; y++) {
    for (let x = 0; x < SPRITE; x++) {
      const dx = (x + 0.5 - cx) / r, dy = (y + 0.5 - cy) / r;
      const dist = Math.hypot(dx, dy);
      let R = 0, G = 0, B = 0, A = 0;
      const over = (col, a) => { // „source-over“ in vormultiplizierten Werten
        if (a <= 0) return;
        R = col[0] * a + R * (1 - a); G = col[1] * a + G * (1 - a); B = col[2] * a + B * (1 - a); A = a + A * (1 - a);
      };

      // Weicher Kontaktschatten leicht unterhalb des Tropfens
      const sd = Math.hypot(dx, dy - 0.12);
      over([0, 0, 0], (dark ? 0.32 : 0.14) * (1 - smooth(0.7, 1.18, sd)));

      if (dist < 1.02) {
        const edge = 1 - smooth(0.96, 1.02, dist); // Kantenglättung
        const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, dist) ** 2));
        // Grundkörper: kaum sichtbar, das Glas dahinter scheint durch
        over(dark ? [120, 150, 205] : [235, 240, 248], (dark ? 0.16 : 0.22) * edge);
        // Dunkler Saum durch Totalreflexion am Rand, oben kräftiger
        const rim = smooth(0.55, 1.0, dist) * (0.75 + 0.25 * clamp(-dy, 0, 1));
        over(rimCol, (dark ? 0.78 : 0.5) * rim * edge);
        // Umgekehrtes Himmelslicht: unten hell, als Sichel zum Rand hin
        const lower = clamp(dy * 0.9 + 0.25, 0, 1);
        const crescent = lower * smooth(0.25, 0.85, dist) * (1 - smooth(0.88, 1.0, dist));
        over(lightCol, (dark ? 0.85 : 0.8) * crescent * edge);
        over(lightCol, (dark ? 0.28 : 0.25) * lower * nz * edge);
        // Glanzpunkt (Phong) plus kleiner, harter Kern
        const n = [dx, dy, nz];
        const spec = Math.max(0, dot(n, L)) ** 38;
        over([255, 255, 255], Math.min(1, spec * 1.4) * edge);
        const hk = Math.hypot(dx + 0.32, dy + 0.42);
        over([255, 255, 255], 0.9 * (1 - smooth(0.04, 0.13, hk)) * edge);
      }

      const i = (y * SPRITE + x) * 4;
      // ImageData ist nicht vormultipliziert
      d[i] = A ? R / A : 0; d[i + 1] = A ? G / A : 0; d[i + 2] = A ? B / A : 0; d[i + 3] = A * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function norm(v) { const l = Math.hypot(...v); return v.map((x) => x / l); }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function ensureSprite() {
  const scheme = document.documentElement.dataset.scheme || 'dark';
  if (scheme === spriteScheme && sprite) return;
  sprite = buildSprite(scheme);
  spriteScheme = scheme;
  mctx?.clearRect(0, 0, micro.width, micro.height); // Kleinst-Tröpfchen mit alter Optik verwerfen
}

// ---------------------------------------------------------------------------
// Einrichtung & Größe
function setup() {
  canvas = document.querySelector('.pane');
  if (!canvas) return false;
  ctx = canvas.getContext('2d');
  micro = document.createElement('canvas');
  mctx = micro.getContext('2d');
  resize();
  let rz;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(resize, 150); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reducedMq.addEventListener?.('change', () => { stop(); start(); });
  return true;
}

function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  for (const c of [canvas, micro]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drops = drops.filter((p) => p.x < W && p.y < H);
  if (visible && reducedMq.matches) renderStatic();
}

// ---------------------------------------------------------------------------
// Intensität → Parameter. 0,1 mm/h ≈ 0, ~50 mm/h ≈ 1 (logarithmisch wie im Diagramm).
const f = () => clamp(Math.log1p(level) / Math.log1p(50), 0.06, 1);
const areaScale = () => (W * H) / (390 * 844); // bezogen auf ein iPhone-Display

function newDrop(x, y, r) {
  return { x, y, r, vy: 0, vx: 0, moving: false, trailAt: y, life: rand(0, 1), shift: rand(-1, 1) };
}

function spawn(dt) {
  const k = f();
  // Größere Tropfen pro Sekunde
  spawnAcc += dt * areaScale() * (1.2 + 26 * k * k + 6 * k);
  while (spawnAcc >= 1) {
    spawnAcc -= 1;
    const r = 2.6 + Math.random() ** 2.6 * (7 + 13 * k);
    drops.push(newDrop(rand(0, W), rand(-10, H * 0.98), r));
  }
  // Feiner Sprühnebel: winzige Tröpfchen, direkt in die Zwischenebene gemalt
  microAcc += dt * areaScale() * (30 + 260 * k);
  while (microAcc >= 1) {
    microAcc -= 1;
    const r = rand(0.6, 1.6 + 1.4 * k);
    drawDrop(mctx, rand(0, W), rand(0, H), r, 1, 1);
  }
  const cap = Math.round((90 + 260 * k) * Math.max(0.6, areaScale()));
  if (drops.length > cap) {
    // zuerst kleine, stillstehende Tropfen entfernen (sie „verdunsten“)
    drops.sort((a, b) => (a.moving - b.moving) || (a.r - b.r));
    drops.splice(0, drops.length - cap);
  }
}

function drawDrop(g, x, y, r, sx = 1, sy = 1) {
  const s = (r / SPRITE_R) * SPRITE;
  g.drawImage(sprite, x - (s * sx) / 2, y - (s * sy) / 2, s * sx, s * sy);
}

// ---------------------------------------------------------------------------
// Physik: Haften – Losreißen – Abperlen mit Spur – Zusammenfließen
function step(dt) {
  const k = f();
  const SLIDE_R = 5.2 - 1.2 * k; // ab diesem Radius kann ein Tropfen ins Rutschen kommen
  const trail = [];
  for (const p of drops) {
    if (!p.moving) {
      if (p.r > SLIDE_R && Math.random() < dt * (0.25 + 0.9 * k) * (p.r / 10)) { p.moving = true; p.vy = 0.4; p.trailAt = p.y; }
      continue;
    }
    // Schwerkraft gegen Haftreibung; kleine Tropfen bleiben eher hängen
    const g = 900 * (p.r / 14) ** 1.4;
    p.vy = clamp(p.vy + g * dt - p.vy * 1.8 * dt, 0, 700);
    // Unregelmäßiges Glas: leichtes Schlingern, gelegentlich kurzes Stocken
    p.life += dt;
    p.vx = Math.sin(p.life * 3 + p.shift * 6) * 0.15 * p.vy * (Math.random() < 0.02 ? 3 : 1);
    if (Math.random() < dt * 0.6 && p.r < SLIDE_R * 1.6) p.vy *= 0.2;
    const ox = p.x, oy = p.y;
    p.y += p.vy * dt;
    p.x += p.vx * dt;
    // Abperlende Tropfen räumen den feinen Beschlag weg (klare Bahn)
    mctx.save();
    mctx.globalCompositeOperation = 'destination-out';
    mctx.lineCap = 'round';
    mctx.lineWidth = p.r * 1.7;
    mctx.beginPath(); mctx.moveTo(ox, oy); mctx.lineTo(p.x, p.y); mctx.stroke();
    mctx.restore();
    // Spur aus kleinen Resttröpfchen
    if (p.y - p.trailAt > p.r * rand(1.4, 3.2)) {
      p.trailAt = p.y;
      const tr = p.r * rand(0.16, 0.32);
      if (tr > 0.9) trail.push(newDrop(p.x + rand(-0.3, 0.3) * p.r, p.y - p.r * 1.1, tr));
      p.r *= 0.985;
      if (p.r < SLIDE_R * 0.7) { p.moving = false; p.vy = 0; }
    }
  }
  drops.push(...trail);

  // Zusammenfließen: bewegte Tropfen schlucken, was sie berühren
  for (const p of drops) {
    if (!p.moving || p.dead) continue;
    for (const q of drops) {
      if (q === p || q.dead) continue;
      const dx = q.x - p.x, dy = q.y - p.y;
      if (Math.abs(dy) > p.r + q.r || Math.abs(dx) > p.r + q.r) continue;
      if (dx * dx + dy * dy < ((p.r + q.r) * 0.7) ** 2) {
        const [big, small] = p.r >= q.r ? [p, q] : [q, p];
        big.r = Math.min(22, Math.sqrt(big.r * big.r + small.r * small.r * 0.85));
        big.moving = true;
        big.vy = Math.max(p.vy, q.vy) * 0.8 + 20;
        small.dead = true;
      }
    }
  }
  drops = drops.filter((p) => !p.dead && p.y - p.r < H + 20);

  // Beschlag „verdunstet“ sehr langsam, damit sich die Scheibe nicht völlig zusetzt
  mctx.save();
  mctx.globalCompositeOperation = 'destination-out';
  mctx.fillStyle = `rgba(0,0,0,${clamp(0.12 * dt, 0, 1)})`;
  mctx.fillRect(0, 0, W, H);
  mctx.restore();
}

function render() {
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(micro, 0, 0, W, H);
  for (const p of drops) {
    // Bewegte Tropfen werden länglich: oben schmaler Kopf, gestreckter Körper
    const st = p.moving ? clamp(p.vy / 500, 0, 0.35) : 0;
    drawDrop(ctx, p.x, p.y, p.r, 1 - st * 0.35, 1 + st);
  }
}

function frame(t) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
  lastT = t;
  ensureSprite();
  spawn(dt);
  step(dt);
  render();
}

// Reduzierte Bewegung: eine stehende Scheibe ohne Animation
function renderStatic() {
  ensureSprite();
  drops = [];
  mctx.clearRect(0, 0, W, H);
  for (let i = 0; i < 40; i++) spawn(0.1);
  drops.forEach((p) => { p.moving = false; });
  render();
}

function start() {
  if (!enabled || !visible || document.hidden || raf) return;
  if (!canvas && !setup()) return;
  ensureSprite();
  if (reducedMq.matches) { renderStatic(); return; }
  lastT = performance.now();
  raf = requestAnimationFrame(frame);
}
function stop() { cancelAnimationFrame(raf); raf = 0; }

export const rainWindow = {
  set({ on, mmh = 0 }) {
    level = Math.max(0, mmh || 0);
    const show = enabled && on;
    if (show === visible) { if (show) start(); return; }
    visible = show;
    if (!canvas && !setup()) return;
    clearTimeout(hideTimer);
    canvas.classList.toggle('on', show);
    if (show) {
      // Scheibe füllt sich schnell, wirkt dann nicht leer beim Einblenden
      ensureSprite();
      for (let i = 0; i < 25; i++) spawn(0.12);
      start();
    } else {
      hideTimer = setTimeout(() => { stop(); drops = []; mctx.clearRect(0, 0, W, H); ctx.clearRect(0, 0, W, H); }, 900);
    }
  },
  enable(v) {
    enabled = v;
    if (!v && visible) this.set({ on: false });
  },
};
