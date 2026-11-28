import { OlatError } from './errors.js';
import type { XlsxSheet } from './office.js';

/**
 * Landing pages of the school ("Landing Page …" course nodes) are small web apps hosted outside OLAT.
 * The page embeds `https://<host>/<page>.html?id=<token>/<Klasse_Fach>` and renders the Excel file
 * `https://<host>/data/<token>/<Klasse_Fach>.xlsx` (sheets Lektionen, Verzeichnis, Info).
 *
 * Read-only by construction: only GET, only https, only hosts from the allow-list, and the data URL is built
 * here from the validated `id`, never taken from the page.
 */

export const DEFAULT_EXTERNAL_HOSTS = ['landingpage.bmsw-server.ch'];

const ID_RE = /^[A-Za-z0-9_-]{3,64}(?:\/[A-Za-z0-9_-]{1,80})?$/;
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** Finds the data file of an embedded landing page whose host is allowed. */
export function landingDataUrl(candidates: string[], allowedHosts: string[]): URL | null {
  const allowed = allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || !allowed.includes(url.hostname.toLowerCase())) continue;
    const id = url.searchParams.get('id');
    if (!id || !ID_RE.test(id)) continue;
    return new URL(`/data/${id}.xlsx`, url.origin);
  }
  return null;
}

/** URLs of an opened course node that may be an embedded landing page. */
export function embedCandidates(node: { files: { url: string }[]; links: { url: string }[]; markdown: string }): string[] {
  return [...node.files.map((f) => f.url), ...node.links.map((l) => l.url), ...(node.markdown.match(/https?:\/\/[^\s)\]]+/g) ?? [])];
}

export async function fetchLandingFile(url: URL, allowedHosts: string[]): Promise<Buffer> {
  if (url.protocol !== 'https:' || !allowedHosts.map((h) => h.toLowerCase()).includes(url.hostname.toLowerCase())) {
    throw new OlatError(`Host ${url.hostname} ist für Landing Pages nicht freigegeben (OLAT_EXTERNAL_HOSTS).`, 403);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*;q=0.5' } });
  } catch {
    throw new OlatError('Die Landing Page ist nicht erreichbar.', 502);
  }
  if (!res.ok) throw new OlatError(`Die Landing Page lieferte HTTP ${res.status}.`, 502);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new OlatError('Die Landing-Page-Datei ist zu gross.', 502);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_BYTES) throw new OlatError('Die Landing-Page-Datei ist zu gross.', 502);
  return data;
}

// ---------------------------------------------------------------- mini syntax of the landing page

const COLORS: Record<string, string> = { rot: '[rot]', gelb: '[gelb]', petrol: '[neu]', senf: '[entfällt]', grün: '[grün]', gruen: '[grün]', blau: '[blau]', grau: '[grau]' };
const PLAIN = new Set(['fett', 'kursiv']);
const DATE = /\d{1,2}\.\d{1,2}\.\d{2,4}(?:\s+\d{1,2}:\d{2})?/;

function splitArgs(args: string, legacyComma: boolean): string[] {
  const parts = args.includes(';') || !legacyComma ? args.split(';') : args.split(/,(?=[^,]*$)/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function deadline(label: string, args: string): string {
  const parts = splitArgs(args, true);
  const date = parts.find((p) => DATE.test(p));
  const rest = parts.filter((p) => p !== date);
  const [task, ...place] = rest;
  return `${label}: ${task ?? ''}${date ? ` bis ${date}` : ''}${place.length ? ` (${place.join(', ')})` : ''}`.trim();
}

/**
 * Turns the landing page's mini syntax into plain text, e.g. `rot(fett(Prüfung))` → `Prüfung [rot]`,
 * `Link(Skript; https://…)` → `Skript (https://…)`, `Abgabe(Blatt 3; 05.05.2026; Teams)` → `Abgabe: Blatt 3 bis 05.05.2026 (Teams)`.
 * Colours carry meaning on the page: petrol = new, senf = dropped.
 */
export function cleanMarkup(input: string, shortcuts: Map<string, string> = new Map()): string {
  let text = input.replace(/#[^\s,;()]+/g, (key) => shortcuts.get(key.toLowerCase()) ?? key);
  const fn = /\b([A-Za-zäöüÄÖÜ]+)\(([^()]*)\)/g;
  for (let i = 0; i < 8; i++) {
    const next = text.replace(fn, (whole, rawName: string, args: string) => {
      const name = rawName.toLowerCase();
      if (name === 'link') {
        const [label, url] = splitArgs(args, true);
        return url ? `${label} (${url})` : (label ?? '');
      }
      if (name === 'abgabe') return deadline('Abgabe', args);
      if (name === 'lnw') return deadline('Leistungsnachweis', args);
      if (PLAIN.has(name)) return args;
      if (COLORS[name]) return `${args} ${COLORS[name]}`;
      return whole;
    });
    if (next === text) break;
    text = next;
  }
  return text.replace(/[ \t]+/g, ' ').trim();
}

// ---------------------------------------------------------------- Excel to lessons

export interface LandingLesson {
  date: string;
  time?: string;
  topic?: string;
  material?: string;
  tasks?: string;
  goals?: string;
  extra?: string;
}

export interface LandingPage {
  title?: string;
  teacher?: string;
  schedule?: string;
  infos: string[];
  lessons: LandingLesson[];
  /** Lessons the teacher marked as hidden ("Verbergen"). */
  hidden: number;
  /** Lessons outside the requested period or without any content. */
  omitted: number;
  from: string;
  to?: string;
  truncated: boolean;
}

export function toIsoDate(value: string): string | null {
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(value.trim());
  if (de) return `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return iso ? iso[1] : null;
}

export function todayInZurich(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(now);
}

const FIELD: [keyof Omit<LandingLesson, 'date'>, RegExp][] = [
  ['time', /^zeit/i],
  ['topic', /^thema/i],
  ['material', /material|ablauf/i],
  ['tasks', /^aufgabe/i],
  ['goals', /^lernziel/i],
  ['extra', /^zusatz/i],
];

export function parseLanding(sheets: XlsxSheet[], opts: { from?: string; to?: string; limit?: number } = {}): LandingPage {
  const from = opts.from ?? todayInZurich();
  const limit = opts.limit ?? 40;
  const byName = (name: string) => sheets.find((s) => s.name.toLowerCase() === name);
  const lessonSheet = byName('lektionen') ?? sheets.find((s) => !s.hidden);
  if (!lessonSheet) throw new OlatError('Die Landing-Page-Datei enthält kein Blatt "Lektionen".', 502);

  // Shortcuts (#Kürzel) from the sheet "Verzeichnis": Kürzel | Text | Funktion | Ziel.
  const shortcuts = new Map<string, string>();
  for (const [key, label = '', fn = '', target = ''] of byName('verzeichnis')?.rows.slice(1) ?? []) {
    if (!key?.startsWith('#')) continue;
    const f = fn.trim().toLowerCase();
    shortcuts.set(key.trim().toLowerCase(), f === 'link' ? `Link(${label}; ${target})` : f ? `${f}(${label})` : label);
  }

  const headerAt = lessonSheet.rows.findIndex((r) => r.some((c) => /^datum$/i.test(c.trim())));
  if (headerAt < 0) throw new OlatError('In der Landing-Page-Datei fehlt die Spalte "Datum".', 502);
  const header = lessonSheet.rows[headerAt].map((c) => c.trim());
  const col = (re: RegExp) => header.findIndex((c) => re.test(c));
  const dateCol = col(/^datum$/i);
  const hideCol = col(/^verbergen/i);
  const fieldCols = FIELD.map(([key, re]) => [key, col(re)] as const).filter(([, i]) => i >= 0);

  const lessons: LandingLesson[] = [];
  let hidden = 0;
  let omitted = 0;
  let matched = 0;
  for (const row of lessonSheet.rows.slice(headerAt + 1)) {
    const date = toIsoDate(row[dateCol] ?? '');
    if (!date) continue;
    if (hideCol >= 0 && (row[hideCol] ?? '').trim()) {
      hidden++;
      continue;
    }
    const lesson: LandingLesson = { date };
    let content = false;
    for (const [key, i] of fieldCols) {
      const value = cleanMarkup(row[i] ?? '', shortcuts);
      if (!value) continue;
      lesson[key] = value;
      if (key !== 'time') content = true;
    }
    if (date < from || (opts.to && date > opts.to) || !content) {
      omitted++;
      continue;
    }
    matched++;
    if (lessons.length < limit) lessons.push(lesson);
  }

  const info = new Map<string, string[]>();
  for (const [key, value] of byName('info')?.rows ?? []) {
    if (key && value?.trim()) info.set(key.trim().toLowerCase(), [...(info.get(key.trim().toLowerCase()) ?? []), cleanMarkup(value, shortcuts)]);
  }

  return {
    title: info.get('title')?.[0],
    teacher: info.get('teacher')?.[0],
    schedule: info.get('schedule')?.[0],
    infos: info.get('fixedinfo') ?? [],
    lessons,
    hidden,
    omitted,
    from,
    ...(opts.to ? { to: opts.to } : {}),
    truncated: matched > lessons.length,
  };
}
