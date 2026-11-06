// Sprüche für das gelbe Etikett auf dem Jetzt-Bildschirm.
// Ausgewählt nach Wetterlage (inkl. Intensität), Tageszeit und – wo sinnvoll – Temperatur.
//
// Tageszeiten (Ortszeit des Geräts):
//   morgen  05–10 Uhr · tag  10–17 Uhr · abend  17–22 Uhr · nacht  22–05 Uhr
// Felder je Spruch:  t = Text · z = erlaubte Tageszeiten (fehlt = immer) · minT = nur ab dieser Temperatur (°C)

const M = ['morgen'];
const T = ['tag'];
const A = ['abend'];
const N = ['nacht'];
const MT = ['morgen', 'tag'];
const TA = ['tag', 'abend'];
const AN = ['abend', 'nacht'];
const MTA = ['morgen', 'tag', 'abend'];

export const SPRUECHE = {
  // --- Trocken (nächste 2 Std) ----------------------------------------------
  dry: [
    { t: 'Schirm bleibt zu.' },
    { t: 'Trockener wird’s nicht.' },
    { t: 'Petrus macht Pause.' },
    { t: 'Raus mit dir.', z: MTA },
    { t: 'Wäsche kann raus.', z: MT, minT: 5 },
    { t: 'Heute mal mit dem Rad.', z: M },
    { t: 'Trockenen Fußes ins Büro.', z: M },
    { t: 'Kaffee auf dem Balkon.', z: M, minT: 12 },
    { t: 'Mittagspause an der frischen Luft.', z: T },
    { t: 'Runde um den Block? Nur zu.', z: TA },
    { t: 'Auto waschen lohnt sich.', z: T },
    { t: 'Feierabend-Spaziergang.', z: A },
    { t: 'Grill an.', z: A, minT: 15 },
    { t: 'Feierabendbier draußen.', z: A, minT: 15 },
    { t: 'Gassi ohne Handtuch danach.', z: AN },
    { t: 'Trocken nach Hause.', z: AN },
    { t: 'Fenster kann offen bleiben.', z: N },
    { t: 'Schlaf gut – es bleibt trocken.', z: N },
  ],

  // --- Regen kommt in ≤ 10 Min ------------------------------------------------
  comingSoon: [
    { t: 'Beeil dich.' },
    { t: 'Jetzt oder nie.' },
    { t: 'Lauf, Forrest.', z: MTA },
    { t: 'Fenster zu!' },
    { t: 'Countdown läuft.' },
    { t: 'Rad stehen lassen.', z: M },
    { t: 'Sprint zur Haltestelle.', z: MT },
    { t: 'Wäsche rein – sofort!', z: MTA },
    { t: 'Kaffee lieber drinnen.', z: MT },
    { t: 'Gartenstühle rein.', z: TA },
    { t: 'Grillgut retten!', z: A, minT: 12 },
    { t: 'Hund schnell raus – oder gar nicht.', z: AN },
    { t: 'Taxi statt Fußweg.', z: N },
    { t: 'Dachfenster checken.', z: N },
  ],

  // --- Regen kommt in > 10 Min ------------------------------------------------
  comingLater: [
    { t: 'Kein Stress. Noch.' },
    { t: 'Schirm schon mal einpacken.', z: MTA },
    { t: 'Noch Zeit für einen Kaffee.', z: MT },
    { t: 'Brötchen holen geht noch.', z: M },
    { t: 'Erst Kaffee, dann Schirm.', z: M },
    { t: 'Mittagspause jetzt – nicht später.', z: T },
    { t: 'Einkauf jetzt erledigen.', z: TA },
    { t: 'Wäsche reinholen nicht vergessen.', z: TA },
    { t: 'Gassi jetzt, nicht später.', z: A },
    { t: 'Heimweg lieber jetzt antreten.', z: AN },
    { t: 'Fenster vor dem Schlafen zu.', z: N },
    { t: 'Trocken ins Bett – geht noch.', z: N },
  ],

  // --- Starker/heftiger Regen im Anmarsch ------------------------------------
  heavyComing: [
    { t: 'Drinnen bleiben. Ernsthaft.' },
    { t: 'Schirm reicht nicht.' },
    { t: 'Auto unter Bäumen? Umparken.' },
    { t: 'Kellerfenster zu.' },
    { t: 'Termine draußen verschieben.', z: MT },
    { t: 'Heute Homeoffice?', z: M },
    { t: 'Balkon abräumen.', z: TA },
    { t: 'Ab nach Hause – jetzt.', z: AN },
  ],

  // --- Es regnet: leicht ------------------------------------------------------
  light: [
    { t: 'Nur Niesel. Stell dich nicht so an.' },
    { t: 'Kapuze reicht.' },
    { t: 'Frisur in Gefahr.', z: MTA },
    { t: 'Gut für die Haut, sagt man.', z: MT },
    { t: 'Pendler-Niesel. Kapuze auf.', z: M },
    { t: 'Kurz warten, dann geht’s.', z: T },
    { t: 'Gemütlicher Abend drinnen.', z: A },
    { t: 'Leises Prasseln zum Einschlafen.', z: N },
  ],

  // --- Es regnet: mäßig -------------------------------------------------------
  moderate: [
    { t: 'Kapuze auf.' },
    { t: 'Schirm raus.' },
    { t: 'Das wird nass.' },
    { t: 'Gummistiefel-Wetter.', z: MTA },
    { t: 'Bahn statt Rad.', z: M },
    { t: 'Ersatzsocken fürs Büro.', z: M },
    { t: 'Mittagessen am Schreibtisch.', z: T },
    { t: 'Museumswetter.', z: T },
    { t: 'Lieferdienst statt Ausgehen.', z: A },
    { t: 'Film an, Licht aus.', z: AN },
    { t: 'Tee und Decke.', z: AN },
  ],

  // --- Es regnet: stark / heftig ----------------------------------------------
  heavy: [
    { t: 'Drinnen bleiben. Ernsthaft.' },
    { t: 'Schirm reicht nicht.' },
    { t: 'Land unter.' },
    { t: 'Unterführungen meiden.' },
    { t: 'Homeoffice, wenn’s geht.', z: M },
    { t: 'Jetzt bloß nicht losfahren.', z: MTA },
    { t: 'Sofa. Jetzt.', z: AN },
    { t: 'Kellerfenster zu?', z: AN },
    { t: 'Gut, dass du im Bett liegst.', z: N },
  ],
  extreme: [
    { t: 'Ab ins Trockene – sofort.' },
    { t: 'Kein Wetter für draußen.' },
    { t: 'Keller und Dachrinne im Blick behalten.' },
    { t: 'Nicht unter Bäume stellen.' },
    { t: 'Fahrt verschieben.', z: MTA },
  ],

  // --- Dauerregen (kein Ende in Sicht) ----------------------------------------
  long: [
    { t: 'Richtet sich häuslich ein.' },
    { t: 'Couch-Wetter.', z: TA },
    { t: 'Schirm für den ganzen Tag.', z: M },
    { t: 'Heute wird’s ein Indoor-Tag.', z: M },
    { t: 'Hallenbad statt Freibad.', z: T },
    { t: 'Das wird heute nix mehr.', z: TA },
    { t: 'Couch, Decke, Serie.', z: A },
    { t: 'Morgen früh: Schirm nicht vergessen.', z: N },
    { t: 'Regen zum Einschlafen.', z: N },
  ],
};

export function tageszeit(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 10) return 'morgen';
  if (h >= 10 && h < 17) return 'tag';
  if (h >= 17 && h < 22) return 'abend';
  return 'nacht';
}

/**
 * Liefert einen passenden Spruch. Wechselt höchstens stündlich (kein Flackern beim 30-Sek-Refresh).
 * @param {string} kategorie Schlüssel aus SPRUECHE
 * @param {{ date?: Date, temp?: number|null }} ctx
 */
export function spruch(kategorie, { date = new Date(), temp = null } = {}) {
  const liste = SPRUECHE[kategorie] || [];
  const z = tageszeit(date);
  const passt = liste.filter((s) => (!s.z || s.z.includes(z)) && (s.minT == null || (typeof temp === 'number' && temp >= s.minT)));
  const pool = passt.length ? passt : liste.filter((s) => !s.z && s.minT == null);
  if (!pool.length) return '';
  const stunde = Math.floor(date.getTime() / 3.6e6);
  return pool[stunde % pool.length].t;
}
