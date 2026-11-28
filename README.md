<img src="assets/icon.svg" width="64" height="64" alt="">

# OpenOLAT MCP & API

Read-only REST-API und MCP-Server für [olat.bms-w.ch](https://olat.bms-w.ch) (OpenOLAT 21).
Lernende hinterlegen ihre OpenOLAT-Anmeldedaten; danach können die API bzw. ein KI-Agent über MCP
auf **alle Inhalte zugreifen, die dem Nutzer selbst zur Verfügung stehen** – Kurse, Kursbausteine,
Ordner und Dateien, Mitteilungen, Termine, Leistungsnachweise – **ausschliesslich lesend**.

## Funktionsweise

OpenOLAT bietet Lernenden nur einen Teil der Inhalte über offizielle Schnittstellen an. Der Server
kombiniert daher drei Zugänge, jeweils mit den Rechten des Nutzers:

| Quelle | Wofür | Methoden |
| --- | --- | --- |
| REST-API `/restapi` (Basic Auth) | Profil, Kurse, Gruppen, Kalender, Neuigkeiten, Ordnerliste eines Kurses | nur `GET` |
| Web-Oberfläche (Login-Session) | Kursbaum, Inhalte der Kursbausteine, Ordner-Dateien, beliebige Seiten | `GET` auf Business-Pfade + Allowlist |
| WebDAV `/webdav` (Digest Auth) | Gruppenordner, persönlicher Ordner, Dokumentenpool | nur `PROPFIND`/`GET` |

### Read-only-Garantie

- REST und WebDAV senden ausschliesslich `GET` bzw. `PROPFIND`.
- In der Web-Oberfläche sind nur `GET`-Aufrufe auf Business-Pfade (`/auth/RepositoryEntry/…`), Ressourcen
  (`/m/…`) und statische Dateien erlaubt. Komponenten-URLs (z.B. Logout, Abonnieren) werden vor dem Senden
  blockiert (`assertSafeGet`).
- UI-Events (POST) laufen durch eine enge Allowlist (`assertReadOnlyEvent` in `src/olat/events.ts`): nur
  *Kursbaum aufklappen* und *Herunterladen*. Alles andere wirft `ReadOnlyViolation`.
- Einzige Ausnahmen: das Login-Formular und `olat_get_landing_page` (siehe unten).
- **Landing Pages** (`olat_get_landing_page`): Nur `GET`, nur `https`, nur Hosts aus `OLAT_EXTERNAL_HOSTS` (Standard
  `landingpage.bmsw-server.ch`, leer = abgeschaltet). Die Daten-URL (`/data/<id>.xlsx`) baut der Server selbst aus der
  validierten `id` des OLAT-Embeds, sie kommt nie ungeprüft aus der Seite. Umleitungen und Dateien über 5 MB werden abgelehnt.

> **Hinweis:** Das Öffnen eines Kursbausteins ist für OpenOLAT ein normaler Besuch (wie im Browser) und
> kann in **Lernpfad-Kursen** den Status „besucht/erledigt“ setzen. `olat_get_course_tree` klappt den Baum
> dagegen nur auf und öffnet keine Bausteine.

## Schnellstart

```bash
npm install
npm run build
```

### Variante A – lokal mit Claude Code / Claude Desktop (stdio)

```bash
node dist/cli.js login        # fragt Benutzername + Passwort, speichert verschlüsselt in ~/.openolat-mcp-api
claude mcp add openolat -- node /pfad/zu/dist/cli.js stdio
```

Alternativ ohne `login`: `OLAT_USERNAME` und `OLAT_PASSWORD` als Umgebungsvariablen des MCP-Servers setzen.

### Variante B – Server für mehrere Nutzer (HTTP)

```bash
HOST=0.0.0.0 PORT=3000 PUBLIC_URL=https://openolat-mcp-api.example.ch npm start
# oder
docker build -t openolat-mcp-api . && docker run -p 3000:3000 -v openolat-mcp-api-data:/data openolat-mcp-api
```

1. `https://<server>/` öffnen, Anmeldedaten eingeben → persönliches Token (`olat_…`) wird einmalig angezeigt.
2. MCP-Client verbinden:
   ```bash
   claude mcp add --transport http openolat https://<server>/mcp --header "Authorization: Bearer olat_…"
   ```
3. Oder die REST-API direkt nutzen: `curl -H "Authorization: Bearer olat_…" https://<server>/api/courses`

Der Server sollte nur hinter HTTPS (Reverse Proxy) betrieben werden.

### Variante C – Vercel (öffentliche HTTPS-Adresse)

Der Server läuft auf Vercel als Hono-Funktion (`src/index.ts`, Framework-Preset *Hono*, siehe `vercel.json`). Vercel stellt HTTPS
und die öffentliche Domain bereit – `HOST`/`PORT` sind dort nicht relevant. Da das Dateisystem von Vercel nicht persistent ist,
verwendet der Server dort automatisch den **zustandslosen Token-Store** (`STORE=stateless`, ohne Datenbank und ohne Volume):
das Token enthält die mit `OLAT_MCP_SECRET` (AES-256-GCM) verschlüsselten Anmeldedaten.

```bash
vercel link --project openolat-mcp-api
openssl rand -base64 48 | vercel env add OLAT_MCP_SECRET production --sensitive   # einmalig, nie ins Repository
vercel deploy --prod
```

- **Pflicht:** `OLAT_MCP_SECRET` (mind. 32 Zeichen). Ohne dieses Secret startet die Funktion nicht. Das Secret muss dauerhaft gleich
  bleiben: wird es geändert, werden **alle** ausgegebenen Tokens ungültig (so lassen sich alle Tokens widerrufen).
- Optional: `OLAT_BASE_URL` (Standard `https://olat.bms-w.ch`), `MAX_DOWNLOAD_MB`, `MAX_INLINE_MB`. `PUBLIC_URL` ist nicht nötig.
- Einzelne Tokens lassen sich nicht widerrufen (`DELETE /api/tokens` antwortet mit 501). Bei Verlust eines Tokens: OpenOLAT-Passwort
  ändern oder das Secret erneuern.
- Vercel begrenzt Antworten von Funktionen auf ca. 4,5 MB; sehr grosse Dateien sind darüber nicht abrufbar.
- Deployment Protection muss für Production **aus** sein, sonst erreicht ein MCP-Client `/mcp` nicht (der Zugriff ist durch das Token geschützt).

### Einrichtung in WorkTrack (oder einem anderen MCP-Client mit HTTP-Transport)

1. `https://<öffentlicher-hostname>/` im Browser öffnen, OpenOLAT-Benutzername und -Passwort eingeben → das Token `olat_…` wird
   **einmalig** angezeigt; sofort in WorkTrack bzw. den Passwortmanager kopieren, nicht in Chats oder Tickets einfügen.
   (Ohne Browser: `POST https://<hostname>/api/tokens` mit JSON `{"username":"…","password":"…","label":"WorkTrack"}`.)
2. In WorkTrack eintragen:

   | Feld | Wert |
   | --- | --- |
   | MCP-URL | `https://<öffentlicher-hostname>/mcp` (nicht `localhost`, nicht `olat.bms-w.ch`) |
   | Transport | Streamable HTTP |
   | Header | `Authorization: Bearer olat_…` |

3. Werkzeuge und Eingaben (alle lesend, mit `readOnlyHint`):

   | Zweck | Tool | Eingabe |
   | --- | --- | --- |
   | Termine | `olat_list_calendar_events` | `{"from":"2026-01-01","to":"2026-01-15"}` (ISO-Datum, beide optional; Standard: ab heute, 60 Tage) |
   | Neuigkeiten | `olat_get_notifications` | `{"since":"2026-01-01"}` (ISO-Datum, optional; Standard: letzte 7 Tage) |
   | Kurse | `olat_list_courses` | `{}` |
   | Hausaufgaben-Mitteilungen | `olat_get_info_messages` | `{"courseId":12648576,"nodeId":"114484000378050"}` (Beispiel Mathe; IDs stehen in der OLAT-Adresse `…/RepositoryEntry/<courseId>/CourseNode/<nodeId>`) |
   | Lektionsplan (Landing Page) | `olat_get_landing_page` | `{"courseId":54722567,"nodeId":"114484039180847"}` (Beispiel Deutsch; ab heute) |
   | Eingebettete OLAT-Seite (z.B. Français) | `olat_get_course_node` | `{"courseId":54722678,"nodeId":"114484040726526"}` |

   Für eine Landing Page oder Mitteilungen in WorkTrack: Integration mit dieser MCP-Adresse anlegen, dann pro Seite eine Quelle mit
   dem Werkzeug und den festen Argumenten aus der Tabelle. `olat_open_page` liefert bei eingebetteten Seiten nur den Rahmen,
   dafür `olat_get_course_node` bzw. `olat_get_landing_page` verwenden.

   Die Tools kennen keinen Parameter `tage`; ein Zeitfenster wird über `from`/`to` bzw. `since` angegeben.

   Verbindungstest (listet die Tools):

   ```bash
   curl -X POST https://<hostname>/mcp -H "Authorization: Bearer $OLAT_TOKEN" \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

### Speicherung der Anmeldedaten

Passwörter werden mit AES-256-GCM verschlüsselt. Der Schlüssel wird per HKDF aus **dem Token des Nutzers**
und dem Server-Secret (`OLAT_MCP_SECRET` oder `data/server.key`) abgeleitet. Auf dem Server liegt nur ein
SHA-256-Hash des Tokens – ohne Token lassen sich die Passwörter nicht entschlüsseln. Widerruf:
`DELETE /api/tokens` (mit `?all=true` alle Tokens des Nutzers).

## Chrome-Erweiterung: nie wieder manuell bei OLAT einloggen

Im Ordner [`extension/`](extension/README.md) liegt eine Chrome-Erweiterung (Manifest V3), die sich auf olat.bms-w.ch automatisch
anmeldet, das Sitzungs-Cookie über Browser-Neustarts behält und die Sitzung wachhält. Installation und Sicherheitshinweise:
[extension/README.md](extension/README.md).

## MCP-Tools

| Tool | Beschreibung |
| --- | --- |
| `olat_whoami` | Angemeldeter Benutzer |
| `olat_list_courses` | Eigene Kurse (`my`) oder Favoriten |
| `olat_search_courses` | Suche in allen sichtbaren Kursen |
| `olat_get_course` | Kursinfo inkl. aller Ordner-Bausteine |
| `olat_get_course_tree` | Vollständiger Kursbaum mit Baustein-IDs und -Typen |
| `olat_get_course_node` | Inhalt eines Bausteins als Markdown (Seiten, Mitteilungen, Wiki, Ordner, Links, Dateien) |
| `olat_list_folder` | Dateien/Unterordner eines Ordner-Bausteins (`path` z.B. `Kapitel 1/Übungen`) |
| `olat_read_file` | Datei lesen: PDF, Word, Excel, PowerPoint, HTML, Text → Text; Bilder → Bild; sonst base64 |
| `olat_fetch_resource` | In Seiten verlinkte Ressourcen (`/m/…`) laden |
| `olat_open_page` | Beliebige OpenOLAT-Seite per Business-Pfad, z.B. Leistungsnachweise |
| `olat_list_groups` | Gruppen/Klassen |
| `olat_list_calendar_events` | Termine aus allen Kalendern (Prüfungen etc.) |
| `olat_get_notifications` | Neuigkeiten aus Abonnements; bei Mitteilungen steht der Text unter `message` (z.B. Hausaufgaben) |
| `olat_get_info_messages` | Mitteilungen eines Bausteins «Aufgaben / Mitteilungen» mit Titel, Datum und Text, optional `since` |
| `olat_get_landing_page` | Lektionsplan einer eingebetteten Landing Page (z.B. «Landing Page Deutsch»): kommende Lektionen mit Thema, Material, Aufgaben (Abgabe/LNW), Lernzielen; `from`/`to` optional, Standard ab heute |
| `olat_list_webdav`, `olat_read_webdav_file` | Gruppenordner, persönlicher Ordner, Dokumentenpool |

Alle Tools sind mit `readOnlyHint: true` annotiert.

## REST-API

Alle Endpunkte benötigen `Authorization: Bearer <token>`.

| Methode & Pfad | Beschreibung |
| --- | --- |
| `POST /api/tokens` `{username, password, label?}` | Anmeldedaten hinterlegen → Token (ohne Auth, rate-limitiert) |
| `GET /api/tokens` / `DELETE /api/tokens[?all=true]` | Eigene Tokens anzeigen / widerrufen |
| `GET /api/me` | Profil |
| `GET /api/courses[?scope=favorites]` | Kurse |
| `GET /api/courses/search?q=` | Kurssuche |
| `GET /api/courses/{id}` | Kursinfo |
| `GET /api/courses/{id}/tree` | Kursbaum |
| `GET /api/courses/{id}/nodes/{nodeId}` | Baustein-Inhalt |
| `GET /api/courses/{id}/nodes/{nodeId}/folder?path=` | Ordnerinhalt |
| `GET /api/courses/{id}/nodes/{nodeId}/file?path=&index=&format=json` | Datei (roh oder extrahiert als JSON) |
| `GET /api/resource?url=` | Verlinkte Ressource |
| `GET /api/page?path=` | Beliebige Seite als Markdown |
| `GET /api/groups`, `/api/calendars`, `/api/calendar/events?from=&to=`, `/api/notifications?since=` | REST-Daten |
| `GET /api/webdav?path=`, `/api/webdav/file?path=` | WebDAV |
| `ALL /mcp` | MCP (Streamable HTTP, zustandslos) |

## Entwicklung

```bash
cp .env.example .env    # OLAT_USERNAME/OLAT_PASSWORD eintragen
npm test                # Unit-Tests (Parser, Read-only-Guards, Credential-Store)
npm run smoke           # Live-Test gegen olat.bms-w.ch mit den Daten aus .env
npm run dev             # HTTP-Server mit tsx
```

Struktur:

```
src/olat/web.ts        Web-Session: Login, Redirects, Read-only-Guards, Downloads
src/olat/events.ts     Parser + Allowlist für OpenOLAT-UI-Events
src/olat/parse.ts      Kursbaum, Bausteininhalt, Ordnertabellen
src/olat/client.ts     High-level Client (REST + Web + WebDAV)
src/mcp/server.ts      MCP-Tools
src/http/app.ts        REST-API, /mcp, Token-Verwaltung
src/store/credentials.ts  Verschlüsselter Credential-Store (Datei)
src/store/stateless.ts    Zustandsloser Token-Store (Vercel)
src/index.ts           Einstiegspunkt für Vercel
```

Da Teile auf der HTML-Struktur von OpenOLAT basieren, können Updates der Plattform Anpassungen an
`src/olat/parse.ts` erfordern – `npm run smoke` zeigt solche Brüche schnell.
