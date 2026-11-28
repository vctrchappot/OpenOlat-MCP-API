# OLAT Auto-Login (Chrome-Erweiterung)

Meldet dich auf [olat.bms-w.ch](https://olat.bms-w.ch) automatisch an und hält die Sitzung am Leben, damit du dich nicht
mehr bei jedem Besuch von Hand einloggen musst.

## Warum musst du dich überhaupt immer wieder anmelden?

- OLAT setzt nur ein **Sitzungs-Cookie** (`JSESSIONID` ohne Ablaufdatum). Chrome verwirft es beim Schliessen des Browsers.
- OLAT beendet die Sitzung nach einer Weile **Inaktivität**.
- Der Login läuft in **zwei Schritten** (erst Benutzername, dann erscheint das Passwortfeld). Die Passwort-Verwaltung von Chrome
  füllt das nicht zuverlässig aus.

## Was die Erweiterung dagegen tut

| Funktion | Wirkung |
| --- | --- |
| **Auto-Login** | Erscheint das OLAT-Login-Formular, trägt die Erweiterung Benutzername und Passwort ein und klickt «Login», beide Schritte. Du landest auf der Seite, die du öffnen wolltest (auch bei Direktlinks auf Kurse). |
| **Sitzung behalten** | Das Sitzungs-Cookie bekommt ein Ablaufdatum (14 Tage), überlebt also einen Browser-Neustart, solange OLAT die Sitzung nicht beendet hat. |
| **Sitzung wachhalten** | Alle 5 Minuten fragt die Erweiterung OLAT an. Das verhindert das Ablaufen wegen Inaktivität, solange Chrome läuft. |

Alle drei lassen sich im Popup einzeln ausschalten.

## Installation

1. In Chrome `chrome://extensions` öffnen.
2. Oben rechts **Entwicklermodus** einschalten.
3. **Entpackte Erweiterung laden** und den Ordner `extension/` dieses Repositorys wählen.
4. Auf das Symbol der Erweiterung klicken, OLAT-Benutzername und Passwort eintragen, **Speichern**.

Ab dem nächsten Öffnen von OLAT wird automatisch angemeldet. Nach einem `git pull` unter `chrome://extensions` auf «Neu laden» klicken.

Voraussetzung: Chrome 120 oder neuer.

## Sicherheit

- Die Zugangsdaten werden mit **AES-GCM** verschlüsselt in `chrome.storage.local` abgelegt. Der Schlüssel ist ein **nicht
  exportierbarer** Schlüssel in IndexedDB. Wer nur Profil-Dateien kopiert, kommt nicht an das Passwort. Gegen Schadcode, der in
  deinem Chrome-Profil läuft, schützt das nicht, so wenig wie die Passwort-Verwaltung von Chrome selbst.
- Die Erweiterung darf **nur** `https://olat.bms-w.ch/*` lesen und ändern. Die Zugangsdaten gibt der Hintergrunddienst nur an das
  Skript auf dieser Domain heraus.
- **Schutz vor Kontosperre:** höchstens 3 Anmeldeversuche pro 10 Minuten. Lehnt OLAT die Daten ab, versucht die Erweiterung es
  **nicht noch einmal**, zeigt am Symbol ein rotes «!» und im Popup die Meldung von OLAT. Erst nach erneutem Speichern oder
  «Auto-Login wieder aktivieren» geht es weiter.
- Das Sitzungs-Cookie liegt wegen «Sitzung behalten» bis zu 14 Tage auf der Festplatte. Auf geteilten Rechnern diese Option
  ausschalten.
- **Abmelden:** Klickst du in OLAT auf «Abmelden», pausiert der Auto-Login 10 Minuten, damit du nicht sofort wieder angemeldet wirst.
  Im Popup lässt er sich mit «Auto-Login wieder aktivieren» früher fortsetzen.

## Grenzen

- Nur Anmeldung mit Benutzername und Passwort. Single Sign-on, Passkeys und Zwei-Faktor-Abfragen werden nicht bedient.
- Die Erweiterung arbeitet nur, solange Chrome läuft. Beendet OLAT die Sitzung serverseitig (Neustart, Zeitlimit), meldet sie dich
  beim nächsten Öffnen der Seite wieder an.
- Ändert OLAT das Login-Formular, müssen die Kennungen in `content.js` angepasst werden. `npm test` prüft sie gegen
  `test/fixtures/olat-login-form.html`.

## Fehlersuche

- **Rotes «!» am Symbol:** OLAT hat die Anmeldung abgelehnt. Das Popup zeigt die Meldung von OLAT. Zugangsdaten prüfen und neu speichern.
- **Es passiert nichts:** Im Popup prüfen, ob Zugangsdaten gespeichert und der Auto-Login eingeschaltet ist, und ob er nach einem «Abmelden» pausiert.
- **Details:** Unter `chrome://extensions` bei der Erweiterung auf «Service Worker» klicken, um die Konsole des Hintergrunddienstes zu sehen.

## Entwicklung

```
extension/manifest.json   Manifest V3
extension/content.js      Läuft auf olat.bms-w.ch: bedient das Login-Formular
extension/background.js   Cookie behalten, Sitzung wachhalten, Zugangsdaten herausgeben
extension/store.js        Verschlüsselter Speicher und Einstellungen
extension/popup.*         Einstellungen und Status
scripts/make-extension-icons.mjs   erzeugt extension/icons/*.png
```

Tests: `npm test` (`test/extension-*.test.ts`, mit jsdom gegen das echte Formular-HTML).
