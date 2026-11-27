<img src="assets/icon.svg" width="64" height="64" alt="">

# BMSW OpenOLAT API & MCP

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
- Einzige Ausnahme: das Login-Formular.

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
node dist/cli.js login        # fragt Benutzername + Passwort, speichert verschlüsselt in ~/.olat-mcp
claude mcp add olat -- node /pfad/zu/dist/cli.js stdio
```

Alternativ ohne `login`: `OLAT_USERNAME` und `OLAT_PASSWORD` als Umgebungsvariablen des MCP-Servers setzen.

### Variante B – Server für mehrere Nutzer (HTTP)

```bash
HOST=0.0.0.0 PORT=3000 PUBLIC_URL=https://olat-mcp.example.ch npm start
# oder
docker build -t bmsw-olat-mcp . && docker run -p 3000:3000 -v olat-mcp-data:/data bmsw-olat-mcp
```

1. `https://<server>/` öffnen, Anmeldedaten eingeben → persönliches Token (`olat_…`) wird einmalig angezeigt.
2. MCP-Client verbinden:
   ```bash
   claude mcp add --transport http olat https://<server>/mcp --header "Authorization: Bearer olat_…"
   ```
3. Oder die REST-API direkt nutzen: `curl -H "Authorization: Bearer olat_…" https://<server>/api/courses`

Der Server sollte nur hinter HTTPS (Reverse Proxy) betrieben werden.

### Speicherung der Anmeldedaten

Passwörter werden mit AES-256-GCM verschlüsselt. Der Schlüssel wird per HKDF aus **dem Token des Nutzers**
und dem Server-Secret (`OLAT_MCP_SECRET` oder `data/server.key`) abgeleitet. Auf dem Server liegt nur ein
SHA-256-Hash des Tokens – ohne Token lassen sich die Passwörter nicht entschlüsseln. Widerruf:
`DELETE /api/tokens` (mit `?all=true` alle Tokens des Nutzers).

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
| `olat_get_notifications` | Neuigkeiten aus Abonnements |
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
src/store/credentials.ts  Verschlüsselter Credential-Store
```

Da Teile auf der HTML-Struktur von OpenOLAT basieren, können Updates der Plattform Anpassungen an
`src/olat/parse.ts` erfordern – `npm run smoke` zeigt solche Brüche schnell.
