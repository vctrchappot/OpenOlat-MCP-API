import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { CourseNodeView, CourseTreeNode, FolderView, OlatClient, ReadFileResult } from '../olat/client.js';
import { OlatError } from '../olat/errors.js';
import { fetchByUrl, type FetchResult } from '../olat/fetch-url.js';

export const SERVER_NAME = 'openolat';
export const SERVER_VERSION = '1.0.0';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const courseId = z.coerce.number().int().positive().describe('Kurs-ID (RepositoryEntry-ID aus olat_list_courses bzw. der URL /RepositoryEntry/{id})');
const nodeId = z.string().regex(/^\d+$/).describe('Kursbaustein-ID (aus olat_get_course_tree)');

function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

async function safe(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof OlatError ? e.message : `Fehler: ${(e as Error).message}`;
    return { isError: true, content: [{ type: 'text', text: msg }] };
  }
}

export function renderTree(nodes: CourseTreeNode[], depth = 0): string {
  return nodes
    .map((n) => {
      const meta = [n.type, n.status].filter(Boolean).join(', ');
      const line = `${'  '.repeat(depth)}- ${n.title} [${n.id}]${meta ? ` (${meta})` : ''}`;
      return n.children.length ? `${line}\n${renderTree(n.children, depth + 1)}` : line;
    })
    .join('\n');
}

export function fileResult(r: ReadFileResult): CallToolResult {
  const head = `Datei: ${r.file.filename} (${r.file.contentType}, ${r.file.size} Bytes${r.file.truncated ? ', gekürzt' : ''})`;
  const c = r.content;
  if (c.kind === 'text') return text(`${head}${c.pages ? `, ${c.pages} Seiten` : ''}\n\n${c.text}`);
  if (c.kind === 'image') return { content: [{ type: 'text', text: head }, { type: 'image', data: c.base64, mimeType: c.mimeType }] };
  const out: CallToolResult = { content: [{ type: 'text', text: `${head}\n${c.note}` }] };
  if (c.base64) {
    out.content.push({ type: 'resource', resource: { uri: `olat-file:///${encodeURIComponent(r.file.filename)}`, mimeType: c.mimeType, blob: c.base64 } });
  }
  return out;
}

export function renderNode(v: CourseNodeView): string {
  const parts = [`# ${v.title}`, `Typ: ${v.type || 'unbekannt'} · ${v.url}`];
  if (!v.opened) parts.push('⚠️ OpenOLAT hat einen anderen Baustein angezeigt – evtl. kein Zugriff oder (noch) gesperrt.');
  if (v.markdown) parts.push(v.markdown);
  if (!v.files.length && v.downloadable) parts.push('Dieser Baustein stellt eine Datei zum Download bereit → olat_read_file(courseId, nodeId).');
  if (v.files.length) parts.push(`## Dateien (olat_read_file mit fileIndex)\n${v.files.map((f, i) => `${i}. ${f.name}`).join('\n')}`);
  if (v.folder) parts.push(`## Ordnerinhalt\n${renderFolder(v.folder)}`);
  if (v.children.length) parts.push(`## Unterbausteine\n${v.children.map((c) => `- ${c.title} [${c.id}]${c.type ? ` (${c.type})` : ''}`).join('\n')}`);
  return parts.join('\n\n');
}

function renderFolder(f: FolderView): string {
  return `${f.entries.map((e) => `- ${e.kind === 'folder' ? '📁' : '📄'} ${e.name}${e.size ? ` (${e.size})` : ''}`).join('\n')}${f.truncated ? '\n… (weitere Einträge, siehe olat_list_folder)' : ''}`;
}

/** Turns the result of `fetchByUrl` into tool output; the first line names the action that was chosen. */
export function renderFetch(r: FetchResult): CallToolResult {
  const head = (action: string, note = '') => `Aktion: ${action}${note ? ` – ${note}` : ''}`;
  switch (r.action) {
    case 'info_messages':
      return text(`${head('info_messages', `${r.messages.length} Mitteilung(en), neueste zuerst`)}\n# ${r.title}\n${r.url}\n\n${JSON.stringify(r.messages, null, 2)}`);
    case 'landing_page':
      return text(`${head('landing_page', `${r.page.lessons.length} Lektion(en) ab ${r.page.from}`)}\n${JSON.stringify(r.page, null, 2)}`);
    case 'folder':
      return text(`${head('folder')}\n# ${r.title}\n${r.url}\n\n${renderFolder(r.folder)}`);
    case 'calendar':
      return text(`${head('calendar', `${r.events.length} Termin(e)`)}\n# ${r.title}\n${r.url}\n\n${JSON.stringify(r.events, null, 2)}`);
    case 'course':
      return text(`${head('course')}\n${JSON.stringify(r.course, null, 2)}\n\n## Struktur\n${renderTree(r.tree)}`);
    case 'node':
      return text(`${head('node')}\n${renderNode(r.node)}`);
    case 'page': {
      const files = r.page.files.length ? `\n\n## Dateien (olat_fetch_resource)\n${r.page.files.map((f) => `- ${f.name}: ${f.url}`).join('\n')}` : '';
      return text(`${head('page')}\n# ${r.page.title}\n${r.page.url}\n\n${r.page.markdown}${files}`);
    }
    case 'file': {
      const out = fileResult(r.file);
      out.content.unshift({ type: 'text', text: head('file') });
      return out;
    }
  }
}

/** Creates an MCP server whose tools all read from OpenOLAT through the given client. */
export function createMcpServer(getClient: () => OlatClient | Promise<OlatClient>): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'Read-only Zugriff auf OpenOLAT der BMS Winterthur (olat.bms-w.ch) mit den Rechten des angemeldeten Lernenden.',
        'Hast du schon eine OLAT-URL (Browser, Mitteilung, Landing Page)? Dann olat_fetch(url): es wählt die passende lesende Aktion selbst und nennt sie in der ersten Zeile.',
        'Typischer Ablauf: olat_list_courses → olat_get_course_tree(courseId) → olat_get_course_node(courseId, nodeId) → olat_read_file / olat_list_folder.',
        'Für Termine olat_list_calendar_events, für Neuigkeiten olat_get_notifications (mit Text der Mitteilungen). Für Lektionspläne einer "Landing Page" olat_get_landing_page, für Hausaufgaben-Mitteilungen eines Bausteins olat_get_info_messages. Alle Tools sind lesend; es werden keine Daten verändert.',
        'Hinweis: Das Öffnen eines Kursbausteins zählt in OpenOLAT als Besuch (wie im Browser) und kann in Lernpfad-Kursen den Fortschritt "besucht" setzen. olat_get_course_tree öffnet keine Bausteine.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'olat_whoami',
    { title: 'Angemeldeter Benutzer', description: 'Zeigt, mit welchem OpenOLAT-Konto der Server verbunden ist.', inputSchema: {}, annotations: READ_ONLY },
    () => safe(async () => json(await (await getClient()).whoami())),
  );

  server.registerTool(
    'olat_list_courses',
    {
      title: 'Kurse auflisten',
      description: 'Listet die Kurse, in denen der Benutzer Mitglied ist (scope "my") oder die als Favorit markiert sind ("favorites"). Die "id" wird von den Kurs-Tools verwendet.',
      inputSchema: { scope: z.enum(['my', 'favorites']).default('my') },
      annotations: READ_ONLY,
    },
    ({ scope }) =>
      safe(async () => {
        const c = await getClient();
        return json(scope === 'favorites' ? await c.listFavoriteCourses() : await c.listMyCourses());
      }),
  );

  server.registerTool(
    'olat_search_courses',
    {
      title: 'Kurse suchen',
      description: 'Sucht in allen für den Benutzer sichtbaren Kursen (auch öffentlich freigegebene) nach Titel, Beschreibung, Autor.',
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(100).default(25) },
      annotations: READ_ONLY,
    },
    ({ query, limit }) => safe(async () => json(await (await getClient()).searchCourses(query, limit))),
  );

  server.registerTool(
    'olat_get_course',
    {
      title: 'Kursinfo',
      description: 'Metadaten eines Kurses inkl. Liste aller Ordner-Bausteine.',
      inputSchema: { courseId },
      annotations: READ_ONLY,
    },
    ({ courseId }) => safe(async () => json(await (await getClient()).getCourseInfo(courseId))),
  );

  server.registerTool(
    'olat_get_course_tree',
    {
      title: 'Kursstruktur',
      description: 'Vollständiger Kursbaum (Kapitel und Bausteine) mit IDs und Typen (page, folder, forum, test, …). Öffnet keine Bausteine.',
      inputSchema: { courseId, refresh: z.boolean().default(false).describe('Cache (10 min) ignorieren') },
      annotations: READ_ONLY,
    },
    ({ courseId, refresh }) =>
      safe(async () => {
        const tree = await (await getClient()).getCourseTree(courseId, { refresh });
        return text(`Kursbaum ${courseId} – Format: Titel [nodeId] (Typ, Status)\n\n${renderTree(tree)}`);
      }),
  );

  server.registerTool(
    'olat_get_course_node',
    {
      title: 'Kursbaustein lesen',
      description:
        'Öffnet einen Kursbaustein und liefert seinen Inhalt als Markdown: Texte, eingebettete HTML-Seiten, Links, angezeigte Dateien (lesbar mit olat_read_file) und bei Ordnern die Dateiliste.',
      inputSchema: { courseId, nodeId },
      annotations: READ_ONLY,
    },
    ({ courseId, nodeId }) =>
      safe(async () => text(renderNode(await (await getClient()).getCourseNode(courseId, nodeId)))),
  );

  server.registerTool(
    'olat_fetch',
    {
      title: 'OLAT-URL lesen (automatisch)',
      description:
        'Nimmt eine OLAT-URL (z.B. aus dem Browser, einer Mitteilung oder einer Landing Page) und führt die passende lesende Aktion aus: ' +
        'Baustein "Aufgaben / Mitteilungen" → Mitteilungen mit Text; Baustein mit eingebetteter Landing Page → Lektionsplan; Ordner → Dateiliste (mit path: Unterordner oder Datei); ' +
        'Dokument/Datei → Inhalt als Text; Kalender-Baustein → Termine; Seite → Markdown; Kurs-URL → Kursinfo und Struktur; /m/…-Ressource oder WebDAV → Datei. ' +
        'Auch die URL einer freigegebenen Landing Page selbst funktioniert. Die erste Zeile der Antwort nennt die gewählte Aktion. Optionale Argumente: from/to (Lektionen, Termine), since (Mitteilungen), path/fileIndex (Ordner, Dateien).',
      inputSchema: {
        url: z.string().min(1).optional().describe('OLAT-URL oder -Pfad, z.B. https://olat.bms-w.ch/auth/RepositoryEntry/123/CourseNode/456'),
        urls: z.array(z.string().min(1)).max(5).optional().describe('Mehrere URLs auf einmal (höchstens 5); die Ergebnisse stehen nacheinander'),
        from: z.string().optional().describe('ISO-Datum; Beginn für Lektionen und Termine (Standard heute)'),
        to: z.string().optional().describe('ISO-Datum; Ende für Lektionen und Termine'),
        since: z.string().optional().describe('ISO-Datum; nur Mitteilungen ab diesem Tag'),
        path: z.string().optional().describe('Unterordner oder Datei in einem Ordner-Baustein, z.B. "Kapitel 1/Übungen.pdf"'),
        fileIndex: z.coerce.number().int().min(0).optional().describe('Nummer der Datei, wenn ein Baustein mehrere zeigt'),
      },
      annotations: READ_ONLY,
    },
    ({ url, urls, ...opts }) =>
      safe(async () => {
        const list = [...(url ? [url] : []), ...(urls ?? [])];
        if (!list.length) return { isError: true, content: [{ type: 'text', text: 'Bitte url oder urls angeben.' }] };
        const client = await getClient();
        const out: CallToolResult = { content: [] };
        for (const [i, u] of list.entries()) {
          if (list.length > 1) out.content.push({ type: 'text', text: `${i ? '\n' : ''}======== ${i + 1}/${list.length}: ${u.replace(/\?.*$/, '')} ========` });
          try {
            out.content.push(...renderFetch(await fetchByUrl(client, u, opts)).content);
          } catch (e) {
            if (list.length === 1) throw e;
            out.content.push({ type: 'text', text: `Fehler: ${e instanceof OlatError ? e.message : (e as Error).message}` });
          }
        }
        return out;
      }),
  );

  server.registerTool(
    'olat_list_folder',
    {
      title: 'Ordner auflisten',
      description: 'Listet Dateien und Unterordner eines Ordner-Bausteins. "path" ist relativ zum Ordner-Baustein, z.B. "Kapitel 1/Übungen".',
      inputSchema: { courseId, nodeId, path: z.string().default('') },
      annotations: READ_ONLY,
    },
    ({ courseId, nodeId, path }) => safe(async () => json(await (await getClient()).listFolder(courseId, nodeId, path))),
  );

  server.registerTool(
    'olat_read_file',
    {
      title: 'Datei lesen',
      description:
        'Lädt eine Datei und gibt den Inhalt zurück (PDF/HTML/Text als Text, Bilder als Bild, sonst base64). Mit "path" aus einem Ordner-Baustein (Unterordner werden als ZIP geliefert), ohne "path" die im Baustein angezeigte Datei (fileIndex aus olat_get_course_node).',
      inputSchema: { courseId, nodeId, path: z.string().optional(), fileIndex: z.number().int().min(0).default(0) },
      annotations: READ_ONLY,
    },
    ({ courseId, nodeId, path, fileIndex }) => safe(async () => fileResult(await (await getClient()).readFile(courseId, nodeId, path, fileIndex))),
  );

  server.registerTool(
    'olat_fetch_resource',
    {
      title: 'Verlinkte Ressource laden',
      description: 'Lädt eine OpenOLAT-Ressourcen-URL (Pfad /m/…), die in einem Seiteninhalt verlinkt ist. Diese URLs sind nur kurz gültig – bei Fehlern den Baustein erneut öffnen.',
      inputSchema: { url: z.string().describe('URL wie https://olat.bms-w.ch/m/…/datei.pdf') },
      annotations: READ_ONLY,
    },
    ({ url }) => safe(async () => fileResult(await (await getClient()).fetchResource(url))),
  );

  server.registerTool(
    'olat_open_page',
    {
      title: 'Beliebige OpenOLAT-Seite lesen',
      description:
        'Öffnet eine OpenOLAT-Seite per Business-Pfad oder URL und liefert sie als Markdown, z.B. "/url/HomeSite/{userKey}/effstatements/0" (Leistungsnachweise), Links aus Benachrichtigungen oder "/url/RepositoryEntry/{id}/Infos/0".',
      inputSchema: { path: z.string().min(1) },
      annotations: READ_ONLY,
    },
    ({ path }) =>
      safe(async () => {
        const p = await (await getClient()).openPage(path);
        const files = p.files.length ? `\n\n## Dateien (olat_fetch_resource)\n${p.files.map((f) => `- ${f.name}: ${f.url}`).join('\n')}` : '';
        return text(`# ${p.title}\n${p.url}\n\n${p.markdown}${files}`);
      }),
  );

  server.registerTool(
    'olat_get_info_messages',
    {
      title: 'Mitteilungen eines Kursbausteins',
      description:
        'Liest die Mitteilungen eines Bausteins "Aufgaben / Mitteilungen" (info-messages) mit Titel, Datum und Text, neueste zuerst, z.B. Hausaufgaben. Optional nur ab einem Datum.',
      inputSchema: { courseId, nodeId, since: z.string().optional().describe('ISO-Datum; nur Mitteilungen, die an oder nach diesem Tag veröffentlicht oder geändert wurden') },
      annotations: READ_ONLY,
    },
    ({ courseId: c, nodeId: n, since }) =>
      safe(async () => {
        const all = await (await getClient()).getInfoMessages(c, n);
        return json(since ? all.filter((m) => (m.edited ?? m.published ?? '9999') >= since.slice(0, 10)) : all);
      }),
  );

  server.registerTool(
    'olat_get_landing_page',
    {
      title: 'Landing Page (Lektionsplan)',
      description:
        'Liest die Landing Page eines Kursbausteins (z.B. "Landing Page Deutsch"), die eine Lektionsübersicht der Lehrperson von einem freigegebenen externen Host einbettet: kommende Lektionen mit Thema, Material, Aufgaben (inkl. Abgabe/LNW) und Lernzielen. Standard: ab heute. Farben stehen als [rot]/[neu]/[entfällt] hinter dem Text.',
      inputSchema: {
        courseId,
        nodeId,
        from: z.string().optional().describe('ISO-Datum, Standard heute'),
        to: z.string().optional().describe('ISO-Datum, Standard: keine Obergrenze'),
      },
      annotations: READ_ONLY,
    },
    ({ courseId: c, nodeId: n, from, to }) =>
      safe(async () => json(await (await getClient()).getLandingPage(c, n, { from: from?.slice(0, 10), to: to?.slice(0, 10) }))),
  );

  server.registerTool(
    'olat_list_groups',
    { title: 'Gruppen', description: 'Gruppen (Klassen, Lerngruppen), in denen der Benutzer Mitglied ist.', inputSchema: {}, annotations: READ_ONLY },
    () => safe(async () => json(await (await getClient()).listGroups())),
  );

  server.registerTool(
    'olat_list_calendar_events',
    {
      title: 'Kalendertermine',
      description: 'Termine aus allen Kalendern des Benutzers (persönlich, Kurse, Gruppen), z.B. Prüfungen. Standard: ab heute 60 Tage.',
      inputSchema: {
        from: z.string().optional().describe('ISO-Datum, Standard heute'),
        to: z.string().optional().describe('ISO-Datum, Standard from + 60 Tage'),
        calendarId: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    ({ from, to, calendarId }) =>
      safe(async () => {
        const f = from ? new Date(from) : new Date(new Date().toDateString());
        const t = to ? new Date(to) : new Date(f.getTime() + 60 * 86_400_000);
        const events = await (await getClient()).listEvents(f, t, calendarId);
        return json(
          events.map((e) => ({
            subject: e.subject,
            calendar: e.calendar,
            begin: new Date(e.begin).toISOString(),
            end: new Date(e.end).toISOString(),
            allDay: e.allDayEvent,
            location: e.location || undefined,
            description: e.description || undefined,
            links: e.links?.map((l) => ({ name: l.displayName, url: l.uri })),
          })),
        );
      }),
  );

  server.registerTool(
    'olat_get_notifications',
    {
      title: 'Neuigkeiten',
      description:
        'Neuigkeiten aus Abonnements (Mitteilungen, neue Dateien, Forenbeiträge …) seit einem Datum (Standard: letzte 7 Tage). Bei Mitteilungen steht der Text unter "message" (z.B. Hausaufgaben).',
      inputSchema: { since: z.string().optional().describe('ISO-Datum') },
      annotations: READ_ONLY,
    },
    ({ since }) =>
      safe(async () => {
        const d = since ? new Date(since) : new Date(Date.now() - 7 * 86_400_000);
        const n = await (await getClient()).notificationsWithMessages(d);
        return json(
          n.map((s) => ({
            type: s.type,
            title: s.title,
            items: s.items.map((i) => ({ date: new Date(i.date).toISOString(), text: i.description, link: i.link, ...(i.message ? { message: { title: i.message.title, publishedBy: i.message.publishedBy, published: i.message.published, edited: i.message.edited, text: i.message.text.slice(0, 2000) } } : {}) })),
          })),
        );
      }),
  );

  server.registerTool(
    'olat_list_webdav',
    {
      title: 'WebDAV-Ordner auflisten',
      description: 'Listet Dateien über WebDAV: "" (Wurzel), "groupfolders/…" (Gruppenordner), "home/private", "home/public", "sharedfolders", "doc-pool".',
      inputSchema: { path: z.string().default('') },
      annotations: READ_ONLY,
    },
    ({ path }) => safe(async () => json(await (await getClient()).listWebDav(path))),
  );

  server.registerTool(
    'olat_read_webdav_file',
    {
      title: 'WebDAV-Datei lesen',
      description: 'Liest eine Datei über WebDAV (Pfad aus olat_list_webdav).',
      inputSchema: { path: z.string().min(1) },
      annotations: READ_ONLY,
    },
    ({ path }) => safe(async () => fileResult(await (await getClient()).readWebDavFile(path))),
  );

  return server;
}
