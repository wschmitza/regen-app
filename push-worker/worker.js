// Rain Radar – Push-Server (Cloudflare Worker, kostenloser Tarif)
//
// Prüft alle 5 Minuten (Cron) für jedes angemeldete iPhone die DWD-Radarvorhersage
// am gespeicherten Ort und schickt eine Web-Push-Nachricht, kurz bevor Regen kommt.
//
// Benötigt im Cloudflare-Dashboard:
//   • KV-Bindung mit dem Variablennamen  SUBS
//   • Cron-Trigger  */5 * * * *
// Die VAPID-Schlüssel erzeugt der Worker beim ersten Aufruf selbst und legt sie in KV ab.
// Keine externen Bibliotheken – alles mit WebCrypto.

const ALLOWED_ORIGINS = ['https://wschmitza.github.io', 'http://localhost:8766'];
const VAPID_SUBJECT = 'https://wschmitza.github.io/regen-app/';
const RAIN_MIN = 0.1; // mm/h
const DEFAULT_LEAD = 15; // Minuten Vorlauf
const RAW_TO_MMH = 0.12; // 0,01 mm / 5 min → mm/h

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    try {
      const { pathname } = new URL(req.url);
      if (req.method === 'GET' && pathname === '/') {
        const list = await env.SUBS.list({ prefix: 'sub:' });
        return json({ ok: true, service: 'rain-radar-push', subscribers: list.keys.length });
      }
      if (req.method === 'GET' && pathname === '/vapid') {
        const v = await getVapid(env);
        return json({ publicKey: v.publicKey });
      }
      if (req.method !== 'POST') return json({ error: 'not found' }, 404);
      const body = await req.json();

      if (pathname === '/subscribe') {
        const sub = body.subscription;
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json({ error: 'subscription fehlt' }, 400);
        if (!/^https:\/\//.test(sub.endpoint)) return json({ error: 'ungültiger endpoint' }, 400);
        const lat = Number(body.lat);
        const lon = Number(body.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'Ort fehlt' }, 400);
        const id = await subId(sub.endpoint);
        const prev = await env.SUBS.get(`sub:${id}`, 'json');
        const rec = {
          subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
          lat: Math.round(lat * 1e4) / 1e4,
          lon: Math.round(lon * 1e4) / 1e4,
          name: String(body.name || '').slice(0, 60),
          lead: Math.min(60, Math.max(5, Number(body.lead) || DEFAULT_LEAD)),
          rainActive: prev?.rainActive ?? false,
          updated: Date.now(),
        };
        await env.SUBS.put(`sub:${id}`, JSON.stringify(rec));
        return json({ ok: true, id });
      }
      if (pathname === '/unsubscribe') {
        if (!body.endpoint) return json({ error: 'endpoint fehlt' }, 400);
        await env.SUBS.delete(`sub:${await subId(body.endpoint)}`);
        return json({ ok: true });
      }
      if (pathname === '/test') {
        const rec = body.endpoint ? await env.SUBS.get(`sub:${await subId(body.endpoint)}`, 'json') : null;
        if (!rec) return json({ error: 'nicht angemeldet' }, 404);
        const res = await sendPush(env, rec.subscription, {
          title: 'Rain Radar ☔',
          body: `Regen-Alarm ist aktiv für ${rec.name || 'deinen Ort'}. Ich melde mich ${rec.lead} Min vorher.`,
          tag: 'rain-test',
        });
        return json({ ok: res.ok, status: res.status, detail: res.ok ? undefined : await res.text() }, res.ok ? 200 : 502);
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkAll(env));
  },
};

// ---------------------------------------------------------------------------
// Regelmäßige Prüfung
export async function checkAll(env, now = Date.now()) {
  const list = await env.SUBS.list({ prefix: 'sub:' });
  const results = [];
  for (const k of list.keys) {
    try {
      results.push(await checkOne(env, k.name, now));
    } catch (e) {
      results.push({ key: k.name, error: String(e?.message || e) });
    }
  }
  return results;
}

async function checkOne(env, key, now) {
  const rec = await env.SUBS.get(key, 'json');
  if (!rec) return { key, skipped: true };
  const min = await forecast(rec.lat, rec.lon, now);
  if (!min.length) return { key, nodata: true };
  const a = analyze(min, rec.lead);

  // Nur bei Wechsel trocken → Regen eine Nachricht schicken; KV-Schreibzugriffe nur bei Zustandswechsel.
  if (a.alert && !rec.rainActive) {
    const res = await sendPush(env, rec.subscription, a.alert);
    if (res.status === 404 || res.status === 410) {
      await env.SUBS.delete(key); // Abo auf dem iPhone beendet
      return { key, removed: true };
    }
    if (res.ok) {
      rec.rainActive = true;
      rec.lastPush = now;
      await env.SUBS.put(key, JSON.stringify(rec));
    }
    return { key, pushed: res.ok, status: res.status, alert: a.alert };
  }
  if (!a.wet && rec.rainActive) {
    rec.rainActive = false;
    await env.SUBS.put(key, JSON.stringify(rec));
    return { key, reset: true };
  }
  return { key, state: a.kind };
}

// ---------------------------------------------------------------------------
// Vorhersage am Punkt (gleiche Logik wie in der App)
async function forecast(lat, lon, now) {
  const p = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    distance: '3000',
    format: 'plain',
    date: new Date(now - 15 * 60e3).toISOString(),
    last_date: new Date(now + 80 * 60e3).toISOString(),
  });
  const r = await fetch(`https://api.brightsky.dev/radar?${p}`, { headers: { 'User-Agent': 'rain-radar-push' } });
  if (!r.ok) throw new Error(`Bright Sky ${r.status}`);
  const j = await r.json();
  const { x, y } = j.latlon_position;
  const points = j.radar
    .map((f) => ({ time: Date.parse(f.timestamp), mmh: sample(f.precipitation_5, x, y) }))
    .sort((a, b) => a.time - b.time);
  return minutes(points, now);
}

function sample(grid, x, y) {
  const cx = Math.round(x);
  const cy = Math.round(y);
  let sum = 0;
  let n = 0;
  let center = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const v = grid[cy + dy]?.[cx + dx];
      if (v == null) continue;
      if (dx === 0 && dy === 0) center = v;
      sum += v;
      n++;
    }
  }
  return Math.max(center, n ? sum / n : 0) * RAW_TO_MMH;
}

function minutes(points, now) {
  const out = [];
  if (points.length < 2) return out;
  const start = Math.floor(now / 60e3) * 60e3;
  const last = points[points.length - 1].time;
  let j = 0;
  for (let t = start; t <= last; t += 60e3) {
    while (j < points.length - 2 && points[j + 1].time < t) j++;
    const a = points[j];
    const b = points[j + 1];
    const mmh = t <= a.time ? a.mmh : t >= b.time ? b.mmh : a.mmh + ((b.mmh - a.mmh) * (t - a.time)) / (b.time - a.time);
    out.push({ t, mmh });
  }
  return out;
}

const ADJ = (v) => (v < 2.5 ? 'Leichter' : v < 10 ? 'Mäßiger' : v < 25 ? 'Starker' : 'Heftiger');
const hhmm = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

export function analyze(min, lead) {
  const wetNow = min[0].mmh >= RAIN_MIN;
  const start = min.findIndex((m) => m.mmh >= RAIN_MIN);
  // „nass“ = es regnet oder Regen kurz bevor. Solange bleibt der Alarm verbraucht (keine Doppel-Nachrichten).
  const wet = start >= 0 && start <= lead + 10;
  if (start < 0) return { kind: 'dry', wet: false };
  let end = min.length;
  for (let i = start + 1; i < min.length; i++) {
    if (min.slice(i, i + 5).every((m) => m.mmh < RAIN_MIN)) { end = i; break; }
  }
  const peak = Math.max(...min.slice(start, end).map((m) => m.mmh));
  const dur = end - start;
  const durTxt = end === min.length ? 'hält länger an' : dur < 60 ? `etwa ${dur} Min lang` : `etwa ${Math.floor(dur / 60)} Std ${dur % 60} Min lang`;
  if (wetNow) {
    return {
      kind: 'raining', wet,
      alert: { title: `${ADJ(min[0].mmh)} Regen – jetzt`, body: end === min.length ? 'Es regnet und hört so bald nicht auf.' : `Es regnet, voraussichtlich bis ${hhmm(min[end].t)}.`, tag: 'rain' },
    };
  }
  if (start <= lead) {
    return {
      kind: 'coming', wet,
      alert: { title: `${ADJ(peak)} Regen in ${start} Min`, body: `Ab ${hhmm(min[start].t)} – ${durTxt}.`, tag: 'rain' },
    };
  }
  return { kind: 'later', wet };
}

// ---------------------------------------------------------------------------
// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID)
const enc = new TextEncoder();
const b64u = {
  encode(buf) {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function subId(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(endpoint));
  return b64u.encode(h).slice(0, 32);
}

async function getVapid(env) {
  const stored = await env.SUBS.get('vapid', 'json');
  if (stored) return stored;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const v = {
    privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
    publicKey: b64u.encode(await crypto.subtle.exportKey('raw', kp.publicKey)),
  };
  await env.SUBS.put('vapid', JSON.stringify(v));
  return v;
}

async function vapidAuth(env, endpoint) {
  const v = await getVapid(env);
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  })));
  const unsigned = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u.encode(sig)}, k=${v.publicKey}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

export async function encryptPayload(subscription, plaintext, { salt, asKeys } = {}) {
  const uaPublic = b64u.decode(subscription.keys.p256dh);
  const authSecret = b64u.decode(subscription.keys.auth);
  const as = asKeys || (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = concat(enc.encode(plaintext), new Uint8Array([2])); // 0x02 = letzter Datensatz
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, data));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // Datensatzgröße 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

async function sendPush(env, subscription, message) {
  const body = await encryptPayload(subscription, JSON.stringify(message));
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(env, subscription.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '900',
      Urgency: 'high',
    },
    body,
  });
}
