# Rain Radar – Regen auf die Minute

Minimalistische Regen-Web-App fürs iPhone (PWA) mit zwei Bildschirmen: **Jetzt** (wann beginnt der Regen, wie lange dauert er) und **Radar**.

## Datenquelle
- **DWD-Radar, RV-Produkt** (1 km Auflösung, 5-Minuten-Takt, Vorhersage bis +2 Std), abgerufen über die freie API von [Bright Sky](https://brightsky.dev/docs/#/operations/getRadar). Ein API-Key ist nicht nötig.
- Prognose für den Standort: Radarwert dort (über 3×3 km geglättet), linear auf Minuten interpoliert. Als Regen gilt alles ab 0,1 mm/h.
- Radarkarte: Die Rasterdaten werden im Browser aus der DWD-Projektion (polarstereographisch) exakt nach Web-Mercator umgerechnet. Alle Bilder werden vor dem Anzeigen vollständig geladen.
- Karte: OpenStreetMap / CARTO · Ortssuche: Open-Meteo · Ortsname: BigDataCloud.
- Abdeckung: Deutschland und Grenzregionen.

## Aufs iPhone bringen
1. Ordner per HTTPS hosten, z. B. mit GitHub Pages (Settings → Pages → Branch wählen). Die App liegt dann unter `https://wschmitza.github.io/regen-app/`.
2. In Safari öffnen → Teilen → „Zum Home-Bildschirm“.
3. Standort erlauben, optional „Regen-Alarm“ antippen.

## Grenzen
- Der **Regen-Alarm** meldet sich nur, solange die App geöffnet ist. Push-Mitteilungen im Hintergrund sind bewusst nicht vorgesehen.
