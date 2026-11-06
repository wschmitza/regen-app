# Push-Server für Regenzeit einrichten (Cloudflare, kostenlos)

Dauer: ca. 15 Minuten. Du brauchst nur den Browser.

## 1. Worker anlegen
1. https://dash.cloudflare.com öffnen und anmelden.
2. Links im Menü **Workers & Pages** (bzw. **Compute → Workers**) → **Create** / **Erstellen**.
3. **Start with Hello World!** wählen.
4. Name: `rain-radar-push` → **Deploy**.

## 2. Code einfügen
1. Im neuen Worker auf **Edit code** / **Code bearbeiten**.
2. Links die Datei `worker.js` öffnen, **alles löschen**.
3. Den kompletten Inhalt von
   https://raw.githubusercontent.com/wschmitza/regen-app/main/push-worker/worker.js
   kopieren und einfügen.
4. Oben rechts **Deploy**.

## 3. Speicher (KV) anlegen
1. Links im Menü **Storage & Databases → KV** (Workers KV).
2. **Create** / **Namespace erstellen**, Name: `rain-radar-subs` → anlegen.

## 4. Speicher mit dem Worker verbinden
1. Zurück zum Worker `rain-radar-push` → Reiter **Bindings** (ggf. unter **Settings**).
2. **Add binding** → **KV namespace**.
3. Variablenname: `SUBS` (genau so, Großbuchstaben) · Namespace: `rain-radar-subs`.
4. Speichern / **Deploy**.

## 5. Zeitplan (alle 5 Minuten)
1. Im Worker → **Settings** → **Trigger Events** (bzw. **Triggers**) → **Add** → **Cron Triggers**.
2. Ausdruck: `*/5 * * * *` (oder „Every 5 minutes“) → hinzufügen.

## 6. Prüfen
1. Im Worker die Adresse kopieren, z. B. `https://rain-radar-push.DEINNAME.workers.dev`.
2. Im Browser öffnen. Erwartet: `{"ok":true,"service":"rain-radar-push","subscribers":0}`.
3. Diese Adresse in `app.js` bei `PUSH_URL` eintragen (oder an Claude schicken).

## 7. Auf dem iPhone
1. Regenzeit komplett schließen und neu öffnen.
2. **Regen-Alarm** antippen → Mitteilungen erlauben.
3. Nach wenigen Sekunden kommt eine Test-Nachricht. Fertig.

## Kosten & Grenzen (kostenloser Tarif)
- 288 Prüfläufe pro Tag, je ein Radar-Abruf pro angemeldetem Gerät – weit unter den Freigrenzen.
- Bis ca. 40 Geräte pro Prüflauf (Cloudflare erlaubt 50 Abrufe je Lauf).
- Gespeichert werden nur Push-Adresse und Ort, in deinem eigenen Cloudflare-Konto.
